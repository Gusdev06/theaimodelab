import { Injectable, Logger } from '@nestjs/common';
import { NoAccountPurchasesService } from './no-account-purchases.service';
import { PerfectpayWebhookService } from './perfectpay-webhook.service';
import { CaktoWebhookService } from './cakto-webhook.service';

/**
 * Aplica, no cadastro e no login, as vendas pagas que chegaram antes de existir conta com o e-mail (B-01).
 * Reprocessa pelo mesmo handler do webhook; a idempotência é a do pagamento (código da venda =
 * Payment.externalPaymentId, com lock), então chamar 2× (login + refresh, duas abas) nunca credita 2×.
 */
@Injectable()
export class NoAccountPurchasesClaimer {
  private readonly logger = new Logger(NoAccountPurchasesClaimer.name);
  /** E-mails em reprocesso nesta instância: evita trabalho repetido quando login e refresh chegam juntos. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly purchases: NoAccountPurchasesService,
    private readonly perfectpay: PerfectpayWebhookService,
    private readonly cakto: CaktoWebhookService,
  ) {}

  async claimForUser(user: { id: string; email: string }): Promise<{ applied: number; failed: number }> {
    const email = NoAccountPurchasesService.normalizeEmail(user.email);
    if (this.inFlight.has(email)) return { applied: 0, failed: 0 };
    this.inFlight.add(email);
    let applied = 0;
    let failed = 0;
    try {
      const pending = await this.purchases.pendingFor(email);
      for (const purchase of pending) {
        try {
          const result =
            purchase.gateway === 'perfectpay'
              ? await this.perfectpay.replayPaidSale(purchase.payload)
              : await this.cakto.replayPaidSale(purchase.payload);
          // 'duplicate sale' = a venda já tinha entrado (outra aba/instância): conta como aplicada.
          if (result.processed || result.reason === 'duplicate sale') {
            await this.purchases.markApplied(purchase.id, user.id);
            applied++;
            this.logger.log(`Venda ${purchase.saleCode} (${purchase.gateway}) aplicada na conta ${user.id}`);
          } else {
            failed++;
            await this.purchases.markFailed(purchase.id, `reprocesso: ${result.reason ?? 'não processado'}`);
            this.logger.warn(`Venda ${purchase.saleCode} guardada não aplicada para ${user.id}: ${result.reason ?? 'n/a'}`);
          }
        } catch (error) {
          failed++;
          const message = error instanceof Error ? error.message : String(error);
          await this.purchases.markFailed(purchase.id, `reprocesso falhou: ${message}`);
          this.logger.error(`Venda ${purchase.saleCode} guardada falhou ao aplicar para ${user.id}: ${message}`);
        }
      }
    } finally {
      this.inFlight.delete(email);
    }
    return { applied, failed };
  }
}
