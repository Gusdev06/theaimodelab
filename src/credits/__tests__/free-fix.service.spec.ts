import { GenerationStatus, GenerationType, Resolution } from '@prisma/client';
import {
  FREE_FIX_UNLOCKED_IMAGE_REQUEST,
  FreeFixService,
  type FreeFixRequest,
} from '../free-fix.service';

/**
 * 1ª correção grátis da foto Unlocked (dono 20/11/2026): cada regra (1 a 7) derruba a elegibilidade sozinha.
 * O teto (regra 5) é a conta do prejuízo zero: sem ele o Pro com afiliado de 30% fica negativo no pior caso.
 */
describe('FreeFixService · 1ª correção grátis do Unlocked', () => {
  const NOW = new Date('2026-11-20T12:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;
  const ORIGINAL_FLAG = process.env.FREE_FIX_UNLOCKED;

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.FREE_FIX_UNLOCKED;
    else process.env.FREE_FIX_UNLOCKED = ORIGINAL_FLAG;
  });

  type Origin = {
    status: GenerationStatus;
    type: GenerationType;
    modelUsed: string;
    createdAt: Date;
    creditsConsumed: number;
    usedFreeGeneration: boolean;
    resolution: Resolution;
  };

  const paidOrigin = (overrides: Partial<Origin> = {}): Origin => ({
    status: GenerationStatus.COMPLETED,
    type: GenerationType.IMAGE_TO_IMAGE,
    modelUsed: 'sem-censura',
    createdAt: new Date(NOW.getTime() - 2 * DAY),
    creditsConsumed: 40,
    usedFreeGeneration: false,
    resolution: Resolution.RES_2K,
    ...overrides,
  });

  function make(
    opts: {
      origin?: Origin | null;
      originFixes?: number;
      fixesLast24h?: number;
      fixesLast30d?: number;
      paidUnlocked30d?: number;
      annual?: boolean;
      firstClaimId?: string | null;
    } = {},
  ) {
    const findFirst = jest.fn(async (args: any) => {
      if (args.orderBy) {
        return opts.firstClaimId === null
          ? null
          : { id: opts.firstClaimId ?? 'gen-new' };
      }
      if (args.where.userId !== 'u-1') return null;
      return opts.origin === undefined ? paidOrigin() : opts.origin;
    });
    const count = jest.fn(async (args: any) => {
      const where = args.where;
      if (where.AND) return opts.originFixes ?? 0;
      if (where.modelUsed) return opts.paidUnlocked30d ?? 10;
      const since: Date = where.createdAt.gte;
      return NOW.getTime() - since.getTime() <= DAY
        ? (opts.fixesLast24h ?? 0)
        : (opts.fixesLast30d ?? 0);
    });
    const subscriptionFindFirst = jest.fn(async () =>
      opts.annual ? { id: 'sub-anual' } : null,
    );
    const prisma = {
      generation: { findFirst, count },
      subscription: { findFirst: subscriptionFindFirst },
    };
    return {
      service: new FreeFixService(prisma as any),
      findFirst,
      count,
      subscriptionFindFirst,
    };
  }

  const check = (
    service: FreeFixService,
    request: FreeFixRequest = FREE_FIX_UNLOCKED_IMAGE_REQUEST,
    originId: string | null = 'gen-origem',
  ) => service.checkEligibility('u-1', originId, request, NOW);

  it('tudo certo: elegível, sem motivo', async () => {
    const { service } = make();
    await expect(check(service)).resolves.toEqual({
      eligible: true,
      reason: null,
    });
  });

  describe('regra 1 · geração nova de imagem no Unlocked, com a origem', () => {
    it('sem fix_of_generation_id: não elegível', async () => {
      const { service, findFirst } = make();
      await expect(
        check(service, FREE_FIX_UNLOCKED_IMAGE_REQUEST, null),
      ).resolves.toEqual({
        eligible: false,
        reason: 'missing_origin',
      });
      expect(findFirst).not.toHaveBeenCalled();
    });

    it('outro modelo (Nano Banana Pro): não elegível', async () => {
      const { service } = make();
      const result = await check(service, {
        type: GenerationType.IMAGE_TO_IMAGE,
        model: 'gemini-3-pro-image-preview',
        modelVariant: 'NBP',
      });
      expect(result).toEqual({
        eligible: false,
        reason: 'not_unlocked_request',
      });
    });

    it('troca de rosto Unlocked (FACE_SWAP) não é foto: não elegível', async () => {
      const { service } = make();
      const result = await check(service, {
        type: GenerationType.FACE_SWAP,
        modelVariant: 'SEM_CENSURA',
      });
      expect(result.reason).toBe('not_unlocked_request');
    });

    it('estimativa só com a variante SEM_CENSURA (sem model) vale', async () => {
      const { service } = make();
      const result = await check(service, {
        type: GenerationType.IMAGE_TO_IMAGE,
        modelVariant: 'SEM_CENSURA',
      });
      expect(result.eligible).toBe(true);
    });
  });

  describe('regra 2 · origem do mesmo usuário, concluída, Unlocked, imagem, até 7 dias, paga', () => {
    it('geração de outro usuário (ou inexistente): not_found', async () => {
      const { service } = make();
      const result = await service.checkEligibility(
        'u-2',
        'gen-origem',
        FREE_FIX_UNLOCKED_IMAGE_REQUEST,
        NOW,
      );
      expect(result).toEqual({ eligible: false, reason: 'not_found' });
    });

    it('origem que falhou: não elegível', async () => {
      const { service } = make({
        origin: paidOrigin({ status: GenerationStatus.FAILED }),
      });
      expect((await check(service)).reason).toBe('origin_not_completed');
    });

    it('origem em outro modelo (inclusive o resgate sem-censura-fallback): não elegível', async () => {
      for (const modelUsed of ['nano-banana-pro', 'sem-censura-fallback']) {
        const { service } = make({ origin: paidOrigin({ modelUsed }) });
        expect((await check(service)).reason).toBe('origin_not_unlocked');
      }
    });

    it('origem que não é foto: não elegível', async () => {
      const { service } = make({
        origin: paidOrigin({ type: GenerationType.FACE_SWAP }),
      });
      expect((await check(service)).reason).toBe('origin_not_image');
    });

    it('origem com mais de 7 dias: não elegível; com 7 dias exatos, elegível', async () => {
      const old = make({
        origin: paidOrigin({
          createdAt: new Date(NOW.getTime() - 7 * DAY - 1),
        }),
      });
      expect((await check(old.service)).reason).toBe('origin_too_old');
      const edge = make({
        origin: paidOrigin({ createdAt: new Date(NOW.getTime() - 7 * DAY) }),
      });
      expect((await check(edge.service)).eligible).toBe(true);
    });

    it('origem grátis (geração grátis, ilimitado ou outra correção grátis): não elegível', async () => {
      const freeGen = make({
        origin: paidOrigin({ usedFreeGeneration: true }),
      });
      expect((await check(freeGen.service)).reason).toBe('origin_not_paid');
      const zeroCredits = make({ origin: paidOrigin({ creditsConsumed: 0 }) });
      expect((await check(zeroCredits.service)).reason).toBe('origin_not_paid');
    });

    it('correção em resolução maior que a origem paga (4K sobre 2K): não elegível, cobra normal', async () => {
      const { service, findFirst } = make();
      const above = await check(service, {
        ...FREE_FIX_UNLOCKED_IMAGE_REQUEST,
        resolution: Resolution.RES_4K,
      });
      expect(above).toEqual({
        eligible: false,
        reason: 'resolution_above_origin',
      });
      expect(findFirst.mock.calls[0][0].select).toMatchObject({
        resolution: true,
      });
      const same = await check(service, {
        ...FREE_FIX_UNLOCKED_IMAGE_REQUEST,
        resolution: Resolution.RES_2K,
      });
      expect(same.eligible).toBe(true);
      const fourK = make({ origin: paidOrigin({ resolution: Resolution.RES_4K }) });
      const below = await check(fourK.service, {
        ...FREE_FIX_UNLOCKED_IMAGE_REQUEST,
        resolution: Resolution.RES_2K,
      });
      expect(below.eligible).toBe(true);
    });
  });

  describe('regra 3 · a origem nunca teve correção grátis', () => {
    it('já corrigida de graça: não elegível (vínculo em parameters.freeFixOf)', async () => {
      const { service, count } = make({ originFixes: 1 });
      expect((await check(service)).reason).toBe('origin_already_fixed');
      const where = count.mock.calls[0][0].where;
      expect(where.AND).toEqual([
        { parameters: { path: ['freeFixOf'], equals: 'gen-origem' } },
      ]);
      expect(where.parameters).toEqual({ path: ['freeFix'], equals: true });
      expect(where.status).toEqual({ not: GenerationStatus.FAILED });
    });
  });

  describe('regra 4 · máximo 1 por dia', () => {
    it('já teve correção grátis nas últimas 24 h: não elegível', async () => {
      const { service } = make({ fixesLast24h: 1 });
      expect((await check(service)).reason).toBe('daily_limit');
    });
  });

  describe('regra 5 · teto de 1 a cada 10 fotos Unlocked pagas em 30 dias', () => {
    it('9 pagas: teto 0, não elegível', async () => {
      const { service } = make({ paidUnlocked30d: 9 });
      expect((await check(service)).reason).toBe('monthly_cap');
    });

    it('20 pagas e 2 correções grátis no mês: não elegível', async () => {
      const { service } = make({ paidUnlocked30d: 20, fixesLast30d: 2 });
      expect((await check(service)).reason).toBe('monthly_cap');
    });

    it('20 pagas e 1 correção grátis no mês: elegível', async () => {
      const { service } = make({ paidUnlocked30d: 20, fixesLast30d: 1 });
      expect((await check(service)).eligible).toBe(true);
    });

    it('conta só Unlocked de imagem, concluída e paga', async () => {
      const { service, count } = make();
      await check(service);
      const paidCall = count.mock.calls.find(([args]) => args.where.modelUsed)!;
      expect(paidCall[0].where).toMatchObject({
        userId: 'u-1',
        modelUsed: { in: ['sem-censura'] },
        status: GenerationStatus.COMPLETED,
        creditsConsumed: { gt: 0 },
        usedFreeGeneration: false,
        type: {
          in: [GenerationType.TEXT_TO_IMAGE, GenerationType.IMAGE_TO_IMAGE],
        },
      });
    });
  });

  describe('regra 6 · plano anual fora', () => {
    it('com assinatura anual: não elegível', async () => {
      const { service, subscriptionFindFirst } = make({ annual: true });
      expect((await check(service)).reason).toBe('annual_plan');
      const where = (subscriptionFindFirst.mock.calls[0] as any[])[0].where;
      expect(where.plan).toEqual({ billingInterval: { not: 'month' } });
    });
  });

  describe('regra 7 · FREE_FIX_UNLOCKED=off desliga tudo', () => {
    it('off: não elegível e nem consulta o banco', async () => {
      process.env.FREE_FIX_UNLOCKED = 'off';
      const { service, findFirst, count } = make();
      expect(await check(service)).toEqual({
        eligible: false,
        reason: 'disabled',
      });
      expect(findFirst).not.toHaveBeenCalled();
      expect(count).not.toHaveBeenCalled();
    });

    it('sem a env (padrão): ligado', async () => {
      delete process.env.FREE_FIX_UNLOCKED;
      const { service } = make();
      expect((await check(service)).eligible).toBe(true);
    });
  });

  describe('confirmClaim · dois pedidos ao mesmo tempo', () => {
    it('a primeira correção grátis fica grátis', async () => {
      const { service } = make({ firstClaimId: 'gen-new' });
      await expect(
        service.confirmClaim('u-1', 'gen-new', 'gen-origem', NOW),
      ).resolves.toBe(true);
    });

    it('a segunda perde a vez (paga normal)', async () => {
      const { service, findFirst } = make({ firstClaimId: 'gen-outra' });
      await expect(
        service.confirmClaim('u-1', 'gen-new', 'gen-origem', NOW),
      ).resolves.toBe(false);
      expect(findFirst.mock.calls[0][0].orderBy).toEqual([
        { createdAt: 'asc' },
        { id: 'asc' },
      ]);
    });
  });
});
