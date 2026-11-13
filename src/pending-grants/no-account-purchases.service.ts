import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import type { MailLocale } from '../email/brand-email';
import { resolveBrand } from '../brand/brand';

/**
 * Plano ou pacote PAGO sem conta com o e-mail da compra (B-01, auditoria da jornada 13/11).
 *
 * Antes: o webhook só logava "no account" e respondia 200; a Perfect Pay/Cakto não repetem, então a compra se
 * perdia (dinheiro cobrado, nada ativado). Agora, sem mudar o banco (que não usa prisma migrate):
 *
 * - o log original do webhook ganha `error = "no account: <e-mail>"` (fica identificável no admin/cockpit);
 * - uma linha-marcador vai para webhook_logs com provider `no-account-purchase`, `external_id` = e-mail da
 *   compra (coluna com índice, busca barata no login) e `event_type` = `<gateway>:<código da venda>`;
 * - a compradora recebe NA HORA o e-mail "pagamento aprovado, crie sua conta com este e-mail" (1 vez por venda:
 *   o marcador existe = já mandou);
 * - no cadastro e em todo login (NoAccountPurchasesClaimer), os marcadores pendentes daquele e-mail são
 *   reprocessados pelos MESMOS handlers do webhook. A idempotência é a de sempre: código da venda =
 *   Payment.externalPaymentId com lock (lockExternalPayment), então rodar 2× nunca credita 2×.
 */
export const NO_ACCOUNT_PROVIDER = 'no-account-purchase';

export type NoAccountGateway = 'perfectpay' | 'cakto';

export interface NoAccountPurchase {
  id: string;
  gateway: NoAccountGateway;
  saleCode: string;
  payload: unknown;
}

@Injectable()
export class NoAccountPurchasesService {
  private readonly logger = new Logger(NoAccountPurchasesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  /** E-mail como gravado em users.email: minúsculo e sem espaço. */
  static normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * Guarda a venda sem conta e avisa a compradora (1 vez por venda). Nunca lança: o webhook segue respondendo
   * como antes mesmo se o banco ou o Resend falharem.
   */
  async record(params: {
    gateway: NoAccountGateway;
    email: string;
    saleCode: string;
    payload: unknown;
    webhookLogId?: string | null;
    locale: MailLocale;
    productName: string;
    /** Códigos do plano/oferta da venda: dizem se é produto de outra marca (checkout_codes.brand). */
    codeCandidates?: readonly string[];
  }): Promise<{ recorded: boolean; emailSent: boolean }> {
    const email = NoAccountPurchasesService.normalizeEmail(params.email);
    try {
      if (params.webhookLogId) {
        await this.prisma.webhookLog
          .update({ where: { id: params.webhookLogId }, data: { error: `no account: ${email}` } })
          .catch((error: unknown) =>
            this.logger.warn(`Não marquei o log ${params.webhookLogId} como "no account": ${this.message(error)}`),
          );
      }

      const eventType = `${params.gateway}:${params.saleCode}`;
      const existing = await this.prisma.webhookLog.findFirst({
        where: { provider: NO_ACCOUNT_PROVIDER, externalId: email, eventType },
        select: { id: true },
      });
      if (existing) {
        // Mesma venda chegando de novo (approved + completed, reenvio do gateway): já guardada e já avisada.
        return { recorded: false, emailSent: false };
      }

      await this.prisma.webhookLog.create({
        data: {
          provider: NO_ACCOUNT_PROVIDER,
          eventType,
          externalId: email,
          payload: params.payload as Prisma.InputJsonValue,
          error: 'aguardando conta',
        },
      });

      const brandKey = await this.brandOfSale(params.gateway, params.codeCandidates ?? []);
      const emailSent = await this.emailService.sendPurchaseWithoutAccountEmail(email, {
        locale: params.locale,
        productName: params.productName,
        ...(brandKey !== 'taml' ? { brand: resolveBrand(brandKey) } : {}),
      });
      this.logger.warn(
        `Venda ${params.saleCode} (${params.gateway}, ${params.productName}) sem conta para ${email}: guardada; ` +
          `e-mail de cadastro ${emailSent ? 'enviado' : 'NÃO enviado'}`,
      );
      return { recorded: true, emailSent };
    } catch (error) {
      this.logger.error(`Falha ao guardar a venda ${params.saleCode} sem conta (${email}): ${this.message(error)}`);
      return { recorded: false, emailSent: false };
    }
  }

  /**
   * Marca do produto vendido: venda de produto da Funvmake (código em checkout_codes com brand 'funvmake') não pode
   * receber e-mail com a arte e o link da The AI Model Lab. Falha ou código desconhecido = origem.
   */
  private async brandOfSale(gateway: NoAccountGateway, candidates: readonly string[]): Promise<string> {
    if (candidates.length === 0) return 'taml';
    try {
      const row = await this.prisma.checkoutCode.findFirst({
        where: { gateway, code: { in: [...candidates] }, isActive: true, brand: { not: 'taml' } },
        select: { brand: true },
      });
      return row?.brand ?? 'taml';
    } catch (error) {
      this.logger.warn(`Marca da venda sem conta não lida (segue como origem): ${this.message(error)}`);
      return 'taml';
    }
  }

  /** Vendas guardadas e ainda não aplicadas para este e-mail (a mais antiga primeiro). */
  async pendingFor(email: string): Promise<NoAccountPurchase[]> {
    const rows = await this.prisma.webhookLog.findMany({
      where: {
        provider: NO_ACCOUNT_PROVIDER,
        externalId: NoAccountPurchasesService.normalizeEmail(email),
        processed: false,
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
      select: { id: true, eventType: true, payload: true },
    });
    const out: NoAccountPurchase[] = [];
    for (const row of rows) {
      const separator = row.eventType.indexOf(':');
      const gateway = row.eventType.slice(0, separator);
      const saleCode = row.eventType.slice(separator + 1);
      if (separator <= 0 || (gateway !== 'perfectpay' && gateway !== 'cakto') || !saleCode) continue;
      out.push({ id: row.id, gateway, saleCode, payload: row.payload });
    }
    return out;
  }

  /**
   * Reembolso ou chargeback de uma venda que ainda estava guardada esperando a conta: fecha o marcador para o
   * cadastro/login nunca ativar uma compra devolvida. Nunca lança. Devolve quantos marcadores fechou.
   */
  async cancelBeforeAccount(gateway: NoAccountGateway, saleCode: string | null | undefined, reason: string): Promise<number> {
    if (!saleCode) return 0;
    try {
      const { count } = await this.prisma.webhookLog.updateMany({
        where: { provider: NO_ACCOUNT_PROVIDER, eventType: `${gateway}:${saleCode}`, processed: false },
        data: { processed: true, error: `${reason} antes da conta: não aplicar`.slice(0, 500) },
      });
      if (count > 0) {
        this.logger.warn(`Venda ${saleCode} (${gateway}) guardada sem conta foi ${reason}: não será aplicada`);
      }
      return count;
    } catch (error) {
      this.logger.error(`Falha ao fechar a venda guardada ${saleCode} (${gateway}) após ${reason}: ${this.message(error)}`);
      return 0;
    }
  }

  async markApplied(id: string, userId: string): Promise<void> {
    await this.prisma.webhookLog.update({
      where: { id },
      data: { processed: true, error: `aplicada na conta ${userId}` },
    });
  }

  async markFailed(id: string, reason: string): Promise<void> {
    await this.prisma.webhookLog
      .update({ where: { id }, data: { error: reason.slice(0, 500) } })
      .catch((error: unknown) => this.logger.warn(`Não anotei a falha da venda guardada ${id}: ${this.message(error)}`));
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
