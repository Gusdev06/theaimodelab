export interface LedgerRow {
  type: string;
  source: string;
  amount: number;
}

export interface Refundable {
  plan: number;
  bonus: number;
}

/**
 * Quanto ainda pode ser estornado de uma geração, por fonte (plano/bônus).
 *
 *  - Sem GENERATION_DEBIT → `null`: não houve cobrança, não há o que devolver
 *    (antes isso virava crédito em bônus do nada — TKT-096).
 *  - Estornos já registrados (GENERATION_REFUND) abatem o débito: um segundo
 *    estorno da mesma geração vira no-op (TKT-111).
 *  - `cap` (creditsConsumed) é o teto; o excedente sai primeiro do bônus.
 */
export function computeRefundable(
  ledger: LedgerRow[],
  cap: number,
  types: { debit: string; refund: string } = {
    debit: 'GENERATION_DEBIT',
    refund: 'GENERATION_REFUND',
  },
): Refundable | null {
  const debits = ledger.filter((row) => row.type === types.debit);
  if (debits.length === 0) return null;
  const refunds = ledger.filter((row) => row.type === types.refund);

  const sumBySource = (rows: LedgerRow[], source: string): number =>
    rows
      .filter((row) => row.source === source)
      .reduce((total, row) => total + Math.abs(row.amount), 0);

  let plan = Math.max(
    0,
    sumBySource(debits, 'plan') - sumBySource(refunds, 'plan'),
  );
  let bonus = Math.max(
    0,
    sumBySource(debits, 'bonus') - sumBySource(refunds, 'bonus'),
  );

  const limit = Math.max(0, Math.floor(Number.isFinite(cap) ? cap : 0));
  if (plan + bonus > limit) {
    const over = plan + bonus - limit;
    const fromBonus = Math.min(bonus, over);
    bonus -= fromBonus;
    plan -= over - fromBonus;
  }
  return { plan, bonus };
}
