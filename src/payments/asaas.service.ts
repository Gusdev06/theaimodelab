import {
  Injectable,
  Logger,
  InternalServerErrorException,
  BadRequestException,
  ServiceUnavailableException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

export type AsaasPixStatus =
  | 'PENDING'
  | 'PAID'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'REFUNDED';

export interface AsaasPixCharge {
  id: string;
  amountCents: number;
  status: AsaasPixStatus;
  brCode: string;
  brCodeBase64: string;
  expiresAt: string;
}

export interface AsaasPaymentStatusResult {
  id: string;
  status: AsaasPixStatus;
  amountCents: number;
  externalReference?: string | null;
}

interface CreatePixInput {
  customerId: string;
  amountCents: number;
  description?: string;
  externalReference: string;
}

interface AsaasCustomer {
  id: string;
  name: string;
  cpfCnpj: string;
  email?: string;
}

interface AsaasPayment {
  id: string;
  status: string;
  value: number;
  customer: string;
  billingType: string;
  externalReference?: string | null;
  dueDate: string;
}

interface AsaasPixQrCode {
  success: boolean;
  encodedImage: string;
  payload: string;
  expirationDate: string;
}

/**
 * Cliente HTTP da API v3 do ASAAS. Suporta cobranças únicas PIX
 * (boost de créditos). Subscriptions seguem no Stripe.
 *
 * ASAAS exige customer com cpfCnpj antes de criar cobrança. O ID do
 * customer é cacheado em User.asaasCustomerId pra reuso.
 */
@Injectable()
export class AsaasService {
  private readonly logger = new Logger(AsaasService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly webhookSecret: string;
  private readonly sandbox: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.apiKey = this.configService.getOrThrow<string>('ASAAS_API_KEY').trim();
    const rawBase = this.configService
      .get<string>('ASAAS_BASE_URL', 'https://api-sandbox.asaas.com')
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/v\d+$/, '');
    this.baseUrl = `${rawBase}/v3`;
    this.sandbox = this.baseUrl.includes('sandbox');
    this.webhookSecret = this.configService
      .get<string>('ASAAS_WEBHOOK_SECRET', '')
      .trim();
  }

  getWebhookSecret(): string {
    return this.webhookSecret;
  }

  isSandbox(): boolean {
    return this.sandbox;
  }

  /**
   * Busca asaasCustomerId do user. Se não existir, cria no ASAAS e salva.
   * cpfCnpj é obrigatório pra criar customer no ASAAS.
   */
  async getOrCreateCustomer(
    userId: string,
    name: string,
    email: string,
    cpfCnpj: string,
  ): Promise<string> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { asaasCustomerId: true, taxId: true },
    });

    // Reusa o customer só se já existe E é o mesmo CPF/CNPJ.
    // Quando o user troca de documento (PF → PJ por exemplo), criamos um
    // novo customer no ASAAS — o anterior fica orfão na conta deles, sem efeito.
    if (user.asaasCustomerId && user.taxId === cpfCnpj) {
      return user.asaasCustomerId;
    }

    const customer = await this.request<AsaasCustomer>('POST', '/customers', {
      name,
      email,
      cpfCnpj,
      externalReference: userId,
      notificationDisabled: true,
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        asaasCustomerId: customer.id,
        taxId: cpfCnpj,
      },
    });

    this.logger.log(`Created ASAAS customer ${customer.id} for user ${userId}`);
    return customer.id;
  }

  /**
   * Cria cobrança PIX única e retorna QR Code + copia-cola.
   * Fluxo ASAAS: POST /payments → GET /payments/{id}/pixQrCode.
   */
  async createPixCharge(input: CreatePixInput): Promise<AsaasPixCharge> {
    const today = new Date().toISOString().slice(0, 10);

    const payment = await this.request<AsaasPayment>('POST', '/payments', {
      customer: input.customerId,
      billingType: 'PIX',
      value: Number((input.amountCents / 100).toFixed(2)),
      dueDate: today,
      description: input.description?.slice(0, 500),
      externalReference: input.externalReference,
    });

    const qr = await this.request<AsaasPixQrCode>(
      'GET',
      `/payments/${encodeURIComponent(payment.id)}/pixQrCode`,
    );

    return {
      id: payment.id,
      amountCents: Math.round(payment.value * 100),
      status: this.mapStatus(payment.status),
      brCode: qr.payload,
      brCodeBase64: `data:image/png;base64,${qr.encodedImage}`,
      expiresAt: this.parseAsaasDateTime(qr.expirationDate),
    };
  }

  /**
   * Consulta o status atual de uma cobrança no ASAAS.
   * Usado pelo polling do frontend e pela revalidação do webhook.
   */
  async checkPaymentStatus(id: string): Promise<AsaasPaymentStatusResult> {
    const payment = await this.request<AsaasPayment>(
      'GET',
      `/payments/${encodeURIComponent(id)}`,
    );

    return {
      id: payment.id,
      status: this.mapStatus(payment.status),
      amountCents: Math.round(payment.value * 100),
      externalReference: payment.externalReference ?? null,
    };
  }

  private mapStatus(asaasStatus: string): AsaasPixStatus {
    switch (asaasStatus) {
      case 'RECEIVED':
      case 'RECEIVED_IN_CASH':
      case 'CONFIRMED':
        return 'PAID';
      case 'PENDING':
      case 'AWAITING_RISK_ANALYSIS':
        return 'PENDING';
      case 'OVERDUE':
        return 'EXPIRED';
      case 'REFUNDED':
      case 'REFUND_REQUESTED':
      case 'REFUND_IN_PROGRESS':
        return 'REFUNDED';
      case 'DELETED':
      case 'CHARGEBACK_REQUESTED':
      case 'CHARGEBACK_DISPUTE':
      case 'AWAITING_CHARGEBACK_REVERSAL':
        return 'CANCELLED';
      default:
        return 'PENDING';
    }
  }

  // ASAAS retorna "YYYY-MM-DD HH:mm:ss" em horário de Brasília (UTC-3).
  private parseAsaasDateTime(d: string): string {
    if (!d) return new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const [date, time] = d.split(' ');
    if (!date || !time) return new Date(d).toISOString();
    return new Date(`${date}T${time}-03:00`).toISOString();
  }

  private async request<T>(
    method: 'GET' | 'POST',
    pathname: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${pathname}`;
    const res = await fetch(url, {
      method,
      headers: {
        access_token: this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'theaimodelab-api',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed: { errors?: Array<{ code?: string; description?: string }> } & Record<string, unknown> = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }

    if (!res.ok) {
      const rawMessage = parsed.errors?.[0]?.description ?? `HTTP ${res.status}`;
      const errorCode = parsed.errors?.[0]?.code ?? '';
      this.logger.error(`ASAAS ${method} ${pathname} failed: ${rawMessage}`);
      throw this.translateError(rawMessage, errorCode, res.status);
    }

    return parsed as T;
  }

  /**
   * Mapeia erros do ASAAS para mensagens em português voltadas ao usuário final.
   * Nunca expõe o nome do provedor (ASAAS) na resposta visível.
   */
  private translateError(
    rawMessage: string,
    errorCode: string,
    httpStatus: number,
  ): HttpException {
    const msg = rawMessage.toLowerCase();

    // CPF/CNPJ inválido — erro do usuário, 400
    if (msg.includes('cpf') || msg.includes('cnpj')) {
      return new BadRequestException(
        'CPF ou CNPJ inválido. Confira os dígitos e tente novamente.',
      );
    }

    // PIX temporariamente indisponível (conta em aprovação, sem chave, etc) — 503
    if (
      (msg.includes('pix') && (msg.includes('disponível') || msg.includes('aprovada'))) ||
      msg.includes('chave pix')
    ) {
      return new ServiceUnavailableException(
        'Pagamento via PIX temporariamente indisponível. Tente novamente em alguns minutos ou use o cartão.',
      );
    }

    // Rate limit / excesso de consultas — 429
    if (msg.includes('excesso') || msg.includes('tente novamente mais tarde')) {
      return new HttpException(
        'Muitas tentativas em pouco tempo. Aguarde um instante e tente novamente.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Customer não encontrado / dados inválidos no payload — 400
    if (msg.includes('customer') || msg.includes('inválido') || errorCode === 'invalid_object') {
      return new BadRequestException(
        'Não foi possível processar os dados informados. Verifique e tente novamente.',
      );
    }

    // Fallback genérico — 500
    return new InternalServerErrorException(
      'Não foi possível gerar o PIX no momento. Tente novamente em instantes.',
    );
  }
}
