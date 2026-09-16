import { PerfectpayWebhookService } from '../perfectpay-webhook.service';

/**
 * Formatos reais de postback da Perfect Pay (amostra de 396 eventos, 2026-09-08).
 * `sale_status_enum_key` é a verdade; enum 6 = cancelled (cartão recusado), 7 = refunded, 9 = charged_back.
 */
const classify = (payload: any) =>
  (Object.create(PerfectpayWebhookService.prototype) as any).classifyEvent(payload);

const sub = (status: string, status_event: string, e: number) => ({
  code: 'PPSUB1',
  status,
  status_event,
  subscription_status_enum: e,
  charges_made: 1,
  next_charge_date: '2026-10-01',
});

describe('PerfectpayWebhookService.classifyEvent (postbacks reais)', () => {
  it('venda aprovada, sem assinatura → paid', () => {
    expect(classify({ sale_status_enum: 2, sale_status_enum_key: 'approved', sale_status_detail: 'approved' })).toBe('paid');
  });

  it('assinatura iniciada / renovada → paid', () => {
    const base = { sale_status_enum: 2, sale_status_enum_key: 'approved', sale_status_detail: 'approved' };
    expect(classify({ ...base, subscription: sub('active', 'subscription_started', 2) })).toBe('paid');
    expect(classify({ ...base, subscription: sub('active', 'subscription_renewed', 2) })).toBe('paid');
  });

  it('cartão recusado com assinatura ainda ativa (PP vai retentar) → ignore, NUNCA refund', () => {
    const recusas = [
      { sale_status_enum: 6, sale_status_enum_key: 'cancelled', sale_status_detail: 'Request not authorized, contact the card administrator and request unlocking. ECOM 64' },
      { sale_status_enum: 6, sale_status_enum_key: 'cancelled', sale_status_detail: 'Transaction not authorized. Please check the entered data.' },
      { sale_status_enum: 5, sale_status_enum_key: 'rejected', sale_status_detail: 'Credit card has no balance.' },
      { sale_status_enum: 5, sale_status_enum_key: 'rejected', sale_status_detail: 'Blocked card, contact the card administrator and request unlocking. ECOM 78' },
    ];
    for (const r of recusas) {
      expect(classify({ ...r, subscription: sub('active', 'subscription_renewed', 2) })).toBe('ignore');
      expect(classify(r)).toBe('ignore');
    }
  });

  it('pendente / expirado / em mediação → ignore', () => {
    expect(classify({ sale_status_enum: 1, sale_status_enum_key: 'pending', sale_status_detail: 'pending' })).toBe('ignore');
    expect(classify({ sale_status_enum: 13, sale_status_enum_key: 'expired', sale_status_detail: 'expired' })).toBe('ignore');
    expect(classify({ sale_status_enum: 4, sale_status_enum_key: 'in_mediation', sale_status_detail: 'pending' })).toBe('ignore');
  });

  it('retentativas esgotadas (subscription_expired) → canceled (acesso até o fim do período)', () => {
    expect(
      classify({ sale_status_enum: 6, sale_status_enum_key: 'cancelled', sale_status_detail: 'Invalid credit card.', subscription: sub('cancelled', 'subscription_expired', 3) }),
    ).toBe('canceled');
    expect(
      classify({ sale_status_enum: 5, sale_status_enum_key: 'rejected', sale_status_detail: 'Credit card has no balance.', subscription: sub('cancelled', 'subscription_expired', 3) }),
    ).toBe('canceled');
  });

  it('assinatura cancelada pelo cliente (mesmo com venda approved) → canceled', () => {
    expect(
      classify({ sale_status_enum: 2, sale_status_enum_key: 'approved', sale_status_detail: 'approved', subscription: sub('cancelled', 'subscription_canceled', 3) }),
    ).toBe('canceled');
  });

  it('reembolso (enum 7) → refund, inclusive quando o detail ainda diz approved', () => {
    expect(classify({ sale_status_enum: 7, sale_status_enum_key: 'refunded', sale_status_detail: 'refunded' })).toBe('refund');
    expect(classify({ sale_status_enum: 7, sale_status_enum_key: 'refunded', sale_status_detail: 'refunded_by_command:CheckCancelSaleChangeStatus' })).toBe('refund');
    expect(classify({ sale_status_enum: 7, sale_status_enum_key: 'refunded', sale_status_detail: 'approved' })).toBe('refund');
  });

  it('chargeback (enum 9) → chargeback', () => {
    expect(classify({ sale_status_enum: 9, sale_status_enum_key: 'charged_back', sale_status_detail: 'charged_back - ethoca' })).toBe('chargeback');
  });

  it('troca de plano → superseded', () => {
    expect(classify({ sale_status_enum: 6, sale_status_enum_key: 'cancelled', sale_status_detail: 'new_subscription_purchased' })).toBe('superseded');
  });

  it('payload antigo sem enum_key cai no enum numérico', () => {
    expect(classify({ sale_status_enum: 2, sale_status_detail: 'approved' })).toBe('paid');
    expect(classify({ sale_status_enum: 7 })).toBe('refund');
    expect(classify({ sale_status_enum: 6 })).toBe('ignore');
  });
});
