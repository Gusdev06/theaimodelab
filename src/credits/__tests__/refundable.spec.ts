import { computeRefundable } from '../refundable';

const debit = (source: 'plan' | 'bonus', amount: number) => ({
  type: 'GENERATION_DEBIT',
  source,
  amount: -amount,
});
const refund = (source: 'plan' | 'bonus', amount: number) => ({
  type: 'GENERATION_REFUND',
  source,
  amount,
});

describe('computeRefundable (TKT-096 / TKT-111)', () => {
  it('sem débito registrado não há o que devolver (nada de bônus do nada)', () => {
    expect(computeRefundable([], 500)).toBeNull();
    expect(computeRefundable([refund('bonus', 500)], 500)).toBeNull();
  });

  it('devolve para as fontes originais', () => {
    expect(computeRefundable([debit('plan', 600), debit('bonus', 400)], 1000)).toEqual({
      plan: 600,
      bonus: 400,
    });
  });

  it('abate o que já foi estornado: segundo estorno é no-op', () => {
    const ledger = [debit('plan', 600), debit('bonus', 400), refund('plan', 600), refund('bonus', 400)];
    expect(computeRefundable(ledger, 1000)).toEqual({ plan: 0, bonus: 0 });
  });

  it('estorno parcial anterior (modelo alternativo mais barato) reduz o restante', () => {
    const ledger = [debit('plan', 1920), refund('plan', 570)];
    expect(computeRefundable(ledger, 1350)).toEqual({ plan: 1350, bonus: 0 });
  });

  it('creditsConsumed é o teto; o excedente sai primeiro do bônus', () => {
    expect(computeRefundable([debit('plan', 300), debit('bonus', 300)], 400)).toEqual({
      plan: 300,
      bonus: 100,
    });
    expect(computeRefundable([debit('plan', 300), debit('bonus', 300)], 200)).toEqual({
      plan: 200,
      bonus: 0,
    });
  });

  it('teto inválido vira zero', () => {
    expect(computeRefundable([debit('plan', 300)], Number.NaN)).toEqual({ plan: 0, bonus: 0 });
  });
});
