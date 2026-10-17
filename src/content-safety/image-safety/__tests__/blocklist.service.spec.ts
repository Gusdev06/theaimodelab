import { PrismaService } from '../../../prisma/prisma.service';
import { BlocklistService } from '../blocklist.service';
import { PHASH_ALGORITHM } from '../phash';
import { SafetyProviderUnavailableError } from '../types';

/**
 * Lista de bloqueio própria com o Prisma simulado (padrão dos specs atuais). Só hashes inventados.
 */

const SHA_A = 'a'.repeat(64);
const PHASH_BASE = 'ffff0000ffff0000';
/** PHASH_BASE com os 3 últimos bits trocados (distância 3) */
const PHASH_NEAR = 'ffff0000ffff0007';
/** distância 8 de PHASH_BASE (o corte padrão) */
const PHASH_AT_LIMIT = 'ffff0000ffff00ff';
/** distância 9 de PHASH_BASE */
const PHASH_OVER_LIMIT = 'ffff0000ffff01ff';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makePrisma() {
  return {
    contentHashBlock: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'novo' }),
    },
    contentSafetyScan: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

type PrismaMock = ReturnType<typeof makePrisma>;

function makeService(prisma: PrismaMock) {
  return new BlocklistService(prisma as unknown as PrismaService);
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe('BlocklistService', () => {
  let prisma: PrismaMock;
  let service: BlocklistService;

  beforeEach(() => {
    prisma = makePrisma();
    service = makeService(prisma);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('match', () => {
    it('acerto exato por sha256 vem primeiro, com distância 0 e a força da linha', async () => {
      prisma.contentHashBlock.findFirst.mockResolvedValueOnce({
        id: 'blk-1',
        strength: 'STRONG',
      });
      const match = await service.match(PHASH_BASE, SHA_A.toUpperCase(), 8);
      expect(match).toEqual({
        source: 'blocklist',
        matcher: 'sha256',
        distance: 0,
        blockId: 'blk-1',
        strength: 'STRONG',
      });
      expect(prisma.contentHashBlock.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            sha256: SHA_A,
            revokedAt: null,
            strength: { in: ['STRONG', 'MEDIUM'] },
          },
        }),
      );
      // achou pelo sha256: nem carrega a lista de pHash
      expect(prisma.contentHashBlock.findMany).not.toHaveBeenCalled();
    });

    it('sem sha256 na lista: o pHash mais perto dentro do corte', async () => {
      prisma.contentHashBlock.findMany.mockResolvedValueOnce([
        { id: 'longe', phash: '0000ffff0000ffff', strength: 'STRONG' },
        { id: 'perto', phash: PHASH_NEAR, strength: 'MEDIUM' },
        { id: 'no-corte', phash: PHASH_AT_LIMIT, strength: 'STRONG' },
      ]);
      const match = await service.match(PHASH_BASE, SHA_A, 8);
      expect(match).toEqual({
        source: 'blocklist',
        matcher: PHASH_ALGORITHM,
        distance: 3,
        blockId: 'perto',
        strength: 'MEDIUM',
      });
      // só linhas ativas e que barram
      expect(prisma.contentHashBlock.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { revokedAt: null, strength: { in: ['STRONG', 'MEDIUM'] } },
        }),
      );
    });

    it('o corte é inclusivo (distância igual ao máximo acerta; uma acima, não)', async () => {
      prisma.contentHashBlock.findMany.mockResolvedValue([
        { id: 'no-corte', phash: PHASH_AT_LIMIT, strength: 'MEDIUM' },
      ]);
      expect(await service.match(PHASH_BASE, null, 8)).toMatchObject({
        blockId: 'no-corte',
        distance: 8,
      });
      expect(await service.match(PHASH_BASE, null, 7)).toBeNull();

      const other = makePrisma();
      other.contentHashBlock.findMany.mockResolvedValue([
        { id: 'acima', phash: PHASH_OVER_LIMIT, strength: 'STRONG' },
      ]);
      expect(await makeService(other).match(PHASH_BASE, null, 8)).toBeNull();
    });

    it('empate de distância: vale a força maior', async () => {
      prisma.contentHashBlock.findMany.mockResolvedValueOnce([
        { id: 'medio', phash: PHASH_NEAR, strength: 'MEDIUM' },
        { id: 'forte', phash: PHASH_NEAR, strength: 'STRONG' },
      ]);
      expect(await service.match(PHASH_BASE, null, 8)).toMatchObject({
        blockId: 'forte',
        strength: 'STRONG',
      });
    });

    it('pHash em maiúsculas é lido como o gravado (minúsculo)', async () => {
      prisma.contentHashBlock.findMany.mockResolvedValueOnce([
        { id: 'blk', phash: PHASH_BASE, strength: 'STRONG' },
      ]);
      expect(
        await service.match(PHASH_BASE.toUpperCase(), null, 8),
      ).toMatchObject({ blockId: 'blk', distance: 0 });
    });

    it('sem hash nenhum: não está na lista, sem consultar o banco', async () => {
      expect(await service.match(null, null, 8)).toBeNull();
      expect(prisma.contentHashBlock.findFirst).not.toHaveBeenCalled();
      expect(prisma.contentHashBlock.findMany).not.toHaveBeenCalled();
    });

    it('hash malformado fecha (indisponível), nunca responde "não está na lista"', async () => {
      for (const [phash, sha256] of [
        ['nao-e-hash', null],
        [PHASH_BASE, 'curto'],
      ] as const) {
        const error = await caught(service.match(phash, sha256, 8));
        expect(error).toBeInstanceOf(SafetyProviderUnavailableError);
        expect(error).toMatchObject({ provider: 'blocklist' });
      }
    });

    it('banco fora do ar: indisponível, nunca "não está na lista"', async () => {
      prisma.contentHashBlock.findFirst.mockRejectedValueOnce(
        new Error('conexão recusada'),
      );
      const exact = await caught(service.match(PHASH_BASE, SHA_A, 8));
      expect(exact).toMatchObject({
        provider: 'blocklist',
        failure: 'server_error',
      });

      prisma.contentHashBlock.findMany.mockRejectedValueOnce(
        new Error('conexão recusada'),
      );
      const near = await caught(service.match(PHASH_BASE, null, 8));
      expect(near).toBeInstanceOf(SafetyProviderUnavailableError);
    });

    it('cache de 60 s: a lista é lida uma vez e recarregada depois do prazo', async () => {
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      prisma.contentHashBlock.findMany.mockResolvedValue([
        { id: 'blk', phash: PHASH_NEAR, strength: 'STRONG' },
      ]);
      await service.match(PHASH_BASE, null, 8);
      await service.match(PHASH_BASE, null, 8);
      expect(prisma.contentHashBlock.findMany).toHaveBeenCalledTimes(1);
      now += 59_000;
      await service.match(PHASH_BASE, null, 8);
      expect(prisma.contentHashBlock.findMany).toHaveBeenCalledTimes(1);
      now += 2_000;
      await service.match(PHASH_BASE, null, 8);
      expect(prisma.contentHashBlock.findMany).toHaveBeenCalledTimes(2);
    });

    it('checagens ao mesmo tempo dividem a mesma leitura', async () => {
      const load = deferred<unknown[]>();
      prisma.contentHashBlock.findMany.mockReturnValueOnce(load.promise);
      const first = service.match(PHASH_BASE, null, 8);
      const second = service.match(PHASH_BASE, null, 8);
      load.resolve([{ id: 'blk', phash: PHASH_BASE, strength: 'STRONG' }]);
      expect(await first).toMatchObject({ blockId: 'blk' });
      expect(await second).toMatchObject({ blockId: 'blk' });
      expect(prisma.contentHashBlock.findMany).toHaveBeenCalledTimes(1);
    });

    it('bloqueio novo invalida o cache, inclusive uma leitura que já estava em curso', async () => {
      const staleLoad = deferred<unknown[]>();
      prisma.contentHashBlock.findMany.mockReturnValueOnce(staleLoad.promise);
      const during = service.match(PHASH_BASE, null, 8);
      await service.add({
        phash: PHASH_BASE,
        sha256: null,
        strength: 'STRONG',
        origin: 'input',
        eventId: null,
      });
      staleLoad.resolve([]);
      expect(await during).toBeNull();

      prisma.contentHashBlock.findMany.mockResolvedValueOnce([
        { id: 'novo', phash: PHASH_BASE, strength: 'STRONG' },
      ]);
      expect(await service.match(PHASH_BASE, null, 8)).toMatchObject({
        blockId: 'novo',
      });
      expect(prisma.contentHashBlock.findMany).toHaveBeenCalledTimes(2);
    });
  });

  describe('add', () => {
    it('grava forte ou médio com origem e evento', async () => {
      const id = await service.add({
        phash: PHASH_BASE.toUpperCase(),
        sha256: SHA_A.toUpperCase(),
        strength: 'MEDIUM',
        origin: 'output',
        eventId: 'evt-9',
      });
      expect(id).toBe('novo');
      expect(prisma.contentHashBlock.create).toHaveBeenCalledWith({
        data: {
          phash: PHASH_BASE,
          sha256: SHA_A,
          strength: 'MEDIUM',
          origin: 'output',
          eventId: 'evt-9',
        },
        select: { id: true },
      });
    });

    it('o caso leve nunca entra (e nem a força nenhuma)', async () => {
      for (const strength of ['LIGHT', 'NONE']) {
        await expect(
          service.add({
            phash: PHASH_BASE,
            sha256: null,
            strength: strength as 'STRONG',
            origin: 'input',
            eventId: null,
          }),
        ).rejects.toThrow('só sinal forte ou médio');
      }
      expect(prisma.contentHashBlock.create).not.toHaveBeenCalled();
    });

    it('recusa pHash, sha256 e origem inválidos', async () => {
      const valid = {
        phash: PHASH_BASE,
        sha256: null,
        strength: 'STRONG' as const,
        origin: 'input' as const,
        eventId: null,
      };
      await expect(service.add({ ...valid, phash: 'xyz' })).rejects.toThrow(
        'pHash inválido',
      );
      await expect(service.add({ ...valid, sha256: 'xyz' })).rejects.toThrow(
        'sha256 inválido',
      );
      await expect(
        service.add({ ...valid, origin: 'site' as 'input' }),
      ).rejects.toThrow('origem inválida');
      expect(prisma.contentHashBlock.create).not.toHaveBeenCalled();
    });

    it('mesmo hash já ativo com força igual ou maior: devolve a linha existente', async () => {
      prisma.contentHashBlock.findFirst.mockResolvedValueOnce({
        id: 'existente',
        strength: 'STRONG',
      });
      const id = await service.add({
        phash: PHASH_BASE,
        sha256: SHA_A,
        strength: 'MEDIUM',
        origin: 'input',
        eventId: null,
      });
      expect(id).toBe('existente');
      expect(prisma.contentHashBlock.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { phash: PHASH_BASE, sha256: SHA_A, revokedAt: null },
        }),
      );
      expect(prisma.contentHashBlock.create).not.toHaveBeenCalled();
    });

    it('mesmo hash ativo com força menor: grava a linha mais forte', async () => {
      prisma.contentHashBlock.findFirst.mockResolvedValueOnce({
        id: 'existente',
        strength: 'MEDIUM',
      });
      expect(
        await service.add({
          phash: PHASH_BASE,
          sha256: null,
          strength: 'STRONG',
          origin: 'report',
          eventId: null,
        }),
      ).toBe('novo');
    });
  });

  describe('countRecent', () => {
    it('conta tentativas barradas da conta na janela, com hash perto, uma por geração', async () => {
      const now = 5_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(now);
      prisma.contentSafetyScan.findMany.mockResolvedValueOnce([
        { id: 's1', generationId: 'g1', phash: PHASH_BASE },
        { id: 's2', generationId: 'g1', phash: PHASH_NEAR },
        { id: 's3', generationId: 'g2', phash: PHASH_NEAR.toUpperCase() },
        { id: 's4', generationId: 'g3', phash: '0000ffff0000ffff' },
        { id: 's5', generationId: null, phash: PHASH_AT_LIMIT },
        { id: 's6', generationId: null, phash: PHASH_BASE },
        { id: 's7', generationId: 'g4', phash: 'quebrado' },
      ]);
      const count = await service.countRecent('user-1', PHASH_BASE, 24, 8);
      // g1, g2, s5 e s6 (sem geração, cada linha conta)
      expect(count).toBe(4);
      expect(prisma.contentSafetyScan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'user-1',
            createdAt: { gte: new Date(now - 24 * 60 * 60_000) },
            stage: { in: ['INPUT', 'INPUT_FRAME'] },
            verdict: { in: ['HOLD', 'BLOCK'] },
            phash: { not: null },
          },
        }),
      );
    });

    it('janela vazia ou conta vazia: zero sem consultar; pHash inválido lança', async () => {
      expect(await service.countRecent('user-1', PHASH_BASE, 0, 8)).toBe(0);
      expect(await service.countRecent('', PHASH_BASE, 24, 8)).toBe(0);
      expect(prisma.contentSafetyScan.findMany).not.toHaveBeenCalled();
      await expect(
        service.countRecent('user-1', 'quebrado', 24, 8),
      ).rejects.toThrow('pHash inválido');
    });
  });
});
