import { Logger } from '@nestjs/common';
import { ContentSafetyEventKind, GenerationStatus } from '@prisma/client';
import {
  InputImageSafetyBlockError,
  OutputImageSafetyBlockError,
  SafetyCheckPendingError,
  SafetyCheckUnavailableError,
  TextSafetyBlockError,
  UnverifiedContentBlockError,
} from '../../../generations/errors/content-safety.error';
import { GenerationJobName } from '../../../generations/queue/generation-queue.constants';
import { contentTypeOfKey } from '../../../uploads/uploads.service';
import {
  isRuleEnforced,
  loadImageSafetyConfig,
  RULES_VERSION,
  type ImageSafetyConfig,
} from '../image-safety.config';
import {
  ImageSafetyService,
  outputSafetyModelOf,
  safetyModelOf,
  safetyToolOf,
  type SafetyMediaToolkit,
} from '../image-safety.service';
import { REFINER_TEXT_MEDIA_KEY } from '../image-safety.scans';
import { NoopKnownHashMatcher } from '../known-csam.matcher';
import { NoopStylizedJudge } from '../stylized-judge.client';
import {
  SafetyProviderUnavailableError,
  type FaceSignal,
  type ScannerResult,
  type TextVerdict,
} from '../types';

/**
 * Orquestração do porteiro (preflight), da checagem síncrona e da checagem do resultado. Tudo simulado: respostas do
 * leitor em objetos (idades e rótulos inventados), mídia como bytes de mentira, toolkit de mídia falso. Nenhuma imagem.
 */

const GEN = 'gen-1';
const USER = 'user-1';
const PRIVATE = (file: string) =>
  `https://s3.test/privado/inputs/${GEN}/u/${file}?X-Amz-Signature=velha`;
const QUARANTINE = (file: string) =>
  `https://s3.test/quarentena/generations/${GEN}/q/${file}?X-Amz-Expires=1800`;

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

const NUDITY = [
  {
    name: 'Explicit Nudity',
    parent: 'Explicit',
    confidence: 97,
    taxonomyLevel: 2,
  },
];

function configFor(
  env: Record<string, string> = {},
  overrides: Partial<ImageSafetyConfig> = {},
): ImageSafetyConfig {
  // a checagem de imagem só liga com lugar para a evidência
  const withEvidence: Record<string, string> = {
    S3_EVIDENCE_BUCKET: 'taml-evidencia',
    ...env,
  };
  const { config } = loadImageSafetyConfig((key) => withEvidence[key]);
  return { ...config, ...overrides };
}

function keyOf(url: string): string {
  return url.split('?')[0].replace(/^https:\/\/[^/]+\/[^/]+\//, '');
}

interface Setup {
  config?: ImageSafetyConfig;
  generation?: Record<string, unknown> | null;
  inputs?: Array<{
    url: string;
    mimeType?: string | null;
    referenceType?: string | null;
  }>;
  scans?: Record<string, ScannerResult | Error>;
  frames?: number;
  existingScans?: Array<Record<string, unknown>>;
  text?: TextVerdict | null;
  cacheRow?: Record<string, unknown> | null;
}

function setup(options: Setup = {}) {
  const config = options.config ?? configFor({ IMAGE_SAFETY_MODE: 'shadow' });
  const stored: Array<Record<string, unknown>> = [
    ...(options.existingScans ?? []),
  ];
  const generationRow =
    options.generation === null
      ? null
      : {
          id: GEN,
          userId: USER,
          status: GenerationStatus.PROCESSING,
          type: 'IMAGE_TO_IMAGE',
          modelUsed: 'nano-banana-2',
          prompt: 'retrato de uma mulher adulta',
          negativePrompt: null,
          parameters: {},
          safetyCheckedAt: null,
          updatedAt: new Date('2026-10-17T10:00:00Z'),
          ...(options.generation ?? {}),
        };
  const prisma = {
    generation: {
      findUnique: jest.fn(async () =>
        generationRow ? { ...generationRow } : null,
      ),
      updateMany: jest.fn(async (_args?: unknown) => ({ count: 1 })),
    },
    generationInputImage: {
      findMany: jest.fn(async () =>
        (options.inputs ?? []).map((input) => ({
          url: input.url,
          mimeType: input.mimeType ?? null,
          referenceType: input.referenceType ?? null,
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
      findFirst: jest.fn(async () => options.cacheRow ?? null),
      createMany: jest.fn(
        async (args: { data: Array<Record<string, unknown>> }) => {
          stored.push(...args.data);
          return { count: args.data.length };
        },
      ),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(
        async (args: {
          where: Record<string, any>;
          data: Record<string, unknown>;
        }) => {
          const rows = stored.filter(
            (row) =>
              row.generationId === args.where.generationId &&
              (args.where.mediaKey === undefined ||
                row.mediaKey === args.where.mediaKey) &&
              (!args.where.stage?.in ||
                args.where.stage.in.includes(row.stage)),
          );
          for (const row of rows) Object.assign(row, args.data);
          return { count: rows.length };
        },
      ),
    },
    contentSafetyEvent: { count: jest.fn(async () => 0) },
  };
  const uploads = {
    privateInputsEnabled: true,
    locateStoredMedia: jest.fn((url: string | null | undefined) => {
      if (!url) return null;
      if (url.startsWith('https://s3.test/privado/'))
        return { area: 'input-private', key: keyOf(url) };
      if (url.startsWith('https://s3.test/quarentena/'))
        return { area: 'quarantine', key: keyOf(url) };
      if (url.startsWith('https://cdn.test/'))
        return { area: 'public', key: url.slice('https://cdn.test/'.length) };
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
    promoteFromQuarantine: jest.fn(async (key: string) => ({
      url: `https://cdn.test/${key.replace('/q/', '/pub/')}`,
      key: key.replace('/q/', '/pub/'),
    })),
    copyQuarantineToPublic: jest.fn(async (key: string) => ({
      url: `https://cdn.test/${key.replace('/q/', '/pub/')}`,
      key: key.replace('/q/', '/pub/'),
    })),
    deleteQuarantineObject: jest.fn(async () => undefined),
    deleteQuarantinePrefix: jest.fn(async () => 0),
    quarantineEnabled: true,
    quarantineConfigured: true,
    getPublicUrl: jest.fn((key: string) => `https://cdn.test/${key}`),
  };
  const contentSafety = {
    record: jest.fn(async () => 'evt-1'),
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
  const scanResults = options.scans ?? {};
  const scanner = {
    name: 'rekognition',
    detect: jest.fn(async (image: { jpeg: Buffer }) => {
      const result = scanResults[image.jpeg.toString()] ?? scan();
      if (result instanceof Error) throw result;
      return result;
    }),
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
    sampleVideoFrames: jest.fn(async () =>
      Array.from({ length: options.frames ?? 3 }, (_, index) => ({
        jpeg: Buffer.from(`frame-${index}`),
        position: { index, timeMs: index * 2000 },
      })),
    ),
    phash: jest.fn(async () => '0123456789abcdef'),
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
    config.imageMode === 'off' ? null : (scanner as never),
  );
  return {
    service,
    prisma,
    uploads,
    contentSafety,
    textClassifier,
    blocklist,
    scanner,
    media,
    stored,
    config,
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

const PHOTO = PRIVATE('foto.png');
const PHOTO_BYTES = `bytes:inputs/${GEN}/u/foto.png`;

const textVerdict = (overrides: Partial<TextVerdict> = {}): TextVerdict => ({
  verdict: 'CLEAN',
  ruleId: null,
  strength: 'NONE',
  sexualIntent: false,
  sha256: 'b'.repeat(64),
  results: [
    {
      classifier: 'safeguard',
      violation: false,
      band: 'none',
      policyRuleId: null,
      score: null,
      sexual: false,
      explicitMinor: false,
      policyVersion: 'p1',
      region: 'sa-east-1',
      latencyMs: 300,
    },
  ],
  reason: 'sem violação',
  ...overrides,
});

describe('ImageSafetyService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('modo off = Onda 0', () => {
    it('preflight segue com unavailable sem ler nem gravar nada', async () => {
      const ctx = setup({ config: configFor() });
      await expect(ctx.service.preflight(imageJob())).resolves.toEqual({
        action: 'proceed',
        status: 'unavailable',
      });
      expect(ctx.prisma.generation.findUnique).not.toHaveBeenCalled();
      expect(ctx.prisma.contentSafetyScan.createMany).not.toHaveBeenCalled();
      expect(ctx.textClassifier.classify).not.toHaveBeenCalled();
    });

    it('checkOutput devolve as mesmas URLs sem ler nada', async () => {
      const ctx = setup({ config: configFor() });
      const urls = ['https://cdn.test/generations/gen-1/x/output_0.png'];
      await expect(
        ctx.service.checkOutput(GEN, urls, {
          modelUsed: 'nano-banana-2',
          provider: null,
          processingTimeMs: 10,
        }),
      ).resolves.toEqual({ action: 'promote', outputs: urls });
      expect(ctx.uploads.readStoredObject).not.toHaveBeenCalled();
      expect(ctx.prisma.generation.findUnique).not.toHaveBeenCalled();
    });

    it('refinador e checkInput não chamam ninguém', async () => {
      const ctx = setup({ config: configFor() });
      await expect(
        ctx.service.checkRefinedPrompt(GEN, 'texto reescrito', 'veo3'),
      ).resolves.toBeNull();
      const verdict = await ctx.service.checkInput(
        [{ kind: 'image', mimeType: 'image/png', buffer: Buffer.from('x') }],
        {
          userId: USER,
          generationId: null,
          model: null,
          tool: 'prompt_clone',
          type: null,
          hasUserMedia: true,
          sexual: { classifier: null, inputNudity: null },
          prompt: null,
          negativePrompt: null,
        },
      );
      expect(verdict.verdict).toBe('UNAVAILABLE');
      expect(ctx.textClassifier.classify).not.toHaveBeenCalled();
      expect(ctx.scanner.detect).not.toHaveBeenCalled();
    });
  });

  describe('preflight', () => {
    it('foto adulta limpa: segue, grava a checagem e marca safetyCheckedAt', async () => {
      const ctx = setup({ inputs: [{ url: PHOTO, mimeType: 'image/png' }] });
      const outcome = await ctx.service.preflight(imageJob());
      expect(outcome).toEqual({ action: 'proceed', status: 'clean' });
      expect(ctx.stored).toHaveLength(1);
      expect(ctx.stored[0]).toMatchObject({
        generationId: GEN,
        userId: USER,
        stage: 'INPUT',
        mediaKey: `inputs/${GEN}/u/foto.png`,
        verdict: 'CLEAN',
        enforced: false,
        mode: 'shadow',
        rulesVersion: RULES_VERSION,
        scanner: 'rekognition',
      });
      // nada de URL nem de caixa do rosto no registro
      expect(JSON.stringify(ctx.stored)).not.toContain('X-Amz');
      expect(JSON.stringify(ctx.stored[0].scores)).not.toContain('box');
      expect(ctx.prisma.generation.updateMany).toHaveBeenCalledWith({
        where: { id: GEN, status: GenerationStatus.PROCESSING },
        data: { safetyCheckedAt: expect.any(Date) },
      });
    });

    it('criança evidente em pedido sexual (E2): barra, evidência, lista de bloqueio e IMAGE_MINOR_BLOCKED', async () => {
      const ctx = setup({
        generation: { modelUsed: 'sem-censura' },
        inputs: [{ url: PHOTO, mimeType: 'image/png' }],
        scans: { [PHOTO_BYTES]: scan({ faces: [face(6, 10)] }) },
      });
      const job = imageJob({ model: 'sem-censura' });
      const error = await ctx.service.preflight(job).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InputImageSafetyBlockError);
      expect(error).toMatchObject({
        failureCode: 'IMAGE_SAFETY_BLOCKED',
        ruleId: 'E2',
        strength: 'STRONG',
      });
      expect(ctx.contentSafety.record).toHaveBeenCalledWith({
        userId: USER,
        kind: ContentSafetyEventKind.IMAGE_MINOR_BLOCKED,
        route: 'input:generate',
        match: 'E2/STRONG',
        excerpt: null,
        generationId: GEN,
      });
      expect(ctx.uploads.moveToEvidence).toHaveBeenCalledWith(
        'input-private',
        `inputs/${GEN}/u/foto.png`,
        expect.any(String),
        expect.objectContaining({ body: expect.any(Buffer) }),
      );
      expect(ctx.blocklist.add).toHaveBeenCalledWith(
        expect.objectContaining({
          phash: '0123456789abcdef',
          strength: 'STRONG',
          origin: 'input',
          eventId: 'evt-1',
        }),
      );
      expect(ctx.stored[0]).toMatchObject({
        verdict: 'BLOCK',
        ruleId: 'E2',
        enforced: true,
        evidenceKey: `evidence/h/inputs/${GEN}/u/foto.png`,
      });
    });

    it('caso leve (criança em pedido comum, E2 não sexual): barra sem evento, apaga a foto, nunca entra na lista', async () => {
      const ctx = setup({
        inputs: [{ url: PHOTO, mimeType: 'image/png' }],
        scans: { [PHOTO_BYTES]: scan({ faces: [face(6, 10)] }) },
      });
      const error = await ctx.service
        .preflight(imageJob())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InputImageSafetyBlockError);
      expect(error).toMatchObject({ strength: 'LIGHT' });
      expect(ctx.contentSafety.record).not.toHaveBeenCalled();
      expect(ctx.uploads.deleteStoredObject).toHaveBeenCalledWith(
        'input-private',
        `inputs/${GEN}/u/foto.png`,
      );
      expect(ctx.uploads.moveToEvidence).not.toHaveBeenCalled();
      expect(ctx.blocklist.add).not.toHaveBeenCalled();
      // dado de criança no caso leve: só veredito, regra e data (sem hash, pHash, chave do arquivo nem idades)
      expect(ctx.stored).toHaveLength(1);
      expect(ctx.stored[0]).toMatchObject({
        verdict: 'BLOCK',
        ruleId: 'E2',
        strength: 'LIGHT',
        sha256: null,
        phash: null,
      });
      expect(String(ctx.stored[0].mediaKey)).toMatch(/^light:[0-9a-f]{12}$/);
      expect(JSON.stringify(ctx.stored[0].scores)).not.toContain('age');
      expect(JSON.stringify(ctx.stored[0])).not.toContain('foto.png');
    });

    it('provável menor em pedido sexual (E3a): IN_REVIEW sem gerar, INPUT_HELD, foto fica no privado', async () => {
      const ctx = setup({
        generation: { modelUsed: 'sem-censura' },
        inputs: [{ url: PHOTO, mimeType: 'image/png' }],
        scans: { [PHOTO_BYTES]: scan({ faces: [face(14, 19)] }) },
      });
      const outcome = await ctx.service.preflight(
        imageJob({ model: 'sem-censura' }),
      );
      expect(outcome).toEqual({ action: 'held' });
      expect(ctx.prisma.generation.updateMany).toHaveBeenCalledWith({
        where: { id: GEN, status: GenerationStatus.PROCESSING },
        data: {
          status: GenerationStatus.IN_REVIEW,
          safetyCheckedAt: expect.any(Date),
        },
      });
      expect(ctx.contentSafety.record).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: ContentSafetyEventKind.INPUT_HELD,
          route: 'input:generate',
          match: 'E3a/MEDIUM',
        }),
      );
      expect(ctx.uploads.moveToEvidence).not.toHaveBeenCalled();
      expect(ctx.stored[0]).toMatchObject({ verdict: 'HOLD', enforced: true });
    });

    it('E3a com a foto ainda no bucket público: ela sai do público para a evidência', async () => {
      const ctx = setup({
        generation: { modelUsed: 'sem-censura' },
        inputs: [
          {
            url: `https://cdn.test/inputs/${GEN}/u/foto.png`,
            mimeType: 'image/png',
          },
        ],
        scans: { [PHOTO_BYTES]: scan({ faces: [face(14, 19)] }) },
      });
      await expect(
        ctx.service.preflight(imageJob({ model: 'sem-censura' })),
      ).resolves.toEqual({ action: 'held' });
      expect(ctx.uploads.moveToEvidence).toHaveBeenCalledWith(
        'public',
        `inputs/${GEN}/u/foto.png`,
        expect.any(String),
        expect.anything(),
      );
    });

    it('sombra: regra fora do 1º dia (E3b) só registra, segue com status flagged', async () => {
      const ctx = setup({
        inputs: [{ url: PHOTO, mimeType: 'image/png' }],
        scans: { [PHOTO_BYTES]: scan({ faces: [face(14, 19)] }) },
      });
      const outcome = await ctx.service.preflight(imageJob());
      expect(outcome).toEqual({ action: 'proceed', status: 'flagged' });
      expect(ctx.stored[0]).toMatchObject({
        verdict: 'BLOCK',
        ruleId: 'E3b',
        enforced: false,
      });
      expect(ctx.uploads.deleteStoredObject).not.toHaveBeenCalled();
    });

    it('enforce: a mesma E3b age (barra, caso leve)', async () => {
      const ctx = setup({
        config: configFor({ IMAGE_SAFETY_MODE: 'enforce' }),
        inputs: [{ url: PHOTO, mimeType: 'image/png' }],
        scans: { [PHOTO_BYTES]: scan({ faces: [face(14, 19)] }) },
      });
      const error = await ctx.service
        .preflight(imageJob())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InputImageSafetyBlockError);
      expect(ctx.stored[0]).toMatchObject({
        ruleId: 'E3b',
        enforced: true,
        mode: 'enforce',
      });
    });

    it('sombra sem IMAGE_SAFETY_ENFORCE_STRONG: só observa, nem a E2 sexual age', async () => {
      const ctx = setup({
        config: configFor({
          IMAGE_SAFETY_MODE: 'shadow',
          IMAGE_SAFETY_ENFORCE_STRONG: 'false',
        }),
        generation: { modelUsed: 'sem-censura' },
        inputs: [{ url: PHOTO, mimeType: 'image/png' }],
        scans: { [PHOTO_BYTES]: scan({ faces: [face(6, 10)] }) },
      });
      await expect(
        ctx.service.preflight(imageJob({ model: 'sem-censura' })),
      ).resolves.toEqual({ action: 'proceed', status: 'flagged' });
      expect(ctx.stored[0]).toMatchObject({
        verdict: 'BLOCK',
        enforced: false,
      });
      expect(ctx.contentSafety.record).not.toHaveBeenCalled();
    });

    it('vídeo de entrada com o pior quadro no meio: E7 com a regra do quadro', async () => {
      const ctx = setup({
        generation: {
          modelUsed: 'wavespeed-ltx-spicy',
          type: 'IMAGE_TO_VIDEO',
        },
        inputs: [{ url: PRIVATE('mov.mp4'), mimeType: 'video/mp4' }],
        frames: 3,
        scans: { 'frame-1': scan({ faces: [face(5, 9)] }) },
      });
      const error = await ctx.service
        .preflight({
          name: GenerationJobName.WAVESPEED_IMAGE_TO_VIDEO,
          data: { generationId: GEN, userId: USER },
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InputImageSafetyBlockError);
      expect(error).toMatchObject({ ruleId: 'E7:E2' });
      expect(ctx.stored.map((row) => row.stage)).toEqual([
        'INPUT_FRAME',
        'INPUT_FRAME',
        'INPUT_FRAME',
      ]);
      expect(ctx.stored[1]).toMatchObject({ verdict: 'BLOCK', ruleId: 'E2' });
      expect(ctx.contentSafety.record).toHaveBeenCalledWith(
        expect.objectContaining({ match: 'E7:E2/STRONG' }),
      );
      // pHash dos quadros entra na lista, sem o sha256 do vídeo inteiro
      expect(ctx.blocklist.add).toHaveBeenCalledWith(
        expect.objectContaining({ sha256: null, origin: 'input' }),
      );
    });

    describe('fornecedor fora do ar', () => {
      const down = () =>
        setup({
          inputs: [{ url: PHOTO, mimeType: 'image/png' }],
          scans: {
            [PHOTO_BYTES]: new SafetyProviderUnavailableError(
              'rekognition',
              'timeout',
              'us-east-1',
            ),
          },
        });

      it('volta à fila com espera de 30 s na 1ª vez e grava a checagem indisponível', async () => {
        const ctx = down();
        const before = Date.now();
        const error = await ctx.service
          .preflight(imageJob())
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SafetyCheckPendingError);
        const pending = error as SafetyCheckPendingError;
        expect(pending.delayMs).toBe(30_000);
        expect(pending.deferrals).toBe(0);
        expect(pending.firstAttemptAt).toBeGreaterThanOrEqual(before);
        expect(ctx.stored[0]).toMatchObject({
          verdict: 'UNAVAILABLE',
          ruleId: 'UNAVAILABLE',
          enforced: true,
          scanner: 'rekognition',
        });
        // pendente não marca o fim da checagem
        expect(ctx.prisma.generation.updateMany).not.toHaveBeenCalled();
      });

      it('espera crescente com teto de 2 min', async () => {
        const ctx = down();
        const error = await ctx.service
          .preflight(
            imageJob({
              safetyFirstAttemptAt: Date.now() - 60_000,
              safetyDeferrals: 3,
            }),
          )
          .catch((e: unknown) => e);
        expect((error as SafetyCheckPendingError).delayMs).toBe(120_000);
      });

      it('janela de 10 min vencida: terminal, com estorno', async () => {
        const ctx = down();
        const error = await ctx.service
          .preflight(
            imageJob({
              safetyFirstAttemptAt: Date.now() - 11 * 60_000,
              safetyDeferrals: 6,
            }),
          )
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SafetyCheckUnavailableError);
        expect(error).toMatchObject({
          failureCode: 'SAFETY_CHECK_UNAVAILABLE',
        });
      });

      it('sem fila (run*Directly): terminal na hora', async () => {
        const ctx = down();
        const error = await ctx.service
          .preflight(imageJob(), { queued: false })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SafetyCheckUnavailableError);
      });

      it('arquivo ilegível: terminal na hora (esperar não adianta)', async () => {
        const ctx = setup({
          inputs: [{ url: PHOTO, mimeType: 'image/png' }],
          scans: {
            [PHOTO_BYTES]: new SafetyProviderUnavailableError(
              'normalize',
              'invalid_media',
            ),
          },
        });
        const error = await ctx.service
          .preflight(imageJob())
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SafetyCheckUnavailableError);
      });

      it('mídia do job fora do nosso storage nunca é baixada: terminal', async () => {
        const ctx = setup({ inputs: [] });
        const error = await ctx.service
          .preflight({
            name: GenerationJobName.IMAGE_NANO_BANANA,
            data: {
              generationId: GEN,
              userId: USER,
              imageUrls: ['https://outro.site/foto.png'],
            },
          })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SafetyCheckUnavailableError);
        expect(ctx.uploads.readStoredObject).not.toHaveBeenCalled();
      });

      it('banco fora do ar no meio do preflight: pendente, nunca segue', async () => {
        const ctx = setup({ inputs: [{ url: PHOTO }] });
        ctx.prisma.generation.findUnique.mockRejectedValueOnce(
          new Error('db down'),
        );
        const error = await ctx.service
          .preflight(imageJob())
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SafetyCheckPendingError);
      });
    });

    it('nova tentativa do job: reaproveita a checagem gravada, sem chamar o leitor de novo', async () => {
      const ctx = setup({ inputs: [{ url: PHOTO, mimeType: 'image/png' }] });
      await ctx.service.preflight(imageJob());
      expect(ctx.scanner.detect).toHaveBeenCalledTimes(1);
      await expect(ctx.service.preflight(imageJob())).resolves.toEqual({
        action: 'proceed',
        status: 'clean',
      });
      expect(ctx.scanner.detect).toHaveBeenCalledTimes(1);
      expect(ctx.stored).toHaveLength(1);
    });

    it('hold da rodada anterior gravado sem pôr a geração em revisão: a nova tentativa aplica o hold (não conclui o job)', async () => {
      const ctx = setup({
        generation: { modelUsed: 'sem-censura' },
        inputs: [{ url: PHOTO, mimeType: 'image/png' }],
        existingScans: [
          {
            generationId: GEN,
            stage: 'INPUT',
            verdict: 'HOLD',
            ruleId: 'E3a',
            strength: 'MEDIUM',
            enforced: true,
            mediaKey: `inputs/${GEN}/u/foto.png`,
            sha256: 'd'.repeat(64),
            rulesVersion: RULES_VERSION,
            createdAt: new Date('2026-10-17T09:00:00Z'),
          },
        ],
      });
      await expect(
        ctx.service.preflight(imageJob({ model: 'sem-censura' })),
      ).resolves.toEqual({ action: 'held' });
      expect(ctx.prisma.generation.updateMany).toHaveBeenCalledWith({
        where: { id: GEN, status: GenerationStatus.PROCESSING },
        data: {
          status: GenerationStatus.IN_REVIEW,
          safetyCheckedAt: expect.any(Date),
        },
      });
      expect(ctx.scanner.detect).not.toHaveBeenCalled();
    });

    it('texto lido antes da foto: a nudez da entrada torna o pedido sexual e o negativo é decidido de novo', async () => {
      const ctx = setup({
        config: configFor(
          { IMAGE_SAFETY_MODE: 'shadow' },
          { textMode: 'enforce' },
        ),
        generation: { prompt: 'retrato na praia', negativePrompt: 'marcador' },
        inputs: [{ url: PHOTO, mimeType: 'image/png' }],
        scans: {
          [PHOTO_BYTES]: scan({
            moderation: [
              {
                name: 'Implied Nudity',
                parent: 'Non-Explicit Nudity of Intimate parts and Kissing',
                confidence: 80,
                taxonomyLevel: 3,
              },
            ],
          }),
        },
        text: textVerdict(),
      });
      ctx.textClassifier.withSexualRequest.mockImplementation(() =>
        textVerdict({
          verdict: 'HOLD',
          ruleId: 'T_NEGATIVE',
          strength: 'MEDIUM',
          reason: 'marcador de maturidade no negativo em pedido sexual (1)',
        }),
      );
      await expect(ctx.service.preflight(imageJob())).resolves.toEqual({
        action: 'held',
      });
      expect(ctx.textClassifier.classify).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sexualRequest: false }),
      );
      expect(ctx.textClassifier.withSexualRequest).toHaveBeenCalledTimes(1);
      expect(ctx.stored).toContainEqual(
        expect.objectContaining({ stage: 'TEXT', ruleId: 'T_NEGATIVE' }),
      );
    });

    it('pedido já sexual antes das fotos: o texto não é decidido de novo', async () => {
      const ctx = setup({
        config: configFor(
          { IMAGE_SAFETY_MODE: 'shadow' },
          { textMode: 'enforce' },
        ),
        generation: { modelUsed: 'sem-censura' },
        inputs: [{ url: PHOTO, mimeType: 'image/png' }],
        text: textVerdict(),
      });
      await ctx.service.preflight(imageJob({ model: 'sem-censura' }));
      expect(ctx.textClassifier.withSexualRequest).not.toHaveBeenCalled();
    });

    it('cache de sinais pelo sha256 do arquivo: o leitor não é chamado e a lista de bloqueio é conferida de novo', async () => {
      const ctx = setup({
        inputs: [{ url: PHOTO, mimeType: 'image/png' }],
        cacheRow: {
          scores: {
            faces: [
              {
                ageLow: 30,
                ageHigh: 38,
                ageMid: 34,
                confidence: 99,
                fromCrop: false,
              },
            ],
          },
          phash: 'fedcba9876543210',
          sha256: 'c'.repeat(64),
        },
      });
      await expect(ctx.service.preflight(imageJob())).resolves.toEqual({
        action: 'proceed',
        status: 'clean',
      });
      expect(ctx.scanner.detect).not.toHaveBeenCalled();
      expect(ctx.blocklist.match).toHaveBeenCalledWith(
        'fedcba9876543210',
        'c'.repeat(64),
        8,
      );
      expect(ctx.stored[0]).toMatchObject({ scanner: 'cache' });
    });

    it('geração já encerrada ou segurada: não despacha', async () => {
      const ctx = setup({ generation: { status: GenerationStatus.IN_REVIEW } });
      await expect(ctx.service.preflight(imageJob())).resolves.toEqual({
        action: 'skip',
      });
      expect(ctx.scanner.detect).not.toHaveBeenCalled();
    });

    it('áudio não é checado por imagem; sem mídia visual o status é do texto (e sem texto, unavailable)', async () => {
      const ctx = setup({
        inputs: [{ url: PRIVATE('voz.mp3'), mimeType: 'audio/mpeg' }],
      });
      await expect(ctx.service.preflight(imageJob())).resolves.toEqual({
        action: 'proceed',
        status: 'unavailable',
      });
      expect(ctx.uploads.readStoredObject).not.toHaveBeenCalled();
    });

    describe('texto (camada 2)', () => {
      const textConfig = (mode: 'shadow' | 'enforce') =>
        configFor({ IMAGE_SAFETY_MODE: 'shadow' }, { textMode: mode });

      it('sinal forte na sombra age: TextSafetyBlockError + TEXT_CLASSIFIER_FLAGGED, com o mesmo código público', async () => {
        const ctx = setup({
          config: textConfig('shadow'),
          inputs: [],
          text: textVerdict({
            verdict: 'BLOCK',
            ruleId: 'T_CLASSIFIER',
            strength: 'STRONG',
          }),
        });
        const error = await ctx.service
          .preflight(imageJob({ hasInputImages: false }))
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(TextSafetyBlockError);
        expect(error).toMatchObject({ failureCode: 'IMAGE_SAFETY_BLOCKED' });
        expect(ctx.contentSafety.record).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: ContentSafetyEventKind.TEXT_CLASSIFIER_FLAGGED,
            route: 'text:generate',
            excerpt: null,
          }),
        );
        expect(ctx.stored[0]).toMatchObject({
          stage: 'TEXT',
          verdict: 'BLOCK',
          enforced: true,
        });
        // o texto do pedido nunca vai para o registro
        expect(JSON.stringify(ctx.stored)).not.toContain('retrato');
      });

      it('faixa média na sombra só registra; o status do texto entra no preflight', async () => {
        const ctx = setup({
          config: textConfig('shadow'),
          inputs: [{ url: PHOTO, mimeType: 'image/png' }],
          text: textVerdict({
            verdict: 'BLOCK',
            ruleId: 'T_AMBIGUOUS',
            strength: 'NONE',
          }),
        });
        await expect(ctx.service.preflight(imageJob())).resolves.toEqual({
          action: 'proceed',
          status: 'flagged',
        });
      });

      it('enforce: marcador no negativo segura a geração (INPUT_HELD pelo texto)', async () => {
        const ctx = setup({
          config: textConfig('enforce'),
          inputs: [],
          text: textVerdict({
            verdict: 'HOLD',
            ruleId: 'T_NEGATIVE',
            strength: 'MEDIUM',
          }),
        });
        await expect(
          ctx.service.preflight(imageJob({ hasInputImages: false })),
        ).resolves.toEqual({ action: 'held' });
        expect(ctx.contentSafety.record).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: ContentSafetyEventKind.INPUT_HELD,
            route: 'text:generate',
          }),
        );
      });

      it('enforce: classificador fora com foto volta à fila; texto puro em modelo com filtro segue', async () => {
        const unavailable = textVerdict({
          verdict: 'UNAVAILABLE',
          ruleId: 'UNAVAILABLE',
          strength: 'NONE',
          results: [],
          sexualIntent: null,
        });
        const withPhoto = setup({
          config: configFor({}, { textMode: 'enforce' }),
          inputs: [{ url: PHOTO }],
          text: unavailable,
        });
        await expect(
          withPhoto.service.preflight(imageJob()),
        ).rejects.toBeInstanceOf(SafetyCheckPendingError);
        const textOnly = setup({
          config: configFor({}, { textMode: 'enforce' }),
          inputs: [],
          text: unavailable,
        });
        await expect(
          textOnly.service.preflight(imageJob({ hasInputImages: false })),
        ).resolves.toEqual({ action: 'proceed', status: 'unavailable' });
      });
    });
  });

  describe('checkOutput', () => {
    const completion = {
      modelUsed: 'nano-banana-2',
      provider: 'kie',
      processingTimeMs: 4200,
    };
    const OUT = QUARANTINE('output_0.png');
    const OUT_BYTES = `bytes:generations/${GEN}/q/output_0.png`;

    it('limpo: promove da quarentena (sem baixar de novo) e devolve a URL pública', async () => {
      const ctx = setup();
      const outcome = await ctx.service.checkOutput(GEN, [OUT], completion);
      expect(outcome).toEqual({
        action: 'promote',
        outputs: [`https://cdn.test/generations/${GEN}/pub/output_0.png`],
      });
      // 1ª fase copia (com os bytes já lidos), 2ª apaga a quarentena
      expect(ctx.uploads.copyQuarantineToPublic).toHaveBeenCalledWith(
        `generations/${GEN}/q/output_0.png`,
        expect.objectContaining({ body: expect.any(Buffer) }),
      );
      expect(ctx.uploads.deleteQuarantineObject).toHaveBeenCalledWith(
        `generations/${GEN}/q/output_0.png`,
      );
      expect(ctx.stored[0]).toMatchObject({
        stage: 'OUTPUT',
        verdict: 'CLEAN',
      });
    });

    it('promoção que falha no meio: desfaz as cópias públicas e não apaga nada da quarentena', async () => {
      const ctx = setup();
      ctx.uploads.copyQuarantineToPublic
        .mockResolvedValueOnce({
          url: `https://cdn.test/generations/${GEN}/pub/output_0.png`,
          key: `generations/${GEN}/pub/output_0.png`,
        })
        .mockRejectedValueOnce(new Error('S3 fora'));
      const outcome = await ctx.service.checkOutput(
        GEN,
        [OUT, QUARANTINE('output_1.png')],
        completion,
      );
      expect(outcome).toEqual({ action: 'held' });
      expect(ctx.uploads.deleteStoredObject).toHaveBeenCalledWith(
        'public',
        `generations/${GEN}/pub/output_0.png`,
      );
      expect(ctx.uploads.deleteQuarantineObject).not.toHaveBeenCalled();
    });

    it('MiniMax H3: o id técnico do provedor não apaga o "sem censura" do pedido (S2b continua valendo)', async () => {
      const ctx = setup({
        config: configFor({ IMAGE_SAFETY_MODE: 'enforce' }),
        generation: {
          modelUsed: 'wavespeed-minimax-h3',
          type: 'IMAGE_TO_VIDEO',
          prompt: 'caminhando na praia',
        },
        scans: {
          [OUT_BYTES]: scan({
            faces: [face(14, 18)],
            moderation: [
              {
                name: 'Female Swimwear or Underwear',
                parent: 'Swimwear or Underwear',
                confidence: 80,
                taxonomyLevel: 2,
              },
            ],
          }),
        },
      });
      const outcome = await ctx.service.checkOutput(GEN, [OUT], {
        modelUsed: 'wavespeed-ai/minimax-h3/image-to-video',
        provider: 'wavespeed',
        processingTimeMs: 9000,
      });
      expect(outcome).toEqual({ action: 'held' });
      expect(ctx.stored[0]).toMatchObject({
        verdict: 'HOLD',
        ruleId: 'S2b',
      });
    });

    it('menor com nudez (S1): evidência, OUTPUT_MINOR_BLOCKED, entradas guardadas, nada publicado', async () => {
      const ctx = setup({
        generation: { modelUsed: 'sem-censura' },
        inputs: [{ url: PHOTO }],
        scans: {
          [OUT_BYTES]: scan({ faces: [face(6, 10)], moderation: NUDITY }),
        },
      });
      const outcome = await ctx.service.checkOutput(GEN, [OUT], {
        ...completion,
        modelUsed: 'sem-censura',
      });
      expect(outcome.action).toBe('blocked');
      if (outcome.action !== 'blocked') return;
      expect(outcome.error).toBeInstanceOf(OutputImageSafetyBlockError);
      expect(outcome.error).toMatchObject({ ruleId: 'S1', strength: 'STRONG' });
      expect(ctx.contentSafety.record).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: ContentSafetyEventKind.OUTPUT_MINOR_BLOCKED,
          route: 'output:sem-censura',
          match: 'S1/STRONG',
        }),
      );
      expect(ctx.uploads.moveToEvidence).toHaveBeenCalledWith(
        'quarantine',
        `generations/${GEN}/q/output_0.png`,
        expect.any(String),
        expect.anything(),
      );
      // a foto enviada também vai para a evidência
      expect(ctx.uploads.moveToEvidence).toHaveBeenCalledWith(
        'input-private',
        `inputs/${GEN}/u/foto.png`,
        null,
      );
      // ... e fica LIGADA à geração (linha própria, já que a entrada não tinha checagem gravada)
      expect(ctx.stored).toContainEqual(
        expect.objectContaining({
          generationId: GEN,
          stage: 'INPUT',
          mediaKey: `inputs/${GEN}/u/foto.png`,
          evidenceKey: `evidence/h/inputs/${GEN}/u/foto.png`,
          scanner: 'output-linked',
        }),
      );
      expect(outcome.error.evidencePending).toBe(false);
      expect(ctx.uploads.copyQuarantineToPublic).not.toHaveBeenCalled();
      expect(ctx.blocklist.add).toHaveBeenCalledWith(
        expect.objectContaining({ origin: 'output', strength: 'STRONG' }),
      );
    });

    it('menor no resultado com a evidência fora do ar: o erro sai com evidência pendente (o encerramento não limpa)', async () => {
      const ctx = setup({
        generation: { modelUsed: 'sem-censura' },
        inputs: [{ url: PHOTO }],
        scans: {
          [OUT_BYTES]: scan({ faces: [face(6, 10)], moderation: NUDITY }),
        },
      });
      ctx.uploads.moveToEvidence.mockRejectedValue(new Error('S3 fora'));
      const outcome = await ctx.service.checkOutput(GEN, [OUT], {
        ...completion,
        modelUsed: 'sem-censura',
      });
      expect(outcome.action).toBe('blocked');
      if (outcome.action !== 'blocked') return;
      expect(outcome.error.evidencePending).toBe(true);
    });

    it('criança sem nudez (S4): IN_REVIEW com a saída guardada, OUTPUT_HELD, nada publicado', async () => {
      const ctx = setup({
        scans: { [OUT_BYTES]: scan({ faces: [face(4, 8)] }) },
      });
      await expect(
        ctx.service.checkOutput(GEN, [OUT], completion),
      ).resolves.toEqual({
        action: 'held',
      });
      expect(ctx.contentSafety.record).toHaveBeenCalledWith(
        expect.objectContaining({ kind: ContentSafetyEventKind.OUTPUT_HELD }),
      );
      const update = ctx.prisma.generation.updateMany.mock
        .calls[0][0] as unknown as {
        data: {
          status: string;
          parameters: { safetyHold: Record<string, unknown> };
        };
      };
      expect(update.data.status).toBe(GenerationStatus.IN_REVIEW);
      expect(update.data.parameters.safetyHold).toMatchObject({
        stage: 'output',
        outputs: [
          {
            area: 'quarantine',
            key: `generations/${GEN}/q/output_0.png`,
            mimeType: 'image/png',
          },
        ],
        modelUsed: 'nano-banana-2',
        provider: 'kie',
        processingTimeMs: 4200,
      });
      expect(ctx.uploads.promoteFromQuarantine).not.toHaveBeenCalled();
    });

    it('leitor fora do ar: segura aguardando checagem, sem evento', async () => {
      const ctx = setup({
        scans: {
          [OUT_BYTES]: new SafetyProviderUnavailableError(
            'rekognition',
            'throttled',
          ),
        },
      });
      await expect(
        ctx.service.checkOutput(GEN, [OUT], completion),
      ).resolves.toEqual({
        action: 'held',
      });
      expect(ctx.contentSafety.record).not.toHaveBeenCalled();
      expect(ctx.stored[0]).toMatchObject({
        verdict: 'UNAVAILABLE',
        enforced: true,
      });
    });

    it('áudio sai da quarentena sem passar pelo leitor de imagem', async () => {
      const ctx = setup();
      const outcome = await ctx.service.checkOutput(
        GEN,
        [QUARANTINE('output_0.mp3')],
        completion,
      );
      expect(outcome.action).toBe('promote');
      expect(ctx.scanner.detect).not.toHaveBeenCalled();
    });

    it('nunca lança: erro inesperado vira resultado segurado', async () => {
      const ctx = setup();
      ctx.prisma.generation.findUnique.mockRejectedValueOnce(
        new Error('db down'),
      );
      await expect(
        ctx.service.checkOutput(GEN, [OUT], completion),
      ).resolves.toEqual({
        action: 'held',
      });
    });

    it('vídeo de resultado: 1 quadro com menor e nudez barra o vídeo inteiro', async () => {
      const ctx = setup({
        generation: { modelUsed: 'wavespeed-ltx-spicy', type: 'TEXT_TO_VIDEO' },
        frames: 4,
        scans: {
          'frame-2': scan({ faces: [face(12, 16)], moderation: NUDITY }),
        },
      });
      const outcome = await ctx.service.checkOutput(
        GEN,
        [QUARANTINE('output_0.mp4')],
        {
          ...completion,
          modelUsed: 'wavespeed-ltx-spicy',
        },
      );
      expect(outcome.action).toBe('blocked');
      expect(
        ctx.stored.filter((row) => row.stage === 'OUTPUT_FRAME'),
      ).toHaveLength(4);
    });
  });

  describe('refinador', () => {
    it('reescrita acusada que age: REFINER_BLOCKED e bloqueio terminal; a linha não entra no preflight', async () => {
      const config = configFor(
        { IMAGE_SAFETY_MODE: 'shadow' },
        { textMode: 'shadow' },
      );
      const ctx = setup({
        config,
        text: textVerdict({
          verdict: 'BLOCK',
          ruleId: 'T_REFINER',
          strength: 'MEDIUM',
        }),
      });
      const block = await ctx.service.checkRefinedPrompt(
        GEN,
        'texto reescrito',
        'veo3',
      );
      expect(block).toBeInstanceOf(UnverifiedContentBlockError);
      expect(block).toMatchObject({ source: 'refiner_flagged' });
      expect(ctx.textClassifier.classify).toHaveBeenCalledWith(
        { prompt: null, negative: null, serverPrompt: 'texto reescrito' },
        { sexualRequest: false, source: 'refiner' },
      );
      expect(ctx.contentSafety.record).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: ContentSafetyEventKind.REFINER_BLOCKED,
          route: 'refiner:veo3',
        }),
      );
      expect(ctx.stored[0]).toMatchObject({
        stage: 'TEXT',
        mediaKey: REFINER_TEXT_MEDIA_KEY,
      });
    });
  });

  describe('quarentena (cron)', () => {
    it('entrada segurada que venceu: a foto vai para a evidência e o encerramento usa o código genérico', async () => {
      const ctx = setup({
        existingScans: [
          {
            id: 's1',
            generationId: GEN,
            stage: 'INPUT',
            verdict: 'HOLD',
            ruleId: 'E3a',
            strength: 'MEDIUM',
            mediaKey: `inputs/${GEN}/u/foto.png`,
            sha256: 'd'.repeat(64),
            evidenceKey: null,
            createdAt: new Date('2026-10-16T10:00:00Z'),
          },
        ],
      });
      const error = await ctx.service.expireHeldInput(GEN);
      expect(error).toBeInstanceOf(InputImageSafetyBlockError);
      expect(error).toMatchObject({
        failureCode: 'IMAGE_SAFETY_BLOCKED',
        ruleId: 'E3a',
      });
      expect(ctx.uploads.moveToEvidence).toHaveBeenCalledWith(
        'input-private',
        `inputs/${GEN}/u/foto.png`,
        'd'.repeat(64),
      );
      expect(ctx.prisma.contentSafetyScan.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { evidenceKey: `evidence/h/inputs/${GEN}/u/foto.png` },
      });
    });

    const heldParameters = (
      area: 'quarantine' | 'public',
      extra: Record<string, unknown> = {},
    ) => ({
      safetyHold: {
        stage: 'output',
        outputs: [
          {
            area,
            key: `generations/${GEN}/q/a.png`,
            mimeType: 'image/png',
          },
        ],
        modelUsed: 'sem-censura',
        provider: null,
        processingTimeMs: 10,
        heldAt: '2026-10-16T08:00:00.000Z',
        ...extra,
      },
    });

    it('resultado em revisão que venceu: vai inteiro para a evidência (com as entradas, se o sinal é médio)', async () => {
      const ctx = setup({
        generation: {
          status: GenerationStatus.IN_REVIEW,
          modelUsed: 'sem-censura',
          parameters: heldParameters('quarantine'),
        },
        inputs: [{ url: PHOTO }],
        existingScans: [
          {
            generationId: GEN,
            stage: 'OUTPUT',
            verdict: 'HOLD',
            ruleId: 'S2b',
            strength: 'MEDIUM',
            enforced: true,
            mediaKey: `generations/${GEN}/q/a.png`,
            sha256: 'e'.repeat(64),
            createdAt: new Date('2026-10-16T08:00:00Z'),
          },
        ],
      });
      const error = await ctx.service.expireReviewedOutput(GEN);
      expect(error).toBeInstanceOf(OutputImageSafetyBlockError);
      expect(error).toMatchObject({
        ruleId: 'S2b',
        strength: 'MEDIUM',
        evidencePending: false,
      });
      expect(ctx.uploads.moveToEvidence).toHaveBeenCalledWith(
        'quarantine',
        `generations/${GEN}/q/a.png`,
        null,
        expect.anything(),
      );
      expect(ctx.uploads.moveToEvidence).toHaveBeenCalledWith(
        'input-private',
        `inputs/${GEN}/u/foto.png`,
        null,
      );
      expect(ctx.uploads.copyQuarantineToPublic).not.toHaveBeenCalled();
      expect(ctx.blocklist.add).not.toHaveBeenCalled();
    });

    it('resultado sem checagem que venceu sem bucket de quarentena: o arquivo público também é apagado', async () => {
      const ctx = setup({
        generation: {
          status: GenerationStatus.IN_REVIEW,
          parameters: heldParameters('public'),
        },
      });
      await ctx.service.discardHeldOutput(GEN);
      expect(ctx.uploads.deleteStoredObject).toHaveBeenCalledWith(
        'public',
        `generations/${GEN}/q/a.png`,
      );
    });

    it('sem o registro da saída: apaga a pasta da geração só na quarentena', async () => {
      const ctx = setup({
        generation: { status: GenerationStatus.IN_REVIEW, parameters: {} },
      });
      await ctx.service.discardHeldOutput(GEN);
      expect(ctx.uploads.deleteQuarantinePrefix).toHaveBeenCalledWith(
        `generations/${GEN}/`,
      );
    });

    it('aviso de revisão vencida fica gravado no banco (sobrevive ao reinício)', async () => {
      const ctx = setup({
        generation: {
          status: GenerationStatus.IN_REVIEW,
          parameters: heldParameters('quarantine'),
        },
      });
      await ctx.service.markReviewAlerted(GEN);
      const update = ctx.prisma.generation.updateMany.mock
        .calls[0][0] as unknown as {
        where: Record<string, unknown>;
        data: { parameters: { safetyHold: Record<string, unknown> } };
      };
      expect(update.where).toEqual({
        id: GEN,
        status: GenerationStatus.IN_REVIEW,
      });
      expect(update.data.parameters.safetyHold.alertedAt).toEqual(
        expect.any(String),
      );
    });

    it('holdStateOf lê o motivo e a hora em que a saída foi segurada', async () => {
      const heldAt = '2026-10-17T08:00:00.000Z';
      const ctx = setup({
        generation: {
          status: GenerationStatus.IN_REVIEW,
          parameters: {
            safetyHold: {
              stage: 'output',
              outputs: [
                {
                  area: 'quarantine',
                  key: 'generations/gen-1/q/a.png',
                  mimeType: 'image/png',
                },
              ],
              modelUsed: 'gpt-image-2',
              provider: null,
              processingTimeMs: 10,
              heldAt,
            },
          },
        },
      });
      const state = await ctx.service.holdStateOf(GEN);
      expect(state).toMatchObject({
        reason: 'output_unchecked',
        modelUsed: 'gpt-image-2',
        heldAt: new Date(heldAt),
      });
    });
  });

  describe('outputSafetyModelOf', () => {
    it('o slug sem censura da geração vence o id técnico do provedor', () => {
      expect(
        outputSafetyModelOf(
          'wavespeed-minimax-h3',
          'wavespeed-ai/minimax-h3/image-to-video',
          {},
        ),
      ).toBe('wavespeed-minimax-h3');
    });

    it('desvio para o MiniMax a partir de modelo com filtro: o id técnico é reconhecido', () => {
      expect(
        outputSafetyModelOf(
          'veo-3-fast',
          'wavespeed-ai/minimax-h3/reference-to-video',
          {},
        ),
      ).toBe('wavespeed-minimax-h3');
    });

    it('sem nada sem censura: o id do provedor (ou o da geração)', () => {
      expect(outputSafetyModelOf('nano-banana-2', 'kie/nano-banana', {})).toBe(
        'kie/nano-banana',
      );
      expect(outputSafetyModelOf('nano-banana-2', '', {})).toBe(
        'nano-banana-2',
      );
    });
  });

  describe('checkInput (rotas sem fila)', () => {
    it('foto em memória com criança em pedido sexual: guarda a evidência a partir dos bytes', async () => {
      const ctx = setup({
        scans: { 'foto-em-memoria': scan({ faces: [face(6, 10)] }) },
      });
      const verdict = await ctx.service.checkInput(
        [
          {
            kind: 'image',
            mimeType: 'image/png',
            buffer: Buffer.from('foto-em-memoria'),
          },
        ],
        {
          userId: USER,
          generationId: null,
          model: null,
          tool: 'undress',
          type: null,
          hasUserMedia: true,
          sexual: { classifier: null, inputNudity: null },
          prompt: null,
          negativePrompt: null,
        },
      );
      expect(verdict).toMatchObject({
        verdict: 'BLOCK',
        ruleId: 'E2',
        strength: 'STRONG',
      });
      expect(ctx.service.actsOn(verdict)).toBe(true);
      expect(ctx.uploads.storeEvidence).toHaveBeenCalled();
      expect(ctx.stored[0]).toMatchObject({
        generationId: null,
        stage: 'INPUT',
      });
    });
  });

  describe('ferramenta e modelo deduzidos no servidor', () => {
    it.each([
      [{ jobData: { model: 'deepdeep' } }, 'undress'],
      [
        { jobName: GenerationJobName.FACE_SWAP, jobData: { nsfw: true } },
        'face_swap_unlocked',
      ],
      [{ type: 'FACE_SWAP', modelUsed: 'sem-censura' }, 'face_swap_unlocked'],
      [
        { jobName: GenerationJobName.FACE_SWAP, jobData: { nsfw: false } },
        'face_swap',
      ],
      [{ jobName: GenerationJobName.VIRTUAL_TRY_ON }, 'virtual_try_on'],
      [{ type: 'MOTION_CONTROL' }, 'motion_control'],
      [{ jobData: { model: 'nano-banana-2' } }, 'generate'],
    ] as const)('%j → %s', (input, tool) => {
      expect(safetyToolOf(input as never)).toBe(tool);
    });

    it('modo spicy do Grok conta como sem censura; o modelo resolvido do job vence o da geração', () => {
      expect(safetyModelOf({ mode: 'spicy' }, 'grok-imagine')).toBe(
        'grok-imagine:spicy',
      );
      expect(safetyModelOf({ resolvedModel: 'veo3-fast' }, 'veo3')).toBe(
        'veo3-fast',
      );
      expect(safetyModelOf({}, 'veo3')).toBe('veo3');
    });
  });
});
