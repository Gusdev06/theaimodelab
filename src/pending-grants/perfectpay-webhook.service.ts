import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { EmailService } from '../email/email.service';
import { WebhookLogsService } from '../webhook-logs/webhook-logs.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import {
  PERFECTPAY_COURSE_BUNDLE,
  PendingGrantsService,
} from './pending-grants.service';

/**
 * Webhook do Perfect Pay (https://www.perfectpay.com.br).
 *
 * Dois fluxos, separados pelo `product.code`:
 *  1. Pacote de crédito: o produto é único; cada pacote é um "plano" cujo código
 *     aparece no link de checkout. Se o plan.code casar com um credit_packages
 *     (perfectpay_plan_code), credita o pacote na conta do email comprador via
 *     PaymentsService.processCreditPurchase (saldo bônus). Exige conta.
 *  2. Curso (demais produtos): mesmo modelo de Hotmart/Hubla/Greenn — libera o
 *     bundle de gerações grátis (PERFECTPAY_COURSE_BUNDLE) por email, consumido no
 *     signup quando o usuário se cadastra com esse email.
 *
 * Payload típico (v2.1):
 *
 *   {
 *     token: '<PERFECTPAY_WEBHOOK_TOKEN>',
 *     code: 'PPCPMTB123ABC',
 *     sale_amount: 99.90,
 *     currency_enum: 1,
 *     sale_status_enum: 2,           // 1=pending, 2=approved, 4=completed, 6=refunded ...
 *     sale_status_detail: 'approved',
 *     customer: {
 *       email: 'buyer@x.com',
 *       full_name: 'Buyer Name',
 *       identification_number: '...'
 *     },
 *     product: { code: 'PROD123', name: '...' }
 *   }
 *
 * Status aceitos (libera o bundle):
 *   - 2 (approved)
 *   - 4 (completed)
 *
 * Autenticação: comparação timing-safe entre `payload.token` (ou header
 * `x-perfectpay-token`) e PERFECTPAY_WEBHOOK_TOKEN. Se a env não estiver
 * configurada, a checagem é pulada (com warning), mantendo paridade com os
 * outros providers desse módulo.
 */
@Injectable()
export class PerfectpayWebhookService {
  private readonly logger = new Logger(PerfectpayWebhookService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly pendingGrantsService: PendingGrantsService,
    private readonly webhookLogs: WebhookLogsService,
    private readonly emailService: EmailService,
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
  ) {}

  async handle(
    payload: any,
    headers?: Record<string, string>,
    queryToken?: string,
  ): Promise<{ processed: boolean; reason?: string }> {
    this.verifyToken(payload, headers, queryToken);

    const eventType = this.extractEventType(payload);
    const externalEventId = this.extractEventId(payload);
    const email = this.extractEmail(payload);

    await this.webhookLogs.create(
      'perfectpay',
      eventType ?? 'unknown',
      externalEventId,
      payload,
    );

    const kind = this.classifyEvent(payload);

    // Cancelamento / reembolso / chargeback de assinatura recorrente.
    // refund/chargeback → revoga na hora; cancelamento normal → acesso até fim do período.
    if (kind === 'canceled' || kind === 'refund' || kind === 'chargeback') {
      if (!email) {
        return { processed: false, reason: `${kind} event sem email` };
      }
      const user = await this.prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (!user) {
        return { processed: false, reason: `no account for email ${email}` };
      }
      const immediate = kind === 'refund' || kind === 'chargeback';
      return this.paymentsService.revokePerfectpaySubscription(user.id, {
        immediate,
        reason: kind,
      });
    }

    if (kind !== 'paid') {
      return {
        processed: false,
        reason: `ignored event: status=${payload?.sale_status_enum ?? 'n/a'} (${payload?.sale_status_detail ?? 'n/a'})`,
      };
    }

    if (!email) {
      throw new BadRequestException('Email do comprador não encontrado no payload');
    }

    // Na Perfect Pay o produto é único; o que distingue plano/pacote é o "plano",
    // cujo código aparece no link de checkout (ex: .../pay/PPU38CQDTOF). Coletamos
    // candidatos de vários campos do postback.
    const planCandidates = this.extractPlanCandidates(payload);

    // 1) Assinatura mensal? casa com plans.perfectpay_plan_code (planos ativos).
    const plan = planCandidates.length
      ? await this.prisma.plan.findFirst({
          where: { perfectpayPlanCode: { in: planCandidates }, isActive: true },
        })
      : null;

    if (plan) {
      return this.handlePlanSubscription(payload, email, plan);
    }

    // 2) (Legado) Pacote de crédito avulso — mantido para compras antigas.
    const creditPackage = planCandidates.length
      ? await this.prisma.creditPackage.findFirst({
          where: { perfectpayPlanCode: { in: planCandidates } },
        })
      : null;

    if (creditPackage) {
      return this.handleCreditPurchase(payload, email, creditPackage);
    }

    // 3) Caso contrário: produto de curso → libera gerações grátis por email.
    const { created } = await this.pendingGrantsService.createPending({
      email,
      bundle: PERFECTPAY_COURSE_BUNDLE,
      source: 'perfectpay',
      externalEventId,
    });

    this.logger.log(
      `Perfectpay ${eventType} for ${email} — pending grant ${created ? 'created' : 'already existed'}`,
    );

    if (created) {
      const buyerName = this.extractName(payload);
      await this.emailService.sendPendingGrantsEmailEs(email, buyerName);
    }

    return { processed: true };
  }

  /**
   * Ativa/renova a assinatura mensal do plano comprado via Perfect Pay.
   * Exige conta com o email da compra (idempotente pelo código da venda).
   */
  private async handlePlanSubscription(
    payload: any,
    email: string,
    plan: { id: string; slug: string; name: string },
  ): Promise<{ processed: boolean; reason?: string }> {
    const saleCode = this.extractSaleCode(payload);
    if (!saleCode) {
      throw new BadRequestException('Código da venda (code) não encontrado no payload');
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, referredByCode: true },
    });

    if (!user) {
      this.logger.warn(
        `Perfectpay: assinatura do plano "${plan.name}" (venda ${saleCode}) mas nenhuma conta tem o email ${email}. Não ativado.`,
      );
      return { processed: false, reason: `no account for email ${email}` };
    }

    return this.paymentsService.activateOrRenewPerfectpaySubscription({
      userId: user.id,
      planId: plan.id,
      saleCode,
      amountCents: this.extractAmountCents(payload),
      currency: this.extractCurrency(payload),
      referredByCode: user.referredByCode ?? undefined,
    });
  }

  /**
   * Credita um pacote de crédito comprado via Perfect Pay.
   *
   * Regra do negócio: o comprador precisa ter conta antes de comprar. Casamos a
   * venda com a conta pelo email. Se não houver conta com esse email, NÃO
   * creditamos (apenas logamos), pois não temos como saber a quem pertence.
   * Idempotência: o `code` da venda vira o externalPaymentId no processCreditPurchase.
   */
  private async handleCreditPurchase(
    payload: any,
    email: string,
    creditPackage: { id: string; name: string; credits: number },
  ): Promise<{ processed: boolean; reason?: string }> {
    const saleCode = this.extractSaleCode(payload);
    if (!saleCode) {
      throw new BadRequestException('Código da venda (code) não encontrado no payload');
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, referredByCode: true },
    });

    if (!user) {
      this.logger.warn(
        `Perfectpay: compra do pacote "${creditPackage.name}" (venda ${saleCode}) mas nenhuma conta tem o email ${email}. Não creditado.`,
      );
      return { processed: false, reason: `no account for email ${email}` };
    }

    const amountCents = this.extractAmountCents(payload);
    const currency = this.extractCurrency(payload);

    await this.paymentsService.processCreditPurchase(
      user.id,
      creditPackage.id,
      amountCents,
      saleCode,
      currency,
      user.referredByCode ?? undefined,
      'perfectpay',
    );

    this.logger.log(
      `Perfectpay credit purchase: +${creditPackage.credits} créditos (${creditPackage.name}) → user ${user.id} (${email})`,
    );

    return { processed: true };
  }

  // ────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────

  private verifyToken(
    payload: any,
    headers?: Record<string, string>,
    queryToken?: string,
  ): void {
    const expected = this.configService.get<string>('PERFECTPAY_WEBHOOK_TOKEN');
    if (!expected) {
      this.logger.warn(
        'PERFECTPAY_WEBHOOK_TOKEN not configured — skipping token check',
      );
      return;
    }

    const received =
      (typeof payload?.token === 'string' ? payload.token : null) ??
      queryToken ??
      headers?.['x-perfectpay-token'] ??
      headers?.['X-Perfectpay-Token'] ??
      null;

    if (!received) {
      throw new UnauthorizedException('Missing Perfectpay token');
    }

    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid Perfectpay token');
    }
  }

  /**
   * Classifica o evento do postback em uma ação:
   *  - 'paid'       → 2 (approved) ou 4 (completed): cria/renova assinatura.
   *  - 'refund'     → 6 (estornado) ou detalhe de reembolso: revoga imediatamente.
   *  - 'chargeback' → 7 (disputa/chargeback): revoga imediatamente.
   *  - 'canceled'   → assinatura cancelada (recorrência interrompida): acesso até fim do período.
   *  - 'ignore'     → pending e demais status.
   */
  private classifyEvent(
    payload: any,
  ): 'paid' | 'refund' | 'chargeback' | 'canceled' | 'ignore' {
    const status = payload?.sale_status_enum;
    const detail =
      typeof payload?.sale_status_detail === 'string'
        ? payload.sale_status_detail.toLowerCase()
        : '';
    const subStatus =
      typeof payload?.subscription?.status === 'string'
        ? payload.subscription.status.toLowerCase()
        : typeof payload?.subscription_status === 'string'
          ? payload.subscription_status.toLowerCase()
          : '';

    if (status === 7 || /charge.?back|dispute|reclam/.test(detail)) {
      return 'chargeback';
    }
    if (status === 6 || /refund|estorn|reembol|devolv/.test(detail)) {
      return 'refund';
    }
    if (/cancel/.test(detail) || /cancel|inactive|expired/.test(subStatus)) {
      return 'canceled';
    }
    if (status === 2 || status === 4 || detail === 'approved' || detail === 'completed') {
      return 'paid';
    }
    return 'ignore';
  }

  private extractEventType(payload: any): string | null {
    const detail = payload?.sale_status_detail ?? null;
    const status = payload?.sale_status_enum ?? null;
    if (detail) return `sale.${String(detail).toLowerCase()}`;
    if (status != null) return `sale.status_${status}`;
    return null;
  }

  /** Idempotência: cada venda+status vira um id único. */
  private extractEventId(payload: any): string | null {
    const code = payload?.code ?? payload?.sale_code ?? null;
    const status = payload?.sale_status_enum ?? 'na';
    if (code) return `perfectpay-sale-${code}-${status}`;
    return null;
  }

  /**
   * Candidatos ao código do "plano" na Perfect Pay. O produto é único p/ todos
   * os pacotes; cada pacote é um plano cujo código aparece no link de checkout
   * (ex: .../pay/PPU38CQDQHP). Como o campo exato do postback pode variar,
   * coletamos de vários lugares: plan.code/name, campos *_code, e o último
   * segmento de qualquer URL de checkout presente. Casa com
   * credit_packages.perfectpay_plan_code via `IN`.
   */
  private extractPlanCandidates(payload: any): string[] {
    const raw: unknown[] = [
      payload?.plan?.code,
      payload?.plan_code,
      payload?.plan?.name,
      payload?.plan?.external_reference,
      payload?.checkout_code,
      payload?.product?.plan?.code,
    ];

    // Extrai o código do final de qualquer URL de checkout no payload.
    const urlFields: unknown[] = [
      payload?.checkout_url,
      payload?.url,
      payload?.plan?.checkout_url,
      payload?.plan?.url,
      payload?.product?.checkout_url,
      payload?.sale_url,
    ];
    for (const u of urlFields) {
      if (typeof u === 'string' && u.length > 0) {
        const seg = u.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop();
        if (seg) raw.push(seg);
      }
    }

    const seen = new Set<string>();
    for (const v of raw) {
      if (v == null) continue;
      const s = String(v).trim();
      if (s.length > 0) seen.add(s);
    }
    return [...seen];
  }

  /** Identificador estável da venda (idempotência do crédito, por venda). */
  private extractSaleCode(payload: any): string | null {
    const code = payload?.code ?? payload?.sale_code ?? null;
    if (!code) return null;
    const s = String(code).trim();
    return s.length > 0 ? `perfectpay-${s}` : null;
  }

  /** Valor pago em centavos (sale_amount vem na unidade da moeda, ex: 89.90). */
  private extractAmountCents(payload: any): number {
    const raw = payload?.sale_amount ?? payload?.amount ?? 0;
    const num = typeof raw === 'number' ? raw : parseFloat(String(raw));
    if (!Number.isFinite(num) || num <= 0) return 0;
    return Math.round(num * 100);
  }

  /** Moeda da venda (currency_enum_key: 'BRL' | 'USD' | 'EUR'). Default BRL. */
  private extractCurrency(payload: any): string {
    const key = payload?.currency_enum_key;
    if (typeof key === 'string' && key.trim().length === 3) {
      return key.trim().toUpperCase();
    }
    return 'BRL';
  }

  private extractEmail(payload: any): string | null {
    const candidate =
      payload?.customer?.email ??
      payload?.buyer?.email ??
      payload?.email ??
      null;

    if (!candidate || typeof candidate !== 'string') return null;
    return candidate.trim().toLowerCase();
  }

  private extractName(payload: any): string | null {
    const candidate =
      payload?.customer?.full_name ??
      payload?.customer?.name ??
      payload?.buyer?.name ??
      payload?.name ??
      null;

    if (!candidate || typeof candidate !== 'string') return null;
    const trimmed = candidate.trim();
    return trimmed.length > 0 ? trimmed.split(/\s+/)[0] : null;
  }
}
