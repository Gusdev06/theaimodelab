import { Prisma } from '@prisma/client';

/**
 * Dívida de estorno (TKT-363, opção b).
 *
 * Quando um pack ou uma assinatura é estornado (refund/chargeback) depois de a
 * cliente já ter gastado parte dos créditos, o clawback retira só o que sobra e
 * para em 0. O que faltou recuperar vira DÍVIDA registrada no extrato
 * (credit_transactions com amount 0 e metadata.kind = 'refund_debt'): o saldo
 * nunca fica negativo e a conta nunca é bloqueada. Na próxima concessão PAGA da
 * mesma conta (pack aprovado, assinatura criada ou renovada), a dívida é
 * descontada dos créditos recém-concedidos e a quitação também vai ao extrato
 * (amount negativo, metadata.kind = 'refund_debt_settlement').
 *
 * Bônus grátis, recarga mensal do anual, bônus diário/semanal e ajuste admin não
 * chamam a quitação: só o caminho pago chama.
 *
 * Tudo fica no tipo PURCHASE já existente (sem valor novo de enum = sem SQL).
 *
 * Controlado pela env REFUND_DEBT_CARRYOVER. Vazia, ausente ou qualquer valor que
 * não seja 1/true/on/yes => DESLIGADO (comportamento idêntico ao anterior).
 */
export const REFUND_DEBT_ENV = 'REFUND_DEBT_CARRYOVER';
export const REFUND_DEBT_KIND = 'refund_debt';
export const REFUND_DEBT_SETTLEMENT_KIND = 'refund_debt_settlement';

export type RefundDebtBucket = 'plan' | 'bonus';

export function isRefundDebtCarryoverEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[REFUND_DEBT_ENV];
  if (raw == null) return false;
  return ['1', 'true', 'on', 'yes'].includes(raw.trim().toLowerCase());
}

function positiveIntFromMetadata(metadata: unknown, field: string): number {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    return 0;
  const value = (metadata as Record<string, unknown>)[field];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function metadataKind(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    return null;
  const kind = (metadata as Record<string, unknown>).kind;
  return typeof kind === 'string' ? kind : null;
}

/** Saldo devedor = soma das dívidas − soma das quitações (nunca negativo). */
export function computeOutstandingRefundDebt(
  rows: Array<{ metadata?: unknown }>,
): number {
  let owed = 0;
  let settled = 0;
  for (const row of rows) {
    const kind = metadataKind(row.metadata);
    if (kind === REFUND_DEBT_KIND)
      owed += positiveIntFromMetadata(row.metadata, 'debtCredits');
    else if (kind === REFUND_DEBT_SETTLEMENT_KIND)
      settled += positiveIntFromMetadata(row.metadata, 'settledCredits');
  }
  return Math.max(0, owed - settled);
}

/**
 * Serializa dívida e quitação da MESMA conta: duas compras aprovadas juntas (vendas
 * diferentes, locks de venda diferentes) não podem quitar a mesma dívida duas vezes.
 * Mesmo molde do lock por venda do PaymentsService (advisory lock da transaction).
 */
async function lockUserRefundDebt(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`refund-debt:${userId}`}, 0))`;
}

async function loadOutstandingRefundDebt(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<number> {
  const rows = await tx.creditTransaction.findMany({
    where: {
      userId,
      type: 'PURCHASE',
      OR: [
        { metadata: { path: ['kind'], equals: REFUND_DEBT_KIND } },
        { metadata: { path: ['kind'], equals: REFUND_DEBT_SETTLEMENT_KIND } },
      ],
    },
    select: { metadata: true },
  });
  return computeOutstandingRefundDebt(rows);
}

/**
 * Registra a dívida de um estorno. Idempotente por pagamento estornado: se já existe
 * dívida desta venda, não grava outra. Retorna os créditos registrados (0 = nada).
 */
export async function recordRefundDebt(
  tx: Prisma.TransactionClient,
  params: {
    userId: string;
    paymentId: string;
    externalPaymentId: string;
    debtCredits: number;
    reason: string;
    bucket: RefundDebtBucket;
    granted: number;
    revoked: number;
  },
): Promise<number> {
  const debtCredits = Math.floor(params.debtCredits);
  if (!Number.isFinite(debtCredits) || debtCredits <= 0) return 0;

  await lockUserRefundDebt(tx, params.userId);
  const existing = await tx.creditTransaction.findFirst({
    where: {
      userId: params.userId,
      type: 'PURCHASE',
      paymentId: params.paymentId,
      metadata: { path: ['kind'], equals: REFUND_DEBT_KIND },
    },
    select: { id: true },
  });
  if (existing) return 0;

  await tx.creditTransaction.create({
    data: {
      userId: params.userId,
      type: 'PURCHASE',
      amount: 0,
      source: params.bucket,
      description: `Estorno (${params.reason}): ${debtCredits} créditos já usados serão descontados na próxima compra`,
      paymentId: params.paymentId,
      metadata: {
        kind: REFUND_DEBT_KIND,
        debtCredits,
        reason: params.reason,
        externalPaymentId: params.externalPaymentId,
        granted: params.granted,
        revoked: params.revoked,
      },
    },
  });
  return debtCredits;
}

/**
 * Quita a dívida com os créditos que ACABARAM de ser concedidos por uma venda paga.
 * Chamar dentro da mesma transaction da concessão, depois de creditar o saldo.
 * Desconta no máximo o que foi concedido agora (o saldo antigo não é tocado) e
 * grava a quitação ligada ao pagamento novo. Idempotente por pagamento.
 * Retorna os créditos descontados (0 = nada devido ou já quitado por esta venda).
 */
export async function settleRefundDebt(
  tx: Prisma.TransactionClient,
  params: {
    userId: string;
    paymentId: string;
    grantedCredits: number;
    bucket: RefundDebtBucket;
  },
): Promise<number> {
  const granted = Math.floor(params.grantedCredits);
  if (!Number.isFinite(granted) || granted <= 0) return 0;

  await lockUserRefundDebt(tx, params.userId);
  const alreadySettled = await tx.creditTransaction.findFirst({
    where: {
      userId: params.userId,
      type: 'PURCHASE',
      paymentId: params.paymentId,
      metadata: { path: ['kind'], equals: REFUND_DEBT_SETTLEMENT_KIND },
    },
    select: { id: true },
  });
  if (alreadySettled) return 0;

  const outstanding = await loadOutstandingRefundDebt(tx, params.userId);
  const settle = Math.min(outstanding, granted);
  if (settle <= 0) return 0;

  // A concessão acabou de creditar o saldo nesta transaction (a linha está travada),
  // então o decremento cabe nos créditos recém-concedidos e não deixa o saldo negativo.
  await tx.creditBalance.update({
    where: { userId: params.userId },
    data:
      params.bucket === 'plan'
        ? {
            planCreditsRemaining: { decrement: settle },
            planCreditsUsed: { increment: settle },
          }
        : { bonusCreditsRemaining: { decrement: settle } },
  });
  await tx.creditTransaction.create({
    data: {
      userId: params.userId,
      type: 'PURCHASE',
      amount: -settle,
      source: params.bucket,
      description: `Desconto de ${settle} créditos usados antes de um estorno`,
      paymentId: params.paymentId,
      metadata: {
        kind: REFUND_DEBT_SETTLEMENT_KIND,
        settledCredits: settle,
        outstandingBefore: outstanding,
        outstandingAfter: outstanding - settle,
      },
    },
  });
  return settle;
}
