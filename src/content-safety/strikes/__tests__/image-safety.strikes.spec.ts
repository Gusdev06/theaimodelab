import { Logger } from '@nestjs/common';
import { ContentSafetyEventKind, GenerationStatus } from '@prisma/client';
import { GenerationJobName } from '../../../generations/queue/generation-queue.constants';
import { contentTypeOfKey } from '../../../uploads/uploads.service';
import {
  isRuleEnforced,
  loadImageSafetyConfig,
  type ImageSafetyConfig,
} from '../../image-safety/image-safety.config';
import {
  ImageSafetyService,
  type SafetyMediaToolkit,
} from '../../image-safety/image-safety.service';
import { NoopKnownHashMatcher } from '../../image-safety/known-csam.matcher';
import { NoopStylizedJudge } from '../../image-safety/stylized-judge.client';
import type {
  FaceSignal,
  ScannerResult,
  TextVerdict,
} from '../../image-safety/types';
import {
  AccountSuspendedSafetyError,
  PhotoRetryLimitError,
} from '../strikes.errors';
import type { StrikeOutcome } from '../strikes.types';

/**
 * Ganchos da camada 6 no porteiro: cada bloqueio ou retenção que agiu manda o sinal (com o evento e as fotos), a conta
 * suspensa não chega ao provedor nem publica resultado, e o limite de novas tentativas com foto recusa sem chamar a
 * AWS. Leitor, mídia e camada 6 simulados; nenhuma imagem.
 */

const GEN = 'gen-1';
const USER = 'cmuser000000000000000001';
const PRIVATE = (file: string) =>
  `https://s3.test/privado/inputs/${GEN}/u/${file}?X-Amz-Signature=velha`;
const QUARANTINE = (file: string) =>
  `https://s3.test/quarentena/generations/${GEN}/q/${file}?X-Amz-Expires=1800`;
const PHOTO = PRIVATE('foto.png');
const PHOTO_BYTES = `bytes:inputs/${GEN}/u/foto.png`;
const PHASH = '0123456789abcdef';

const face = (ageLow: number, ageHigh: number): FaceSignal => ({
  ageLow,
  ageHigh,
  ageMid: (ageLow + ageHigh) / 2,
  box: null,
  confidence: 99,
  fromCrop: false,
});

const scan = (overrides: Partial<ScannerResult> = {}): ScannerResult => ({
  faces: [face(30, 38)],
  labels: [{ name: 'Person', confidence: 99, instanceCount: 1 }],
  moderation: [],
  illustrated: false,
  cropPassRan: false,
  scanner: 'rekognition',
  region: 'sa-east-1',
  latencyMs: 12,
  ...overrides,
});

function keyOf(url: string): string {
  return url.split('?')[0].replace(/^https:\/\/[^/]+\/[^/]+\//, '');
}

function configFor(
  overrides: Partial<ImageSafetyConfig> = {},
): ImageSafetyConfig {
  const env: Record<string, string> = {
    S3_EVIDENCE_BUCKET: 'taml-evidencia',
    IMAGE_SAFETY_MODE: 'shadow',
  };
  return { ...loadImageSafetyConfig((key) => env[key]).config, ...overrides };
}

const NO_OUTCOME: StrikeOutcome = {
  action: 'none',
  points: 0,
  causes: [],
  shadowCauses: [],
  linkedAccounts: [],
};

interface Setup {
  config?: ImageSafetyConfig;
  generation?: Record<string, unknown>;
  inputs?: string[];
  scans?: Record<string, ScannerResult>;
  text?: TextVerdict | null;
  suspended?: boolean;
  retryAllowed?: boolean;
  strikesEnabled?: boolean;
  inReview?: string[];
}

function setup(options: Setup = {}) {
  const config = options.config ?? configFor();
  const stored: Array<Record<string, unknown>> = [];
  const generationRow: Record<string, unknown> = {
    id: GEN,
    userId: USER,
    status: GenerationStatus.PROCESSING,
    type: 'IMAGE_TO_IMAGE',
    modelUsed: 'nano-banana-2',
    prompt: 'retrato de uma mulher adulta',
    negativePrompt: null,
    parameters: {},
    safetyCheckedAt: null,
    updatedAt: new Date('2026-10-22T10:00:00Z'),
    ...(options.generation ?? {}),
  };
  const prisma = {
    generation: {
      findUnique: jest.fn(async () => ({ ...generationRow })),
      findMany: jest.fn(async () =>
        (options.inReview ?? []).map((id) => ({ id })),
      ),
      updateMany: jest.fn(async (args: { data: Record<string, unknown> }) => {
        Object.assign(generationRow, args.data);
        return { count: 1 };
      }),
    },
    generationInputImage: {
      findMany: jest.fn(async () =>
        (options.inputs ?? []).map((url) => ({
          url,
          mimeType: 'image/png',
          referenceType: null,
        })),
      ),
      count: jest.fn(async () => (options.inputs ?? []).length),
    },
    contentSafetyScan: {
      findMany: jest.fn(async (args: { where: Record<string, any> }) =>
        stored.filter(
          (row) =>
            row.generationId === args.where.generationId &&
            (!args.where.stage?.in || args.where.stage.in.includes(row.stage)),
        ),
      ),
      findFirst: jest.fn(async () => null),
      createMany: jest.fn(
        async (args: { data: Array<Record<string, unknown>> }) => {
          stored.push(...args.data);
          return { count: args.data.length };
        },
      ),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    contentSafetyEvent: { count: jest.fn(async () => 0) },
  };
  const uploads = {
    privateInputsEnabled: true,
    quarantineEnabled: true,
    quarantineConfigured: true,
    locateStoredMedia: jest.fn((url: string | null | undefined) => {
      if (!url) return null;
      if (url.startsWith('https://s3.test/privado/'))
        return { area: 'input-private', key: keyOf(url) };
      if (url.startsWith('https://s3.test/quarentena/'))
        return { area: 'quarantine', key: keyOf(url) };
      return null;
    }),
    readStoredObject: jest.fn(async (_area: string, key: string) => ({
      body: Buffer.from(`bytes:${key}`),
      contentType: contentTypeOfKey(key),
    })),
    moveToEvidence: jest.fn(
      async (_area: string, key: string) => `evidence/h/${key}`,
    ),
    storeEvidence: jest.fn(async () => 'evidence/h/memoria'),
    deleteStoredObject: jest.fn(async () => undefined),
    copyQuarantineToPublic: jest.fn(async (key: string) => ({
      url: `https://cdn.test/${key}`,
      key,
    })),
    deleteQuarantineObject: jest.fn(async () => undefined),
    deleteQuarantinePrefix: jest.fn(async () => 0),
    getPublicUrl: jest.fn((key: string) => `https://cdn.test/${key}`),
  };
  let eventCount = 0;
  const contentSafety = {
    record: jest.fn(async () => `evt-${++eventCount}`),
    hasConsentForGeneration: jest.fn(async () => true),
  };
  const textClassifier = {
    classify: jest.fn(async () => options.text),
    shouldAct: jest.fn((verdict: Pick<TextVerdict, 'ruleId' | 'strength'>) =>
      isRuleEnforced(
        { layer: 'text', ruleId: verdict.ruleId, strength: verdict.strength },
        config,
      ),
    ),
    textSha256: jest.fn(() => 'f'.repeat(64)),
    withSexualRequest: jest.fn((verdict: TextVerdict) => verdict),
  };
  const blocklist = {
    match: jest.fn(async () => null),
    add: jest.fn(async () => 'block-1'),
    countRecent: jest.fn(async () => 0),
  };
  const scanner = {
    name: 'rekognition',
    detect: jest.fn(
      async (image: { jpeg: Buffer }) =>
        (options.scans ?? {})[image.jpeg.toString()] ?? scan(),
    ),
  };
  const media: SafetyMediaToolkit = {
    normalizeImage: jest.fn(async (buffer: Buffer, mimeType: string | null) => [
      {
        jpeg: buffer,
        width: 1000,
        height: 1000,
        sha256: 'a'.repeat(64),
        sourceMimeType: mimeType,
      },
    ]),
    sampleVideoFrames: jest.fn(async () => []),
    phash: jest.fn(async () => PHASH),
  };
  // o sinal chega depois das checagens gravadas (a repetição por hash conta esta tentativa)
  const scansAtSignal: number[] = [];
  const strikes = {
    enabled: options.strikesEnabled ?? true,
    applySignal: jest.fn(async () => {
      scansAtSignal.push(stored.length);
      return NO_OUTCOME;
    }),
    isSuspended: jest.fn(async () => options.suspended ?? false),
    photoRetryAllowed: jest.fn(async () => options.retryAllowed ?? true),
  };
  const service = new ImageSafetyService(
    config,
    prisma as never,
    uploads as never,
    contentSafety as never,
    textClassifier as never,
    blocklist as never,
    new NoopKnownHashMatcher(),
    new NoopStylizedJudge(),
    media,
    scanner as never,
    strikes,
  );
  return {
    service,
    prisma,
    uploads,
    contentSafety,
    scanner,
    strikes,
    stored,
    scansAtSignal,
    generationRow,
  };
}

const imageJob = (data: Record<string, unknown> = {}) => ({
  name: GenerationJobName.IMAGE,
  data: {
    generationId: GEN,
    userId: USER,
    model: 'nano-banana-2',
    prompt: 'retrato',
    hasInputImages: true,
    ...data,
  },
});

const textVerdict = (overrides: Partial<TextVerdict> = {}): TextVerdict => ({
  verdict: 'CLEAN',
  ruleId: null,
  strength: 'NONE',
  sexualIntent: true,
  sha256: 'b'.repeat(64),
  results: [],
  reason: 'teste',
  ...overrides,
});

const completion = {
  modelUsed: 'nano-banana-2',
  provider: null,
  processingTimeMs: 10,
};

describe('ImageSafetyService · camada 6 (pontos e suspensão)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('preflight', () => {
    it('conta suspensa: encerra antes de ler a mídia, sem AWS e sem checagem gravada', async () => {
      const ctx = setup({ suspended: true, inputs: [PHOTO] });
      const error = await ctx.service
        .preflight(imageJob())
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AccountSuspendedSafetyError);
      expect((error as AccountSuspendedSafetyError).failureCode).toBe(
        'IMAGE_SAFETY_BLOCKED',
      );
      expect(ctx.strikes.isSuspended).toHaveBeenCalledWith(USER);
      expect(ctx.uploads.readStoredObject).not.toHaveBeenCalled();
      expect(ctx.scanner.detect).not.toHaveBeenCalled();
      expect(ctx.stored).toHaveLength(0);
    });

    it('acima do limite de novas tentativas com foto: recusa sem checar, com o código genérico', async () => {
      const ctx = setup({ retryAllowed: false, inputs: [PHOTO] });
      const error = await ctx.service
        .preflight(imageJob())
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PhotoRetryLimitError);
      expect((error as PhotoRetryLimitError).failureCode).toBe(
        'IMAGE_SAFETY_BLOCKED',
      );
      expect(ctx.strikes.photoRetryAllowed).toHaveBeenCalledWith(USER, {
        currentGenerationId: GEN,
      });
      expect(ctx.scanner.detect).not.toHaveBeenCalled();
      expect(ctx.stored).toHaveLength(0);
    });

    it('pedido sem foto não passa pelo limite de tentativas', async () => {
      const ctx = setup({ retryAllowed: false });
      await expect(
        ctx.service.preflight(imageJob({ hasInputImages: false })),
      ).resolves.toMatchObject({ action: 'proceed' });
      expect(ctx.strikes.photoRetryAllowed).not.toHaveBeenCalled();
    });

    it('criança evidente em pedido sexual (E2): sinal forte com o evento e a foto, depois das checagens gravadas', async () => {
      const ctx = setup({
        generation: { modelUsed: 'sem-censura' },
        inputs: [PHOTO],
        scans: { [PHOTO_BYTES]: scan({ faces: [face(6, 10)] }) },
      });
      await expect(
        ctx.service.preflight(imageJob({ model: 'sem-censura' })),
      ).rejects.toBeDefined();
      expect(ctx.strikes.applySignal).toHaveBeenCalledTimes(1);
      expect(ctx.strikes.applySignal).toHaveBeenCalledWith(
        USER,
        'STRONG',
        'evt-1',
        {
          layer: 'input',
          match: 'E2/STRONG',
          generationId: GEN,
          photos: [
            {
              phash: PHASH,
              sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
              blockId: null,
            },
          ],
        },
      );
      expect(ctx.scansAtSignal[0]).toBeGreaterThan(0);
    });

    it('provável menor em pedido sexual (E3a): segura e manda o sinal médio com a foto', async () => {
      const ctx = setup({
        generation: { modelUsed: 'sem-censura' },
        inputs: [PHOTO],
        scans: { [PHOTO_BYTES]: scan({ faces: [face(14, 18)] }) },
      });
      await expect(
        ctx.service.preflight(imageJob({ model: 'sem-censura' })),
      ).resolves.toEqual({ action: 'held' });
      expect(ctx.strikes.applySignal).toHaveBeenCalledWith(
        USER,
        'MEDIUM',
        'evt-1',
        expect.objectContaining({
          layer: 'input',
          match: 'E3a/MEDIUM',
          photos: [expect.objectContaining({ phash: PHASH })],
        }),
      );
    });

    it('criança em pedido não sexual (caso leve): sem ponto e sem nada derivado da foto', async () => {
      const ctx = setup({
        inputs: [PHOTO],
        scans: { [PHOTO_BYTES]: scan({ faces: [face(6, 10)] }) },
      });
      await expect(ctx.service.preflight(imageJob())).rejects.toBeDefined();
      expect(ctx.strikes.applySignal).toHaveBeenCalledWith(
        USER,
        'LIGHT',
        null,
        {
          layer: 'input',
          match: 'E2/LIGHT',
          generationId: GEN,
          photos: [],
        },
      );
    });

    it('texto barrado com idade explícita: sinal forte do texto', async () => {
      const ctx = setup({
        config: configFor({ textMode: 'shadow' }),
        text: textVerdict({
          verdict: 'BLOCK',
          ruleId: 'T_CLASSIFIER',
          strength: 'STRONG',
        }),
      });
      await expect(
        ctx.service.preflight(imageJob({ hasInputImages: false })),
      ).rejects.toBeDefined();
      expect(ctx.strikes.applySignal).toHaveBeenCalledWith(
        USER,
        'STRONG',
        'evt-1',
        {
          layer: 'text',
          match: 'T_CLASSIFIER/STRONG',
          generationId: GEN,
        },
      );
    });

    it('camada 6 desligada: nenhuma consulta nem sinal', async () => {
      const ctx = setup({
        strikesEnabled: false,
        generation: { modelUsed: 'sem-censura' },
        inputs: [PHOTO],
        scans: { [PHOTO_BYTES]: scan({ faces: [face(6, 10)] }) },
      });
      await expect(
        ctx.service.preflight(imageJob({ model: 'sem-censura' })),
      ).rejects.toBeDefined();
      expect(ctx.strikes.isSuspended).not.toHaveBeenCalled();
      expect(ctx.strikes.photoRetryAllowed).not.toHaveBeenCalled();
      expect(ctx.strikes.applySignal).not.toHaveBeenCalled();
    });
  });

  describe('haltIfAccountSuspended (uma linha no processor)', () => {
    it('lança só para a conta suspensa', async () => {
      await expect(
        setup({ suspended: true }).service.haltIfAccountSuspended({
          userId: USER,
        }),
      ).rejects.toBeInstanceOf(AccountSuspendedSafetyError);
      await expect(
        setup().service.haltIfAccountSuspended({ userId: USER }),
      ).resolves.toBeUndefined();
      await expect(
        setup({
          suspended: true,
          strikesEnabled: false,
        }).service.haltIfAccountSuspended({
          userId: USER,
        }),
      ).resolves.toBeUndefined();
    });

    it('pela geração (desvios do processor): lança só para a dona suspensa; desligado não lê o banco', async () => {
      await expect(
        setup({ suspended: true }).service.haltIfGenerationOwnerSuspended(GEN),
      ).rejects.toBeInstanceOf(AccountSuspendedSafetyError);
      await expect(
        setup().service.haltIfGenerationOwnerSuspended(GEN),
      ).resolves.toBeUndefined();
      const off = setup({ suspended: true, strikesEnabled: false });
      await expect(
        off.service.haltIfGenerationOwnerSuspended(GEN),
      ).resolves.toBeUndefined();
      expect(off.prisma.generation.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('checagem do resultado', () => {
    const OUTPUT = QUARANTINE('output_0.png');
    const OUTPUT_BYTES = `bytes:generations/${GEN}/q/output_0.png`;

    it('conta suspensa com resultado limpo: não publica; fica em revisão (HOLD ACCOUNT_SUSPENDED + OUTPUT_HELD)', async () => {
      const ctx = setup({ suspended: true });
      await expect(
        ctx.service.checkOutput(GEN, [OUTPUT], completion),
      ).resolves.toEqual({
        action: 'held',
      });
      expect(ctx.uploads.copyQuarantineToPublic).not.toHaveBeenCalled();
      expect(ctx.contentSafety.record).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: ContentSafetyEventKind.OUTPUT_HELD,
          match: 'ACCOUNT_SUSPENDED/NONE',
          generationId: GEN,
          excerpt: null,
        }),
      );
      expect(ctx.stored).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ stage: 'OUTPUT', verdict: 'CLEAN' }),
          expect.objectContaining({
            stage: 'OUTPUT',
            verdict: 'HOLD',
            ruleId: 'ACCOUNT_SUSPENDED',
            enforced: true,
            mediaKey: `generations/${GEN}/q/output_0.png`,
          }),
        ]),
      );
      expect(ctx.generationRow.status).toBe(GenerationStatus.IN_REVIEW);
      const state = await ctx.service.holdStateOf(GEN);
      expect(state?.reason).toBe('output_review');
      expect(ctx.strikes.applySignal).not.toHaveBeenCalled();
    });

    it('resultado com menor (S1): sinal forte do resultado', async () => {
      const ctx = setup({
        scans: {
          [OUTPUT_BYTES]: scan({
            faces: [face(6, 10)],
            moderation: [
              {
                name: 'Explicit Nudity',
                parent: 'Explicit',
                confidence: 97,
                taxonomyLevel: 2,
              },
            ],
          }),
        },
      });
      const outcome = await ctx.service.checkOutput(GEN, [OUTPUT], completion);
      expect(outcome.action).toBe('blocked');
      expect(ctx.strikes.applySignal).toHaveBeenCalledWith(
        USER,
        'STRONG',
        'evt-1',
        {
          layer: 'output',
          match: 'S1/STRONG',
          generationId: GEN,
        },
      );
    });

    it('conta ativa com resultado limpo: publica como antes', async () => {
      const ctx = setup();
      const outcome = await ctx.service.checkOutput(GEN, [OUTPUT], completion);
      expect(outcome.action).toBe('promote');
      expect(ctx.uploads.copyQuarantineToPublic).toHaveBeenCalledTimes(1);
    });

    it('resultado que esperava checagem vira "em revisão" na suspensão (nunca sai sozinho)', async () => {
      const ctx = setup({
        inReview: [GEN],
        generation: {
          status: GenerationStatus.IN_REVIEW,
          parameters: {
            safetyHold: {
              stage: 'output',
              outputs: [
                {
                  area: 'quarantine',
                  key: `generations/${GEN}/q/output_0.png`,
                  mimeType: 'image/png',
                },
              ],
              modelUsed: 'nano-banana-2',
              provider: null,
              processingTimeMs: 10,
              heldAt: '2026-10-22T10:00:00.000Z',
            },
          },
        },
      });
      expect((await ctx.service.holdStateOf(GEN))?.reason).toBe(
        'output_unchecked',
      );
      await expect(
        ctx.service.holdUncheckedOutputsOfAccount(USER),
      ).resolves.toBe(1);
      expect((await ctx.service.holdStateOf(GEN))?.reason).toBe(
        'output_review',
      );
      // a liberação de provedor com filtro também não solta resultado de conta suspensa
      ctx.strikes.isSuspended.mockResolvedValue(true);
      await expect(
        ctx.service.releaseUncheckedOutput(GEN, 'teste'),
      ).resolves.toBeNull();
      expect(ctx.uploads.copyQuarantineToPublic).not.toHaveBeenCalled();
    });
  });

  describe('checagem síncrona (rotas sem fila)', () => {
    const sync = {
      userId: USER,
      generationId: null,
      model: 'sem-censura',
      tool: 'prompt_clone' as const,
      type: null,
      hasUserMedia: true,
      sexual: { classifier: null, inputNudity: null },
      prompt: null,
      negativePrompt: null,
    };
    const media = [
      {
        kind: 'image' as const,
        mimeType: 'image/png',
        buffer: Buffer.from('x'),
      },
    ];

    it('conta suspensa ou acima do limite: indisponível sem ler nada (e sem gravar tentativa)', async () => {
      const suspended = setup({ suspended: true });
      await expect(
        suspended.service.checkInput(media, sync),
      ).resolves.toMatchObject({
        verdict: 'UNAVAILABLE',
      });
      expect(suspended.scanner.detect).not.toHaveBeenCalled();
      const limited = setup({ retryAllowed: false });
      const verdict = await limited.service.checkInput(media, sync);
      expect(verdict.verdict).toBe('UNAVAILABLE');
      expect(limited.service.actsOn(verdict)).toBe(true);
      expect(limited.scanner.detect).not.toHaveBeenCalled();
      expect(limited.stored).toHaveLength(0);
    });

    it('camada 6 sem leitura (banco fora): recusa, nunca segue sem saber', async () => {
      const ctx = setup();
      ctx.strikes.isSuspended.mockRejectedValue(new Error('banco fora'));
      await expect(ctx.service.checkInput(media, sync)).resolves.toMatchObject({
        verdict: 'UNAVAILABLE',
      });
      expect(ctx.scanner.detect).not.toHaveBeenCalled();
    });

    it('foto barrada na rota sem fila: sinal com o evento e a foto', async () => {
      const ctx = setup({ scans: { x: scan({ faces: [face(6, 10)] }) } });
      const verdict = await ctx.service.checkInput(media, sync);
      expect(verdict.verdict).toBe('BLOCK');
      expect(ctx.strikes.applySignal).toHaveBeenCalledWith(
        USER,
        'STRONG',
        'evt-1',
        expect.objectContaining({
          layer: 'input',
          match: 'E2/STRONG',
          generationId: null,
        }),
      );
    });
  });
});
