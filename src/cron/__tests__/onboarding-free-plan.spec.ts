// os helpers de markdown puxam um pacote ESM que o Jest não transforma; aqui nenhum e-mail é renderizado
jest.mock('../../admin-emails/helpers/markdown.helper', () => ({ renderMarkdownToEmailHtml: jest.fn() }));
jest.mock('../../admin-emails/helpers/email-template.helper', () => ({ wrapInBroadcastTemplate: jest.fn() }));

import { OnboardingSequenceService, readFreePlanSince } from '../onboarding-sequence.service';

/**
 * O plano grátis vira assinatura ACTIVE no cadastro: sem a correção, a trilha de conversão nunca envia e a
 * pós-assinatura fala em "assinatura ativa" com quem não pagou. A correção só liga com CONVERSION_TRACK_FREE_PLAN_SINCE.
 */
function setup(env: Record<string, string | undefined>) {
  const userFindMany = jest.fn().mockResolvedValue([]);
  const subscriptionFindMany = jest.fn().mockResolvedValue([]);
  const prisma = { user: { findMany: userFindMany }, subscription: { findMany: subscriptionFindMany } };
  const configService = { get: (key: string) => env[key] };
  const service = new OnboardingSequenceService(prisma as any, {} as any, configService as any, {} as any, {} as any);
  return { service: service as any, userFindMany, subscriptionFindMany };
}

describe('readFreePlanSince', () => {
  it('vazio ou inválido = desligado', () => {
    expect(readFreePlanSince(undefined)).toBeNull();
    expect(readFreePlanSince('')).toBeNull();
    expect(readFreePlanSince('   ')).toBeNull();
    expect(readFreePlanSince('amanhã')).toBeNull();
  });
  it('data ISO = liga a partir dela', () => {
    expect(readFreePlanSince('2026-11-24T03:00:00Z')?.toISOString()).toBe('2026-11-24T03:00:00.000Z');
  });
});

describe('trilhas com o plano grátis', () => {
  it('sem a env, nada muda: conversão exige nenhuma assinatura e a pós-assinatura pega qualquer plano ativo', async () => {
    const { service, userFindMany, subscriptionFindMany } = setup({});
    await service.processConversionTrack('https://app', 'logo');
    await service.processPostSubscriptionTrack('https://app', 'logo');
    expect(userFindMany.mock.calls[0][0].where.subscriptions).toEqual({ none: {} });
    expect(subscriptionFindMany.mock.calls[0][0].where.plan).toBeUndefined();
  });

  it('com a env, conta grátis entra na conversão só a partir da data, e a pós-assinatura fica só com plano pago', async () => {
    const since = '2099-01-01T00:00:00.000Z';
    const { service, userFindMany, subscriptionFindMany } = setup({ CONVERSION_TRACK_FREE_PLAN_SINCE: since });
    await service.processConversionTrack('https://app', 'logo');
    await service.processPostSubscriptionTrack('https://app', 'logo');
    const userWhere = userFindMany.mock.calls[0][0].where;
    expect(userWhere.subscriptions).toEqual({ none: { plan: { slug: { not: 'free' } } } });
    expect(userWhere.createdAt.gte.toISOString()).toBe(since);
    expect(subscriptionFindMany.mock.calls[0][0].where.plan).toEqual({ slug: { not: 'free' } });
  });

  it('com data antiga, vale a janela normal da trilha (sem rajada retroativa)', async () => {
    const { service, userFindMany } = setup({ CONVERSION_TRACK_FREE_PLAN_SINCE: '2020-01-01T00:00:00Z' });
    await service.processConversionTrack('https://app', 'logo');
    const gte: Date = userFindMany.mock.calls[0][0].where.createdAt.gte;
    expect(gte.getTime()).toBeGreaterThan(Date.now() - 30 * 86_400_000);
  });
});
