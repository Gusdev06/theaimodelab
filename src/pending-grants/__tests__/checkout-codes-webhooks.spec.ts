import { UnauthorizedException } from '@nestjs/common';
import { PerfectpayWebhookService } from '../perfectpay-webhook.service';
import { CaktoWebhookService } from '../cakto-webhook.service';

/**
 * Vendas com código extra (checkout_codes): produto de outra marca (Funvmake) ou de outra conta do gateway.
 * Sem a tabela, a assinatura só casava pelo nome do plano e o pacote da Perfect Pay virava isca.
 */
const PRO = { id: 'plan-pro', slug: 'pro', name: 'Pro' };
const MEGA = { id: 'pkg-mega', name: 'Mega', credits: 25000 };

function perfectpay(extraTarget: unknown) {
  const paymentsService = {
    activateOrRenewPerfectpaySubscription: jest.fn(async () => ({ processed: true })),
    processCreditPurchase: jest.fn(async () => undefined),
  };
  const pendingGrantsService = { createPending: jest.fn(async () => ({ created: true })) };
  const prisma = {
    user: { findUnique: jest.fn(async () => ({ id: 'user-1', referredByCode: null })) },
    plan: {
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => {
        throw new Error('não deveria cair no casamento por nome');
      }),
    },
    creditPackage: { findFirst: jest.fn(async () => null) },
  };
  const checkoutCodes = { findSaleTarget: jest.fn(async () => extraTarget) };
  const config = { get: jest.fn((key: string) => (key === 'PERFECTPAY_WEBHOOK_TOKEN' ? 'tok' : undefined)) };
  const service = new PerfectpayWebhookService(
    config as any,
    pendingGrantsService as any,
    { create: jest.fn(async () => ({})) } as any,
    { sendPendingGrantsEmailEs: jest.fn(async () => undefined) } as any,
    prisma as any,
    paymentsService as any,
    checkoutCodes as any,
  );
  return { service, paymentsService, pendingGrantsService, checkoutCodes };
}

const approved = (extra: Record<string, unknown> = {}) => ({
  token: 'tok',
  code: 'PPSALE1',
  sale_amount: 39.9,
  sale_status_enum: 2,
  sale_status_enum_key: 'approved',
  sale_status_detail: 'approved',
  customer: { email: 'buyer@mail.com' },
  plan: { code: 'PPFUNVPRO', name: 'Funvmake Pro' },
  ...extra,
});

describe('Perfect Pay · venda com código extra', () => {
  it('assinatura de outra marca ativa o plano certo, sem casar pelo nome', async () => {
    const { service, paymentsService, checkoutCodes } = perfectpay({ kind: 'plan', plan: PRO });

    const result = await service.handle(
      approved({
        subscription: { code: 'PPSUB9', status: 'active', status_event: 'subscription_started', subscription_status_enum: 2, charges_made: 1 },
      }),
    );

    expect(result.processed).toBe(true);
    expect(checkoutCodes.findSaleTarget).toHaveBeenCalledWith('perfectpay', expect.arrayContaining(['PPFUNVPRO']), {
      activePlanOnly: true,
    });
    expect(paymentsService.activateOrRenewPerfectpaySubscription).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', planId: 'plan-pro', saleCode: 'perfectpay-PPSALE1' }),
    );
  });

  it('pacote de outra marca credita o pacote e NÃO vira isca', async () => {
    const { service, paymentsService, pendingGrantsService } = perfectpay({ kind: 'package', creditPackage: MEGA });

    const result = await service.handle(approved({ plan: { code: 'PPFUNVMEGA', name: 'Mega' } }));

    expect(result.processed).toBe(true);
    expect(paymentsService.processCreditPurchase).toHaveBeenCalledWith(
      'user-1',
      'pkg-mega',
      expect.any(Number),
      'perfectpay-PPSALE1',
      expect.anything(),
      undefined,
      'perfectpay',
    );
    expect(pendingGrantsService.createPending).not.toHaveBeenCalled();
  });

  it('sem código extra o comportamento é o de sempre (produto desconhecido = isca)', async () => {
    const { service, pendingGrantsService, paymentsService } = perfectpay(null);

    await service.handle(approved({ plan: { code: 'PPISCA', name: 'Pack 300' } }));

    expect(pendingGrantsService.createPending).toHaveBeenCalled();
    expect(paymentsService.processCreditPurchase).not.toHaveBeenCalled();
  });
});

function cakto(extraTarget: unknown, secrets: Record<string, string | undefined>) {
  const paymentsService = { processCreditPurchase: jest.fn(async () => undefined) };
  const prisma = {
    user: { findUnique: jest.fn(async () => ({ id: 'user-2', referredByCode: null })) },
    plan: { findFirst: jest.fn(async () => null) },
    creditPackage: { findFirst: jest.fn(async () => null) },
  };
  const checkoutCodes = { findSaleTarget: jest.fn(async () => extraTarget) };
  const config = { get: jest.fn((key: string) => secrets[key]) };
  const service = new CaktoWebhookService(
    config as any,
    { create: jest.fn(async () => ({})) } as any,
    prisma as any,
    paymentsService as any,
    checkoutCodes as any,
  );
  return { service, paymentsService, checkoutCodes };
}

const caktoSale = (secret: string) => ({
  secret,
  event: 'purchase_approved',
  data: {
    id: 'order-77',
    status: 'paid',
    amount: 109.9,
    offer: { id: 'fvm4ega', name: 'Mega' },
    customer: { email: 'b@x.com' },
  },
});

describe('Cakto · código extra e segredo de outra conta', () => {
  const SECRETS = { CAKTO_WEBHOOK_SECRET: 's-principal', CAKTO_WEBHOOK_EXTRA_SECRETS: 's-conta-nova, s-outra' };

  it('pacote vendido em outra conta (segredo extra) é creditado', async () => {
    const { service, paymentsService, checkoutCodes } = cakto({ kind: 'package', creditPackage: MEGA }, SECRETS);

    const result = await service.handle(caktoSale('s-conta-nova'));

    expect(result.processed).toBe(true);
    expect(checkoutCodes.findSaleTarget).toHaveBeenCalledWith('cakto', expect.arrayContaining(['fvm4ega']), {
      activePlanOnly: false,
    });
    expect(paymentsService.processCreditPurchase).toHaveBeenCalledWith(
      'user-2',
      'pkg-mega',
      expect.any(Number),
      expect.stringContaining('order-77'),
      expect.anything(),
      undefined,
      'cakto',
    );
  });

  it('o segredo principal continua valendo e um segredo errado é recusado', async () => {
    const ok = cakto({ kind: 'package', creditPackage: MEGA }, SECRETS);
    await expect(ok.service.handle(caktoSale('s-principal'))).resolves.toMatchObject({ processed: true });

    const bad = cakto({ kind: 'package', creditPackage: MEGA }, SECRETS);
    await expect(bad.service.handle(caktoSale('s-errado'))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('só com o segredo principal (sem extras) segue igual a hoje', async () => {
    const only = cakto(null, { CAKTO_WEBHOOK_SECRET: 's-principal' });
    await expect(only.service.handle(caktoSale('s-principal'))).resolves.toMatchObject({ processed: false });
    await expect(only.service.handle(caktoSale('s-conta-nova'))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
