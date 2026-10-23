import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import {
  computeLegalHold,
  countMinorBlocks,
  minorBlockedGenerationIds,
} from '../../../users/account-erasure.service';
import { ContentSafetyService } from '../../content-safety.service';

/**
 * Retenção LGPD dos eventos da checagem de imagem: foto/resultado barrado e entrada/resultado segurado sem decisão
 * seguram a conta (qualquer data, não ignorável) e a geração (o cron da galeria não apaga); o jurídico libera.
 */

type Row = Record<string, any>;

function fakeDb(events: Row[]) {
  const matches = (event: Row, where: Row): boolean => {
    if (where.userId !== undefined && event.userId !== where.userId)
      return false;
    if (where.kind !== undefined) {
      const kinds: string[] =
        typeof where.kind === 'object' ? where.kind.in : [where.kind];
      if (!kinds.includes(event.kind)) return false;
    }
    if (where.releasedAt === null && event.releasedAt) return false;
    if (
      where.generationId?.in &&
      !where.generationId.in.includes(event.generationId)
    ) {
      return false;
    }
    if (
      where.OR &&
      !(where.OR as Row[]).some((part) => {
        if (part.createdAt) return event.createdAt >= part.createdAt.gte;
        if (part.route)
          return String(event.route).startsWith(part.route.startsWith);
        return false;
      })
    ) {
      return false;
    }
    return true;
  };
  return {
    contentSafetyEvent: {
      findMany: jest.fn(async (args: { where: Row }) =>
        events.filter((event) => matches(event, args.where)),
      ),
    },
    generation: { findMany: jest.fn(async () => []) },
    generationInputImage: { findMany: jest.fn(async () => []) },
  };
}

const NOW = new Date('2026-10-17T12:00:00Z');
const OLD = new Date('2025-01-01T00:00:00Z');

describe('retenção dos eventos da checagem de imagem', () => {
  it('foto barrada e resultado segurado contam como evidência de mídia, em qualquer data', async () => {
    const db = fakeDb([
      {
        userId: 'u1',
        kind: 'IMAGE_MINOR_BLOCKED',
        route: 'input:generate',
        createdAt: OLD,
        generationId: 'g1',
      },
      {
        userId: 'u1',
        kind: 'OUTPUT_HELD',
        route: 'output:sem-censura',
        createdAt: OLD,
        generationId: 'g2',
      },
      // liberado pelo revisor: não segura
      {
        userId: 'u1',
        kind: 'INPUT_HELD',
        route: 'input:generate',
        createdAt: OLD,
        generationId: 'g3',
        releasedAt: NOW,
      },
      // texto do refinador não segura a conta
      {
        userId: 'u1',
        kind: 'REFINER_BLOCKED',
        route: 'refiner:veo3',
        createdAt: NOW,
        generationId: 'g4',
      },
    ]);
    const tally = await countMinorBlocks(db as never, 'u1', NOW);
    expect(tally.provider).toBe(2);
    expect(tally.recent).toBe(0);
  });

  it('caso de texto confirmado pelo revisor segura a conta em qualquer data, fora das tentativas e sem override', async () => {
    const db = fakeDb([
      {
        userId: 'u1',
        kind: 'MINOR_BLOCKED',
        route: 'review:text',
        match: 'REVIEW_CONFIRMED/STRONG',
        excerpt: null,
        createdAt: OLD,
        generationId: 'g1',
      },
      // liberado pelo revisor: não conta
      {
        userId: 'u1',
        kind: 'MINOR_BLOCKED',
        route: 'review:text',
        createdAt: OLD,
        generationId: 'g2',
        releasedAt: NOW,
      },
      // filtro de texto antigo: fora da janela
      {
        userId: 'u1',
        kind: 'MINOR_BLOCKED',
        route: '/api/v1/generations/image',
        createdAt: OLD,
        generationId: null,
      },
    ]);
    const tally = await countMinorBlocks(db as never, 'u1', NOW);
    expect(tally).toMatchObject({ reviewConfirmed: 1, recent: 0, provider: 0 });

    const account = {
      userId: 'u1',
      email: null,
      generations: [],
      posts: [],
      avatarIds: [],
      voiceProfileIds: [],
    };
    const hold = computeLegalHold({
      reports: [],
      account,
      minorBlockedEvents: tally.recent,
      minorBlockedAttempts: tally.recentAttempts,
      providerMinorBlockedEvents: tally.provider,
      reviewConfirmedEvents: tally.reviewConfirmed,
      ignoreSafetyEvents: true,
    });
    expect(hold).toMatchObject({
      active: true,
      kinds: ['review_confirmed'],
      reviewConfirmedEvents: 1,
    });
  });

  it('o cron da galeria não apaga geração com evento de imagem não liberado', async () => {
    const db = fakeDb([
      { kind: 'OUTPUT_MINOR_BLOCKED', generationId: 'g1' },
      { kind: 'INPUT_HELD', generationId: 'g2', releasedAt: NOW },
      { kind: 'MINOR_BLOCKED', generationId: 'g3' },
    ]);
    const held = await minorBlockedGenerationIds(db as never, [
      'g1',
      'g2',
      'g3',
      'g4',
    ]);
    expect([...held].sort()).toEqual(['g1', 'g3']);
  });

  describe('liberação', () => {
    beforeEach(() =>
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
    );
    afterEach(() => jest.restoreAllMocks());

    const prismaWith = (event: Row, generationStatus = 'FAILED') => {
      const order: string[] = [];
      return {
        order,
        contentSafetyEvent: {
          findUnique: jest.fn(async () => event),
          updateMany: jest.fn(async () => {
            order.push('release');
            return { count: 1 };
          }),
        },
        generation: {
          findUnique: jest.fn(async () => ({ status: generationStatus })),
        },
        contentSafetyAccessLog: {
          create: jest.fn(async ({ data }: { data: Row }) => {
            order.push('access_log');
            return { id: 'log-1', ...data };
          }),
        },
      };
    };
    const inputHeld = {
      id: 'e1',
      kind: 'INPUT_HELD',
      route: 'input:generate',
      userId: 'u1',
      generationId: 'g1',
      releasedAt: null,
    };

    it('o revisor designado libera evento de imagem; a trilha é gravada antes de liberar', async () => {
      const prisma = prismaWith(inputHeld);
      const service = new ContentSafetyService(prisma as never);
      await service.releaseMinorBlock(
        'e1',
        'falso positivo conferido pelo revisor',
        { id: 'adm', ip: '203.0.113.4', reviewer: true },
      );
      expect(prisma.contentSafetyEvent.updateMany).toHaveBeenCalledWith({
        where: { id: 'e1', kind: 'INPUT_HELD', releasedAt: null },
        data: expect.objectContaining({ releasedBy: 'adm' }),
      });
      expect(prisma.contentSafetyAccessLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorId: 'adm',
          action: 'release',
          targetType: 'event',
          targetId: 'e1',
          ip: '203.0.113.4',
        }),
      });
      expect(prisma.order).toEqual(['access_log', 'release']);
    });

    it('ADMIN fora da lista de revisores: 403 para evidência de imagem e caso confirmado, nada liberado nem gravado', async () => {
      for (const event of [
        inputHeld,
        { ...inputHeld, kind: 'OUTPUT_MINOR_BLOCKED', route: 'output:x' },
        { ...inputHeld, kind: 'MINOR_BLOCKED', route: 'review:text' },
      ]) {
        const prisma = prismaWith(event);
        const service = new ContentSafetyService(prisma as never);
        await expect(
          service.releaseMinorBlock('e1', 'nota longa o bastante', { id: 'adm' }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma.contentSafetyEvent.updateMany).not.toHaveBeenCalled();
        expect(prisma.contentSafetyAccessLog.create).not.toHaveBeenCalled();
      }
    });

    it('entrada ainda segurada (geração em revisão): 409, decidir pela checagem', async () => {
      const prisma = prismaWith(inputHeld, 'IN_REVIEW');
      const service = new ContentSafetyService(prisma as never);
      await expect(
        service.releaseMinorBlock('e1', 'nota longa o bastante', {
          id: 'adm',
          reviewer: true,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.contentSafetyEvent.updateMany).not.toHaveBeenCalled();
    });

    it('bloqueio de texto/provedor (PR #4): qualquer ADMIN libera, com trilha', async () => {
      const prisma = prismaWith({
        ...inputHeld,
        kind: 'MINOR_BLOCKED',
        route: 'provider:veo3',
      });
      const service = new ContentSafetyService(prisma as never);
      await service.releaseMinorBlock('e1', 'falso positivo do provedor', {
        id: 'adm',
      });
      expect(prisma.contentSafetyEvent.updateMany).toHaveBeenCalled();
      expect(prisma.contentSafetyAccessLog.create).toHaveBeenCalled();
    });

    it('recusa o que não é bloqueio nem retenção (atestado)', async () => {
      const prisma = prismaWith({
        id: 'e2',
        kind: 'CONSENT_ATTESTED',
        releasedAt: null,
      });
      const service = new ContentSafetyService(prisma as never);
      await expect(
        service.releaseMinorBlock('e2', 'nota longa o bastante', { id: 'adm' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
