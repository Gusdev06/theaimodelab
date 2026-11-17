import { BadRequestException } from '@nestjs/common';
import { PREPAID_REACTIVATE_MESSAGE, SubscriptionsService } from '../subscriptions.service';

/** Pré-pago de 30 dias não tem renovação: "Reativar" não pode tirar o cancelAtPeriodEnd. */
describe('SubscriptionsService.reactivate · pré-pago', () => {
  function make(sub: Record<string, unknown> | null) {
    const prisma = {
      subscription: {
        findFirst: jest.fn(async () => sub),
        update: jest.fn(async ({ data }: any) => ({ ...sub, ...data, scheduledPlan: null })),
      },
    };
    const stripe = { reactivateSubscription: jest.fn(), scheduleSubscriptionPlanChange: jest.fn() };
    const service = new SubscriptionsService(
      prisma as any,
      {} as any,
      stripe as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, prisma, stripe };
  }

  const base = {
    id: 'sub-1',
    userId: 'user-1',
    status: 'ACTIVE',
    cancelAtPeriodEnd: true,
    paymentProvider: 'perfectpay',
    externalSubscriptionId: 'PPCPMT1',
    scheduledPlanId: null,
    currentPeriodStart: new Date('2026-11-17'),
    currentPeriodEnd: new Date('2026-12-17'),
  };

  it('plano -30d: 400 com a mensagem do pré-pago e nada é gravado', async () => {
    const { service, prisma } = make({ ...base, plan: { id: 'p', slug: 'pro-30d', name: 'Pro' } });

    const attempt = service.reactivate('user-1');
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.reactivate('user-1')).rejects.toMatchObject({
      response: { code: 'PREPAID_NO_RENEWAL', message: PREPAID_REACTIVATE_MESSAGE },
    });
    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });

  it('plano recorrente da Perfect Pay: reativa como antes', async () => {
    const { service, prisma } = make({ ...base, plan: { id: 'p', slug: 'pro', name: 'Pro' } });
    jest.spyOn(service as any, 'toResponseDto').mockImplementation((s: any) => s);

    await service.reactivate('user-1');

    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { cancelAtPeriodEnd: false, scheduledPlanId: null } }),
    );
  });
});
