import { UsersService } from '../users.service';

/**
 * O /users/me diz o gateway da assinatura ativa. O site só oferece o upgrade direto pelo checkout da Perfect Pay a
 * quem já paga lá (a troca cancela a recorrência antiga sozinha); quem paga pela Cakto pagaria duas vezes.
 */
describe('UsersService.getProfile · gateway da assinatura', () => {
  function serviceWith(user: unknown) {
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(user) } };
    const service = Object.assign(Object.create(UsersService.prototype), { prisma }) as UsersService;
    return { service, prisma };
  }

  const baseUser = {
    id: 'u1',
    email: 'a@b.com',
    name: 'A',
    avatarUrl: null,
    role: 'USER',
    emailVerified: true,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    hasCompletedOnboarding: true,
    termsAcceptedAt: null,
    termsVersion: null,
    country: null,
    locale: 'pt-BR',
    currency: 'BRL',
    timezone: null,
    creditBalance: null,
    feedback: null,
    taxId: null,
  };
  const plan = { slug: 'pro', name: 'Pro', priceCents: 3990, maxConcurrentGenerations: 4, hasWatermark: false, hasApiAccess: false };
  const subscription = (paymentProvider: string | null) => ({
    status: 'ACTIVE',
    currentPeriodStart: new Date('2026-11-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
    cancelAtPeriodEnd: false,
    paymentProvider,
    plan,
  });

  it('devolve o gateway da assinatura ativa (perfectpay, cakto…)', async () => {
    for (const provider of ['perfectpay', 'cakto']) {
      const { service } = serviceWith({ ...baseUser, subscriptions: [subscription(provider)] });
      const profile = await service.getProfile('u1');
      expect(profile.subscription?.paymentProvider).toBe(provider);
    }
  });

  it('assinatura antiga sem gateway gravado sai como null; sem assinatura, subscription null', async () => {
    const legacy = await serviceWith({ ...baseUser, subscriptions: [subscription(null)] }).service.getProfile('u1');
    expect(legacy.subscription?.paymentProvider).toBeNull();
    const free = await serviceWith({ ...baseUser, subscriptions: [] }).service.getProfile('u1');
    expect(free.subscription).toBeNull();
  });
});
