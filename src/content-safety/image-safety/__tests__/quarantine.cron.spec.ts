import { Logger } from '@nestjs/common';
import {
  InputImageSafetyBlockError,
  OutputImageSafetyBlockError,
  SafetyCheckUnavailableError,
} from '../../../generations/errors/content-safety.error';
import {
  loadImageSafetyConfig,
  type ImageSafetyConfig,
} from '../image-safety.config';
import type { HoldState, SafetyHoldRecord } from '../image-safety.service';
import {
  QuarantineCron,
  type HeldGenerationFinisher,
} from '../quarantine.cron';

/**
 * Cron da quarentena: prazos de 10 min (provedor de confiança), 2 h (sem checagem), 4 h (revisão vencida = alerta),
 * 24 h (entrada segurada e resultado em revisão sem decisão) e o desligamento (kill switch). Tudo com o serviço e o
 * processor simulados.
 */

const NOW = new Date('2026-10-17T12:00:00Z');
const minutesAgo = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000);

const hold = (overrides: Partial<SafetyHoldRecord> = {}): SafetyHoldRecord => ({
  stage: 'output',
  outputs: [
    {
      area: 'quarantine',
      key: 'generations/g1/q/a.png',
      mimeType: 'image/png',
    },
  ],
  modelUsed: 'nano-banana-2',
  provider: 'kie',
  processingTimeMs: 3000,
  heldAt: NOW.toISOString(),
  ...overrides,
});

function configFor(
  overrides: Partial<ImageSafetyConfig> = {},
): ImageSafetyConfig {
  const { config } = loadImageSafetyConfig(
    (key) =>
      ({
        IMAGE_SAFETY_MODE: 'shadow',
        S3_EVIDENCE_BUCKET: 'taml-evidencia',
        SAFETY_TRUSTED_FILTER_MODELS: 'nano-banana-2',
      })[key],
  );
  return { ...config, ...overrides };
}

function setup(state: HoldState | null, config = configFor()) {
  const imageSafety = {
    holdStateOf: jest.fn(async () => state),
    recheckHeldOutput: jest.fn(async () => ({ action: 'held' as const })),
    releaseUncheckedOutput: jest.fn(async () => [
      'https://cdn.test/generations/g1/pub/a.png',
    ]),
    discardHeldOutput: jest.fn(async () => undefined),
    expireHeldInput: jest.fn(
      async () => new InputImageSafetyBlockError('E3a', 'MEDIUM'),
    ),
    expireReviewedOutput: jest.fn(
      async () => new OutputImageSafetyBlockError('S2b', 'MEDIUM'),
    ),
    markReviewAlerted: jest.fn(async () => undefined),
  };
  const finisher = {
    completeHeldGeneration: jest.fn<
      ReturnType<HeldGenerationFinisher['completeHeldGeneration']>,
      Parameters<HeldGenerationFinisher['completeHeldGeneration']>
    >(async () => true),
    failForSafety: jest.fn<
      ReturnType<HeldGenerationFinisher['failForSafety']>,
      Parameters<HeldGenerationFinisher['failForSafety']>
    >(async () => undefined),
  };
  const prisma = {
    generation: { findMany: jest.fn(async () => [{ id: 'g1' }]) },
  };
  const moduleRef = { get: jest.fn(() => finisher) };
  const cron = new QuarantineCron(
    config,
    prisma as never,
    imageSafety as never,
    moduleRef as never,
  );
  return { cron, imageSafety, finisher, prisma, moduleRef };
}

describe('QuarantineCron', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('checagens desligadas (kill switch) com geração ainda segurada', () => {
    const off = () => configFor({ imageMode: 'off', textMode: 'off' });

    it('sem IN_REVIEW: só a consulta, nada mais', async () => {
      const ctx = setup(null, off());
      ctx.prisma.generation.findMany.mockResolvedValueOnce([]);
      await expect(ctx.cron.sweep(NOW)).resolves.toMatchObject({ checked: 0 });
      expect(ctx.imageSafety.holdStateOf).not.toHaveBeenCalled();
    });

    it('entrada segurada: evidência e falha com estorno na hora, sem esperar 24 h', async () => {
      const ctx = setup(
        {
          reason: 'input_review',
          heldAt: minutesAgo(5),
          hold: null,
          modelUsed: 'x',
        },
        off(),
      );
      await expect(ctx.cron.handle('g1', ctx.finisher, NOW)).resolves.toBe(
        'failed',
      );
      expect(ctx.imageSafety.expireHeldInput).toHaveBeenCalledWith('g1');
      expect(ctx.finisher.failForSafety).toHaveBeenCalledWith(
        'g1',
        expect.any(InputImageSafetyBlockError),
      );
    });

    it('resultado em revisão: vai para a evidência, nunca publicado', async () => {
      const ctx = setup(
        {
          reason: 'output_review',
          heldAt: minutesAgo(5),
          hold: hold(),
          modelUsed: 'nano-banana-2',
        },
        off(),
      );
      await expect(ctx.cron.handle('g1', ctx.finisher, NOW)).resolves.toBe(
        'failed',
      );
      expect(ctx.imageSafety.expireReviewedOutput).toHaveBeenCalledWith('g1');
      expect(ctx.finisher.completeHeldGeneration).not.toHaveBeenCalled();
    });

    it('resultado sem checagem: apagado, nenhuma checagem nova, nenhuma promoção', async () => {
      const ctx = setup(
        {
          reason: 'output_unchecked',
          heldAt: minutesAgo(5),
          hold: hold(),
          modelUsed: 'nano-banana-2',
        },
        off(),
      );
      await expect(ctx.cron.handle('g1', ctx.finisher, NOW)).resolves.toBe(
        'failed',
      );
      expect(ctx.imageSafety.recheckHeldOutput).not.toHaveBeenCalled();
      expect(ctx.imageSafety.releaseUncheckedOutput).not.toHaveBeenCalled();
      expect(ctx.imageSafety.discardHeldOutput).toHaveBeenCalledWith('g1');
      expect(ctx.finisher.failForSafety).toHaveBeenCalledWith(
        'g1',
        expect.any(SafetyCheckUnavailableError),
      );
    });
  });

  it('só a imagem desligada: resultado segurado encerra sem checar (nunca é promovido sem checagem); entrada segue o prazo', async () => {
    const imageOff = configFor({ imageMode: 'off', textMode: 'shadow' });
    const unchecked = setup(
      {
        reason: 'output_unchecked',
        heldAt: minutesAgo(5),
        hold: hold(),
        modelUsed: 'nano-banana-2',
      },
      imageOff,
    );
    await expect(
      unchecked.cron.handle('g1', unchecked.finisher, NOW),
    ).resolves.toBe('failed');
    expect(unchecked.imageSafety.recheckHeldOutput).not.toHaveBeenCalled();
    expect(unchecked.finisher.completeHeldGeneration).not.toHaveBeenCalled();

    const input = setup(
      {
        reason: 'input_review',
        heldAt: minutesAgo(5),
        hold: null,
        modelUsed: 'x',
      },
      imageOff,
    );
    await expect(input.cron.handle('g1', input.finisher, NOW)).resolves.toBe(
      'waiting',
    );
  });

  it('percorre TODAS as IN_REVIEW por cursor (quem só espera revisor não trava a fila)', async () => {
    const ctx = setup({
      reason: 'output_review',
      heldAt: minutesAgo(5),
      hold: hold(),
      modelUsed: 'x',
    });
    const page = (from: number, size: number) =>
      Array.from({ length: size }, (_, index) => ({
        id: `g${String(from + index).padStart(4, '0')}`,
      }));
    ctx.prisma.generation.findMany
      .mockResolvedValueOnce(page(0, 100))
      .mockResolvedValueOnce(page(100, 30));
    await expect(ctx.cron.sweep(NOW)).resolves.toMatchObject({ checked: 130 });
    const calls = ctx.prisma.generation.findMany.mock.calls as unknown as Array<
      [{ where: Record<string, unknown>; orderBy: unknown }]
    >;
    expect(calls[0][0]).toMatchObject({
      where: { status: 'IN_REVIEW' },
      orderBy: { id: 'asc' },
    });
    expect(calls[1][0].where).toEqual({
      status: 'IN_REVIEW',
      id: { gt: 'g0099' },
    });
  });

  describe('entrada segurada (E3a, negativo)', () => {
    it('antes de 24 h espera o revisor', async () => {
      const ctx = setup({
        reason: 'input_review',
        heldAt: minutesAgo(23 * 60),
        hold: null,
        modelUsed: 'x',
      });
      await expect(ctx.cron.handle('g1', ctx.finisher, NOW)).resolves.toBe(
        'waiting',
      );
      expect(ctx.finisher.failForSafety).not.toHaveBeenCalled();
    });

    it('depois de 24 h sem decisão: evidência e falha com estorno', async () => {
      const ctx = setup({
        reason: 'input_review',
        heldAt: minutesAgo(24 * 60 + 1),
        hold: null,
        modelUsed: 'x',
      });
      await expect(ctx.cron.handle('g1', ctx.finisher, NOW)).resolves.toBe(
        'failed',
      );
      expect(ctx.imageSafety.expireHeldInput).toHaveBeenCalledWith('g1');
      expect(ctx.finisher.failForSafety).toHaveBeenCalledWith(
        'g1',
        expect.any(InputImageSafetyBlockError),
      );
    });
  });

  describe('resultado em revisão', () => {
    it('vencida a meta (4 h): alerta uma vez (gravado no banco) e NUNCA libera sozinho', async () => {
      const ctx = setup({
        reason: 'output_review',
        heldAt: minutesAgo(5 * 60),
        hold: hold(),
        modelUsed: 'nano-banana-2',
      });
      await expect(ctx.cron.handle('g1', ctx.finisher, NOW)).resolves.toBe(
        'alerted',
      );
      expect(ctx.imageSafety.markReviewAlerted).toHaveBeenCalledWith('g1');
      await expect(ctx.cron.handle('g1', ctx.finisher, NOW)).resolves.toBe(
        'waiting',
      );
      expect(ctx.finisher.completeHeldGeneration).not.toHaveBeenCalled();
      expect(ctx.finisher.failForSafety).not.toHaveBeenCalled();
      expect(ctx.imageSafety.releaseUncheckedOutput).not.toHaveBeenCalled();
    });

    it('aviso já gravado (processo reiniciado): não avisa de novo', async () => {
      const ctx = setup({
        reason: 'output_review',
        heldAt: minutesAgo(5 * 60),
        hold: hold(),
        modelUsed: 'nano-banana-2',
        alertedAt: minutesAgo(60),
      });
      await expect(ctx.cron.handle('g1', ctx.finisher, NOW)).resolves.toBe(
        'waiting',
      );
      expect(ctx.imageSafety.markReviewAlerted).not.toHaveBeenCalled();
    });

    it('sem decisão em 24 h: evidência e falha com estorno, nunca publicado', async () => {
      const ctx = setup({
        reason: 'output_review',
        heldAt: minutesAgo(24 * 60 + 1),
        hold: hold(),
        modelUsed: 'nano-banana-2',
      });
      await expect(ctx.cron.handle('g1', ctx.finisher, NOW)).resolves.toBe(
        'failed',
      );
      expect(ctx.imageSafety.expireReviewedOutput).toHaveBeenCalledWith('g1');
      expect(ctx.finisher.failForSafety).toHaveBeenCalledWith(
        'g1',
        expect.any(OutputImageSafetyBlockError),
      );
      expect(ctx.finisher.completeHeldGeneration).not.toHaveBeenCalled();
      expect(ctx.imageSafety.releaseUncheckedOutput).not.toHaveBeenCalled();
    });
  });

  describe('resultado sem checagem', () => {
    const unchecked = (
      minutes: number,
      modelUsed = 'nano-banana-2',
    ): HoldState => ({
      reason: 'output_unchecked',
      heldAt: minutesAgo(minutes),
      hold: hold({ modelUsed }),
      modelUsed,
    });

    it('a nova checagem aprova: conclui com as URLs promovidas', async () => {
      const ctx = setup(unchecked(3));
      ctx.imageSafety.recheckHeldOutput.mockResolvedValueOnce({
        action: 'promote',
        outputs: ['https://cdn.test/generations/g1/pub/a.png'],
      } as never);
      await expect(ctx.cron.handle('g1', ctx.finisher, NOW)).resolves.toBe(
        'completed',
      );
      expect(ctx.finisher.completeHeldGeneration).toHaveBeenCalledWith(
        'g1',
        ['https://cdn.test/generations/g1/pub/a.png'],
        expect.objectContaining({
          modelUsed: 'nano-banana-2',
          processingTimeMs: 3000,
        }),
      );
    });

    it('a nova checagem acha menor: encerra com estorno', async () => {
      const ctx = setup(unchecked(3));
      const error = new OutputImageSafetyBlockError('S1', 'STRONG');
      ctx.imageSafety.recheckHeldOutput.mockResolvedValueOnce({
        action: 'blocked',
        error,
      } as never);
      await expect(ctx.cron.handle('g1', ctx.finisher, NOW)).resolves.toBe(
        'failed',
      );
      expect(ctx.finisher.failForSafety).toHaveBeenCalledWith('g1', error);
    });

    it('provedor de confiança depois de 10 min: sai sem checagem (registrado)', async () => {
      const ctx = setup(unchecked(11));
      await expect(ctx.cron.handle('g1', ctx.finisher, NOW)).resolves.toBe(
        'completed',
      );
      expect(ctx.imageSafety.releaseUncheckedOutput).toHaveBeenCalledWith(
        'g1',
        expect.stringContaining('nano-banana-2'),
      );
      expect(ctx.finisher.completeHeldGeneration).toHaveBeenCalled();
    });

    it('provedor de confiança antes de 10 min: espera', async () => {
      const ctx = setup(unchecked(9));
      await expect(ctx.cron.handle('g1', ctx.finisher, NOW)).resolves.toBe(
        'waiting',
      );
      expect(ctx.imageSafety.releaseUncheckedOutput).not.toHaveBeenCalled();
    });

    it('modelo fora da lista de confiança: nunca sai sem checagem; depois de 2 h falha com estorno', async () => {
      const ctx = setup(unchecked(60, 'sem-censura'));
      await expect(ctx.cron.handle('g1', ctx.finisher, NOW)).resolves.toBe(
        'waiting',
      );
      expect(ctx.imageSafety.releaseUncheckedOutput).not.toHaveBeenCalled();

      const late = setup(unchecked(121, 'sem-censura'));
      await expect(late.cron.handle('g1', late.finisher, NOW)).resolves.toBe(
        'failed',
      );
      expect(late.imageSafety.discardHeldOutput).toHaveBeenCalledWith('g1');
      expect(late.finisher.failForSafety).toHaveBeenCalledWith(
        'g1',
        expect.any(SafetyCheckUnavailableError),
      );
    });
  });

  it('erro numa geração não para a rodada', async () => {
    const ctx = setup({
      reason: 'input_review',
      heldAt: minutesAgo(5),
      hold: null,
      modelUsed: 'x',
    });
    ctx.prisma.generation.findMany.mockResolvedValueOnce([
      { id: 'g1' },
      { id: 'g2' },
    ]);
    ctx.imageSafety.holdStateOf.mockRejectedValueOnce(new Error('db'));
    await expect(ctx.cron.sweep(NOW)).resolves.toMatchObject({ checked: 2 });
  });
});
