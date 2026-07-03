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

export type AsaasAuthorizationStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'CANCELED'
  | 'EXPIRED'
  | 'REJECTED';

export interface AsaasPixAutoAuthorization {
  id: string;
  status: AsaasAuthorizationStatus;
  qrCodePayload: string;
  qrCodeEncodedImage: string;
  conciliationIdentifier: string;
  value: number;
  expiresAt: string | null;
}

interface CreateAuthorizationInput {
  customerId: string;
  /** Valor da cobrança recorrente mensal (em centavos) */
  valueCents: number;
  /**
   * Valor cobrado AGORA na primeira cobrança imediata (em centavos).
   * Em upgrades pro-rateados é diferente de valueCents — cobramos só a diferença.
   * Quando não informado, usa valueCents (primeira cobrança = mensalidade cheia).
   */
  immediateValueCents?: number;
  description: string;
  externalReference: string;
  /** Identificador único do contrato (max 35 chars). Ex: theaimodelab-{userId8}-{planSlug} */
  contractId: string;
}

interface CreateRecurringChargeInput {
  customerId: string;
  authorizationId: string;
  valueCents: number;
  dueDate: string; // YYYY-MM-DD
  description: string;
  externalReference: string;
}

interface AsaasAuthorizationResponse {
  id: string;
  status: string;
  value: number;
  // payload e encodedImage vêm no ROOT (não dentro de immediateQrCode).
  payload?: string;
  encodedImage?: string;
  endToEndIdentifier?: string;
  immediateQrCode?: {
    conciliationIdentifier?: string;
    expirationDate?: string;
  };
}

interface AsaasRecurringPayment {
  id: string;
  status: string;
  value: number;
  dueDate: string;
  externalReference?: string | null;
}

/**
 * Cliente HTTP da API v3 do ASAAS para PIX Automático (BACEN).
 *
 * Fluxo:
 * 1. Cria autorização → retorna QR Code que combina 1ª cobrança + autorização da recorrência
 * 2. User escaneia → app do banco mostra "Autorizar cobrança recorrente?"
 * 3. Banco autoriza → webhook PIX_AUTOMATIC_AUTHORIZATION_ACTIVE chega
 * 4. Pra cobranças futuras: chamar createRecurringCharge 2-10 dias úteis antes do vencimento
 *
 * Não duplica autenticação/customer — AsaasService cuida disso.
 */
@Injectable()
export class AsaasSubscriptionsService {
  private readonly logger = new Logger(AsaasSubscriptionsService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.getOrThrow<string>('ASAAS_API_KEY').trim();
    const rawBase = this.configService
      .get<string>('ASAAS_BASE_URL', 'https://api-sandbox.asaas.com')
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/v\d+$/, '');
    this.baseUrl = `${rawBase}/v3`;
  }

  /**
   * Cria autorização de PIX Automático com QR Code imediato.
   * O QR já inclui a primeira cobrança + autorização da recorrência mensal.
   *
   * Shape ASAAS:
   * - customerId, contractId (max 35), frequency, startDate, value, description (max 35)
   * - immediateQrCode: { value, description } pra primeira cobrança
   * - paymentCreationMode=MANUAL → nosso cron T-3 cria as cobranças seguintes
   */
  async createAuthorization(
    input: CreateAuthorizationInput,
  ): Promise<AsaasPixAutoAuthorization> {
    const valueReais = Number((input.valueCents / 100).toFixed(2));
    const immediateValueReais = input.immediateValueCents
      ? Number((input.immediateValueCents / 100).toFixed(2))
      : valueReais;
    const today = new Date().toISOString().slice(0, 10);
    const description = input.description.slice(0, 35);

    const response = await this.request<AsaasAuthorizationResponse>(
      'POST',
      '/pix/automatic/authorizations',
      {
        customerId: input.customerId,
        contractId: input.contractId.slice(0, 35),
        frequency: 'MONTHLY',
        startDate: today,
        value: valueReais,
        description,
        paymentCreationMode: 'MANUAL',
        externalReference: input.externalReference,
        immediateQrCode: {
          value: immediateValueReais,
          originalValue: immediateValueReais,
          description,
          expirationSeconds: 600, // 10 minutos pro user escanear e autorizar
          allowsMultiplePayments: false,
        },
      },
    );

    return {
      id: response.id,
      status: this.mapAuthStatus(response.status),
      qrCodePayload: response.payload ?? '',
      qrCodeEncodedImage: response.encodedImage
        ? `data:image/png;base64,${response.encodedImage}`
        : '',
      conciliationIdentifier: response.immediateQrCode?.conciliationIdentifier ?? '',
      value: response.value,
      expiresAt: response.immediateQrCode?.expirationDate
        ? this.parseAsaasDateTime(response.immediateQrCode.expirationDate)
        : null,
    };
  }

  /**
   * Consulta o status atual da autorização (usado em polling e revalidação webhook).
   */
  async getAuthorization(id: string): Promise<AsaasPixAutoAuthorization> {
    const response = await this.request<AsaasAuthorizationResponse>(
      'GET',
      `/pix/automatic/authorizations/${encodeURIComponent(id)}`,
    );

    return {
      id: response.id,
      status: this.mapAuthStatus(response.status),
      qrCodePayload: response.payload ?? '',
      qrCodeEncodedImage: response.encodedImage
        ? `data:image/png;base64,${response.encodedImage}`
        : '',
      conciliationIdentifier: response.immediateQrCode?.conciliationIdentifier ?? '',
      value: response.value,
      expiresAt: response.immediateQrCode?.expirationDate
        ? this.parseAsaasDateTime(response.immediateQrCode.expirationDate)
        : null,
    };
  }

  /**
   * Cancela autorização PIX Auto (usado em cancelamento de subscription).
   * Após cancelada, o ASAAS não vai mais aceitar cobranças referenciando esse ID.
   */
  async cancelAuthorization(id: string): Promise<void> {
    await this.request<{ deleted?: boolean }>(
      'DELETE',
      `/pix/automatic/authorizations/${encodeURIComponent(id)}`,
    );
    this.logger.log(`Canceled PIX Auto authorization ${id}`);
  }

  /**
   * Cria cobrança recorrente referenciando uma autorização PIX Auto ativa.
   * BACEN exige criar entre 2 e 10 dias úteis antes do vencimento.
   */
  async createRecurringCharge(
    input: CreateRecurringChargeInput,
  ): Promise<AsaasRecurringPayment> {
    const valueReais = Number((input.valueCents / 100).toFixed(2));

    return this.request<AsaasRecurringPayment>('POST', '/payments', {
      customer: input.customerId,
      billingType: 'PIX',
      pixAutomaticAuthorizationId: input.authorizationId,
      value: valueReais,
      dueDate: input.dueDate,
      description: input.description.slice(0, 500),
      externalReference: input.externalReference,
    });
  }

  private mapAuthStatus(asaasStatus: string): AsaasAuthorizationStatus {
    switch (asaasStatus?.toUpperCase()) {
      case 'ACTIVE':
      case 'ACTIVATED':
        return 'ACTIVE';
      case 'CANCELED':
      case 'CANCELLED':
        return 'CANCELED';
      case 'EXPIRED':
        return 'EXPIRED';
      case 'REJECTED':
      case 'DENIED':
        return 'REJECTED';
      case 'CREATED':
      case 'PENDING':
      case 'AWAITING_AUTHORIZATION':
      default:
        return 'PENDING';
    }
  }

  private parseAsaasDateTime(d: string): string {
    if (!d) return new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const [date, time] = d.split(' ');
    if (!date || !time) return new Date(d).toISOString();
    return new Date(`${date}T${time}-03:00`).toISOString();
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
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
      this.logger.error(
        `ASAAS PIX-Auto ${method} ${pathname} failed: ${rawMessage}`,
      );
      throw this.translateError(rawMessage, errorCode);
    }

    return parsed as T;
  }

  private translateError(rawMessage: string, errorCode: string): HttpException {
    const msg = rawMessage.toLowerCase();

    if (msg.includes('cpf') || msg.includes('cnpj')) {
      return new BadRequestException(
        'CPF ou CNPJ inválido. Confira os dígitos e tente novamente.',
      );
    }

    if (
      (msg.includes('pix') && (msg.includes('disponível') || msg.includes('aprovada'))) ||
      msg.includes('chave pix')
    ) {
      return new ServiceUnavailableException(
        'Pagamento via PIX temporariamente indisponível. Tente novamente em alguns minutos ou use o cartão.',
      );
    }

    if (msg.includes('excesso') || msg.includes('tente novamente mais tarde')) {
      return new HttpException(
        'Muitas tentativas em pouco tempo. Aguarde um instante e tente novamente.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (msg.includes('customer') || msg.includes('inválido') || errorCode === 'invalid_object') {
      return new BadRequestException(
        'Não foi possível processar os dados informados. Verifique e tente novamente.',
      );
    }

    return new InternalServerErrorException(
      'Não foi possível processar a assinatura PIX no momento. Tente novamente em instantes.',
    );
  }
}
