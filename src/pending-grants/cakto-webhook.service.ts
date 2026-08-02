import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { WebhookLogsService } from '../webhook-logs/webhook-logs.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';

/**
 * Webhook da Cakto (https://cakto.com.br) — gateway BRL do Brasil, coexiste com o
 * Perfect Pay (USD, /en e /es). Ver memória cakto-integration.
 *
 * Todos os planos são OFERTAS de um único produto "THE AI MODEL LAB". O que
 * distingue o plano é o `offer` (short-code, ex.: `3a7idye` = Studio), que também
 * é o segmento do link `pay.cakto.com.br/<offer>`. Casamos a venda com o plano por
 * `Plan.caktoOfferCode`. Se nenhum offer casar, o evento é de OUTRO produto da
 * mesma conta Cakto (a conta vende vários) → ignorado.
 *
 * Envelope típico entregue pela Cakto:
 *
 *   {
 *     secret: '<CAKTO_WEBHOOK_SECRET>',
 *     event: 'purchase_approved' | 'subscription_created' | 'subscription_renewed'
 *          | 'subscription_canceled' | 'subscription_renewal_refused'
 *          | 'refund' | 'chargeback' | ...,
 *     data: {                       // objeto order/subscription
 *       id, refId, status, amount, currency,
 *       offer: { id: '3a7idye', name: 'Studio' } | '3a7idye',
 *       product: { id, name },
 *       customer: { email, name },
 *       subscription: { id } | null,
 *       checkoutUrl: 'https://pay.cakto.com.br/3a7idye_123456',
 *     }
 *   }
 *
 * O formato exato do envelope NÃO é documentado publicamente — extraímos de forma
 * defensiva (event/data podem vir aninhados ou na raiz). Validar com evento de
 * teste da Cakto após deploy e ajustar os helpers se necessário.
 *
 * Autenticação: compara timing-safe o `secret` do payload (ou header/query) com
 * CAKTO_WEBHOOK_SECRET. Sem env configurada, pula a checagem (com warning), em
 * paridade com os outros providers do módulo.
 */
@Injectable()
export class CaktoWebhookService {
  private readonly logger = new Logger(CaktoWebhookService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly webhookLogs: WebhookLogsService,
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
  ) {}

  async handle(
    payload: any,
    headers?: Record<string, string>,
    querySecret?: string,
  ): Promise<{ processed: boolean; reason?: string }> {
    this.verifySecret(payload, headers, querySecret);

    const data = this.extractData(payload);
    const eventType = this.extractEventType(payload, data);
    const externalEventId = this.extractEventId(payload, data);
    const email = this.extractEmail(data);

    await this.webhookLogs.create(
      'cakto',
      eventType ?? 'unknown',
      externalEventId,
      payload,
    );

    // Casa o plano pelo offer code da Cakto. Se nada casar, tentamos casar um
    // PACOTE de crédito avulso (produto de pagamento único). Se nada casar, o
    // evento é de outro produto da conta (não é nosso) → ignora sem erro.
    const offerCandidates = this.extractOfferCandidates(data);
    const plan = offerCandidates.length
      ? await this.prisma.plan.findFirst({
          where: { caktoOfferCode: { in: offerCandidates } },
          select: { id: true, slug: true, name: true },
        })
      : null;

    const kind = this.classifyEvent(payload, data);

    if (!plan) {
      // Pacote de crédito avulso (one-off, BRL via Cakto). Concede créditos bônus
      // reutilizando o mesmo caminho do fluxo Perfect Pay de pacotes.
      const creditPackage = offerCandidates.length
        ? await this.prisma.creditPackage.findFirst({
            where: { caktoOfferCode: { in: offerCandidates } },
            select: { id: true, name: true, credits: true },
          })
        : null;

      if (creditPackage) {
        // Reembolso/chargeback/cancelamento de pacote: bônus one-off não gera
        // revogação de assinatura — apenas logamos e ignoramos (sem erro).
        if (kind !== 'paid') {
          return {
            processed: false,
            reason: `ignored ${kind} event for credit package "${creditPackage.name}"`,
          };
        }
        if (!email) {
          throw new BadRequestException(
            'Email do comprador não encontrado no payload',
          );
        }
        return this.handleCreditPurchase(data, email, creditPackage);
      }

      return {
        processed: false,
        reason: `no plan/package matched cakto offer candidates=[${offerCandidates.join(', ')}]`,
      };
    }

    // Reembolso / chargeback → revoga na hora. Cancelamento → acesso até fim do período.
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
        subscriptionCode: this.extractSubscriptionCode(data) ?? undefined,
        provider: 'cakto',
      });
    }

    if (kind !== 'paid') {
      return {
        processed: false,
        reason: `ignored event: ${eventType ?? 'n/a'} (status=${data?.status ?? 'n/a'})`,
      };
    }

    if (!email) {
      throw new BadRequestException('Email do comprador não encontrado no payload');
    }

    return this.handlePlanSubscription(data, email, plan);
  }

  /**
   * Ativa/renova a assinatura mensal BRL do plano comprado via Cakto.
   * Exige conta com o email da compra (idempotente pelo id da venda).
   */
  private async handlePlanSubscription(
    data: any,
    email: string,
    plan: { id: string; slug: string; name: string },
  ): Promise<{ processed: boolean; reason?: string }> {
    const saleCode = this.extractSaleCode(data);
    if (!saleCode) {
      throw new BadRequestException('Id da venda (data.id) não encontrado no payload');
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, referredByCode: true },
    });

    if (!user) {
      this.logger.warn(
        `Cakto: assinatura do plano "${plan.name}" (venda ${saleCode}) mas nenhuma conta tem o email ${email}. Não ativado.`,
      );
      return { processed: false, reason: `no account for email ${email}` };
    }

    return this.paymentsService.activateOrRenewPerfectpaySubscription({
      userId: user.id,
      planId: plan.id,
      saleCode,
      subscriptionCode: this.extractSubscriptionCode(data) ?? undefined,
      amountCents: this.extractAmountCents(data),
      currency: this.extractCurrency(data),
      referredByCode: user.referredByCode ?? undefined,
      provider: 'cakto',
    });
  }

  /**
   * Credita um PACOTE de crédito avulso (one-off) comprado via Cakto.
   *
   * Espelha o fluxo Perfect Pay de pacotes: o comprador precisa ter conta (casada
   * pelo email); sem conta, NÃO credita (apenas loga). Reutiliza
   * `PaymentsService.processCreditPurchase`, que credita em bonus (não expira),
   * registra pagamento/ledger, comissão de afiliado, email de confirmação e
   * evento de compra. Idempotência: `saleCode` (id da order) vira o
   * `externalPaymentId` — a 2ª entrega da mesma venda é ignorada lá dentro.
   */
  private async handleCreditPurchase(
    data: any,
    email: string,
    creditPackage: { id: string; name: string; credits: number },
  ): Promise<{ processed: boolean; reason?: string }> {
    const saleCode = this.extractSaleCode(data);
    if (!saleCode) {
      throw new BadRequestException(
        'Id da venda (data.id) não encontrado no payload',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, referredByCode: true },
    });

    if (!user) {
      this.logger.warn(
        `Cakto: compra do pacote "${creditPackage.name}" (venda ${saleCode}) mas nenhuma conta tem o email ${email}. Não creditado.`,
      );
      return { processed: false, reason: `no account for email ${email}` };
    }

    await this.paymentsService.processCreditPurchase(
      user.id,
      creditPackage.id,
      this.extractAmountCents(data),
      saleCode,
      this.extractCurrency(data),
      user.referredByCode ?? undefined,
      'cakto',
    );

    this.logger.log(
      `Cakto credit purchase: +${creditPackage.credits} créditos (${creditPackage.name}) → user ${user.id} (${email})`,
    );

    return { processed: true };
  }

  // ────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────

  private verifySecret(
    payload: any,
    headers?: Record<string, string>,
    querySecret?: string,
  ): void {
    const expected = this.configService
      .get<string>('CAKTO_WEBHOOK_SECRET')
      ?.trim();

    if (!expected) {
      this.logger.warn(
        'CAKTO_WEBHOOK_SECRET not configured — skipping secret check',
      );
      return;
    }

    const received =
      (typeof payload?.secret === 'string' ? payload.secret : null) ??
      (typeof payload?.data?.secret === 'string' ? payload.data.secret : null) ??
      querySecret ??
      headers?.['x-cakto-signature'] ??
      headers?.['x-cakto-secret'] ??
      null;

    if (!received) {
      throw new UnauthorizedException('Missing Cakto secret');
    }

    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    const valid = a.length === b.length && timingSafeEqual(a, b);
    if (!valid) {
      throw new UnauthorizedException('Invalid Cakto secret');
    }
  }

  /** Objeto da venda: pode vir em `data` ou na raiz do payload. */
  private extractData(payload: any): any {
    if (payload?.data && typeof payload.data === 'object') return payload.data;
    return payload ?? {};
  }

  private extractEventType(payload: any, data: any): string | null {
    const ev = payload?.event ?? payload?.type ?? payload?.event_type ?? null;
    if (typeof ev === 'string' && ev.trim()) return ev.trim().toLowerCase();
    const status = data?.status;
    if (typeof status === 'string' && status.trim()) {
      return `status.${status.trim().toLowerCase()}`;
    }
    return null;
  }

  /** Idempotência: cada venda+evento vira um id único. */
  private extractEventId(payload: any, data: any): string | null {
    const id = data?.id ?? data?.refId ?? null;
    const ev = payload?.event ?? data?.status ?? 'na';
    if (id) return `cakto-${id}-${ev}`;
    return null;
  }

  /**
   * Candidatos ao offer code da Cakto (casa com Plan.caktoOfferCode). Coleta de
   * `offer.id`/`offer`, campos soltos, e o short-code embutido no checkoutUrl
   * (`pay.cakto.com.br/<offer>` ou `<offer>_<checkoutId>`).
   */
  private extractOfferCandidates(data: any): string[] {
    const raw: unknown[] = [
      data?.offer?.id,
      typeof data?.offer === 'string' ? data.offer : null,
      data?.offer_id,
      data?.offerId,
      data?.offer?.short_id,
    ];

    const urlFields: unknown[] = [
      data?.checkoutUrl,
      data?.checkout_url,
      data?.url,
      data?.offer?.checkoutUrl,
    ];
    for (const u of urlFields) {
      if (typeof u === 'string' && u.length > 0) {
        const lastSeg = u.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop();
        if (lastSeg) {
          raw.push(lastSeg);
          // `pay.cakto.com.br/<offer>_<checkoutId>` → o offer é antes do "_".
          const beforeUnderscore = lastSeg.split('_')[0];
          if (beforeUnderscore && beforeUnderscore !== lastSeg) {
            raw.push(beforeUnderscore);
          }
        }
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

  /**
   * Classifica o evento em uma ação:
   *  - 'paid'       → compra aprovada / assinatura criada ou renovada.
   *  - 'refund'     → reembolso: revoga imediatamente.
   *  - 'chargeback' → disputa/chargeback: revoga imediatamente.
   *  - 'canceled'   → assinatura cancelada: acesso até fim do período.
   *  - 'ignore'     → demais (pix/boleto gerado, renovação recusada c/ retry, etc).
   */
  private classifyEvent(
    payload: any,
    data: any,
  ): 'paid' | 'refund' | 'chargeback' | 'canceled' | 'ignore' {
    const event =
      typeof payload?.event === 'string' ? payload.event.toLowerCase() : '';
    const status =
      typeof data?.status === 'string' ? data.status.toLowerCase() : '';

    if (event === 'chargeback' || /charge.?back|dispute/.test(status)) {
      return 'chargeback';
    }
    if (event === 'refund' || /refund|estorn|reembol|devolv/.test(status)) {
      return 'refund';
    }
    if (event === 'subscription_canceled' || status === 'canceled') {
      return 'canceled';
    }
    // Renovação recusada (subscription_renewal_refused): a Cakto ainda tenta
    // (max_retries). NÃO revoga — se todas falharem, o cron expira após a carência.
    if (
      event === 'purchase_approved' ||
      event === 'subscription_created' ||
      event === 'subscription_renewed' ||
      status === 'paid' ||
      status === 'approved'
    ) {
      return 'paid';
    }
    return 'ignore';
  }

  /**
   * Chave de idempotência por CICLO de cobrança. A Cakto dispara mais de um evento
   * para a MESMA cobrança (ex.: `purchase_approved` + `subscription_created` na
   * assinatura inicial; `purchase_approved` + `subscription_renewed` na renovação).
   * Todos compartilham `subscription.id` + `paid_payments_quantity` (contador da
   * cobrança: 1=inicial, 2=1ª renovação, …), então colapsam numa única ativação;
   * cobranças de meses diferentes têm contador diferente e ativam de novo.
   * Fallback (produto sem nó subscription): id da order.
   */
  private extractSaleCode(data: any): string | null {
    const sub = data?.subscription;
    const subId = sub?.id ?? (typeof sub === 'string' ? sub : null);
    const seq = sub?.paid_payments_quantity ?? sub?.current_period;
    if (subId && seq != null) {
      return `cakto-sub-${String(subId).trim()}-n${seq}`;
    }
    const code = data?.id ?? data?.refId ?? null;
    if (!code) return null;
    const s = String(code).trim();
    return s.length > 0 ? `cakto-${s}` : null;
  }

  /**
   * Código ESTÁVEL da assinatura recorrente na Cakto (não muda entre cobranças).
   * Distingue renovação × troca de plano e revoga a assinatura certa.
   */
  private extractSubscriptionCode(data: any): string | null {
    const code =
      data?.subscription?.id ??
      (typeof data?.subscription === 'string' ? data.subscription : null) ??
      data?.subscription_id ??
      data?.subscriptionId ??
      null;
    if (!code) return null;
    const s = String(code).trim();
    return s.length > 0 ? `cakto-sub-${s}` : null;
  }

  /** Valor pago em centavos (data.amount vem como "34.35" ou número). */
  private extractAmountCents(data: any): number {
    const raw = data?.amount ?? data?.baseAmount ?? data?.price ?? 0;
    const num = typeof raw === 'number' ? raw : parseFloat(String(raw));
    if (!Number.isFinite(num) || num <= 0) return 0;
    return Math.round(num * 100);
  }

  /** Moeda da venda. A Cakto opera em BRL. */
  private extractCurrency(data: any): string {
    const key = data?.currency;
    if (typeof key === 'string' && key.trim().length === 3) {
      return key.trim().toUpperCase();
    }
    return 'BRL';
  }

  private extractEmail(data: any): string | null {
    const candidate =
      data?.customer?.email ??
      data?.buyer?.email ??
      data?.email ??
      null;

    if (!candidate || typeof candidate !== 'string') return null;
    return candidate.trim().toLowerCase();
  }
}
