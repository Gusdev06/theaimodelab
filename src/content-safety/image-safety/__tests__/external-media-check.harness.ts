import { isRuleEnforced, loadImageSafetyConfig } from '../image-safety.config';
import { ExternalMediaCheck } from '../external-media-check';
import { ImageSafetyService, type SafetyMediaToolkit } from '../image-safety.service';
import { NoopKnownHashMatcher } from '../known-csam.matcher';
import { NoopStylizedJudge } from '../stylized-judge.client';
import {
  SafetyProviderUnavailableError,
  type FaceSignal,
  type ModerationSignal,
  type ScannerResult,
  type TextVerdict,
} from '../types';

/**
 * Montagem de teste das rotas sem fila: o ImageSafetyService DE VERDADE (regras, modos, registro) com o leitor de
 * imagem simulado. A "foto" é só um texto em bytes; o leitor devolve rostos e rótulos inventados para esse texto.
 * Nenhuma imagem de pessoa, nenhuma chamada externa.
 */

export const face = (ageLow: number, ageHigh: number): FaceSignal => ({
  ageLow,
  ageHigh,
  ageMid: (ageLow + ageHigh) / 2,
  box: null,
  confidence: 99,
  fromCrop: false,
});

export const NUDITY: ModerationSignal[] = [
  { name: 'Explicit Nudity', parent: 'Explicit', confidence: 97, taxonomyLevel: 2 },
];

export const reading = (overrides: Partial<ScannerResult> = {}): ScannerResult => ({
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

/** Leituras simuladas usadas pelos testes das rotas (chave = conteúdo da "foto"). */
export const READINGS = {
  /** adulta vestida */
  adult: reading(),
  /** criança evidente (E2) */
  child: reading({ faces: [face(5, 9)] }),
  /** nudez com rosto de provável menor (E3a: segura) */
  minorNude: reading({ faces: [face(14, 18)], moderation: NUDITY }),
  /** nudez de adulta (a exceção 18+ do Clone de Prompt não pode ser desfeita) */
  adultNude: reading({ faces: [face(28, 36)], moderation: NUDITY }),
} as const;

/** Leitor que não responde até o prazo da checagem (ou para sempre, quando ignora o sinal). */
export const HANG = 'hang';
export const HANG_IGNORING_ABORT = 'hang-ignoring-abort';

type Scripted = ScannerResult | Error | typeof HANG | typeof HANG_IGNORING_ABORT;

type Row = Record<string, unknown>;

function matchesWhere(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, condition]) => {
    const value = row[field];
    if (condition === null) return value === null || value === undefined;
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      const ops = condition as Record<string, unknown>;
      if ('in' in ops) return (ops.in as unknown[]).includes(value);
      if ('gte' in ops) return value instanceof Date && value >= (ops.gte as Date);
      if ('not' in ops) return value !== ops.not;
      return true;
    }
    return value === condition;
  });
}

export interface MediaCheckHarnessOptions {
  mode?: 'off' | 'shadow' | 'enforce';
  env?: Record<string, string>;
  /** leitura por conteúdo da "foto" (texto dos bytes); sem entrada = adulta vestida */
  scans?: Record<string, Scripted>;
  /** geração lida pela checagem do resultado (webhook) */
  generation?: Row | null;
}

export function buildMediaCheck(options: MediaCheckHarnessOptions = {}) {
  const env: Record<string, string> = {
    S3_EVIDENCE_BUCKET: 'taml-evidencia',
    IMAGE_SAFETY_MODE: options.mode ?? 'shadow',
    ...(options.env ?? {}),
  };
  const { config } = loadImageSafetyConfig((key) => env[key]);
  const stored: Row[] = [];
  const generationRow = options.generation ?? null;

  const prisma = {
    contentSafetyScan: {
      createMany: jest.fn(async (args: { data: Row[] }) => {
        stored.push(...args.data.map((row) => ({ ...row })));
        return { count: args.data.length };
      }),
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) =>
        stored.filter((row) => matchesWhere(row, args.where)),
      ),
      findFirst: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(
        async (args: { where: Record<string, unknown>; data: Row }) => {
          const rows = stored.filter((row) => matchesWhere(row, args.where));
          for (const row of rows) Object.assign(row, args.data);
          return { count: rows.length };
        },
      ),
    },
    generation: {
      findUnique: jest.fn(async () => (generationRow ? { ...generationRow } : null)),
      updateMany: jest.fn(async (_args?: unknown) => ({ count: 1 })),
    },
    generationInputImage: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
    },
    contentSafetyEvent: { count: jest.fn(async () => 0) },
  };

  const uploads = {
    privateInputsEnabled: true,
    quarantineEnabled: true,
    quarantineConfigured: true,
    locateStoredMedia: jest.fn((url: string | null | undefined) => {
      if (!url) return null;
      const clean = url.split('?')[0];
      if (clean.startsWith('https://s3.test/quarentena/')) {
        return { area: 'quarantine', key: clean.slice('https://s3.test/quarentena/'.length) };
      }
      if (clean.startsWith('https://cdn.test/')) {
        return { area: 'public', key: clean.slice('https://cdn.test/'.length) };
      }
      return null;
    }),
    readStoredObject: jest.fn(async (_area: string, key: string) => ({
      body: Buffer.from(`bytes:${key}`),
      contentType: null as string | null,
    })),
    moveToEvidence: jest.fn(async (_area: string, key: string) => `evidence/h/${key}`),
    storeEvidence: jest.fn(async () => 'evidence/h/memoria'),
    deleteStoredObject: jest.fn(async () => undefined),
    copyQuarantineToPublic: jest.fn(async (key: string) => ({
      url: `https://cdn.test/${key.replace('/q/', '/pub/')}`,
      key: key.replace('/q/', '/pub/'),
    })),
    deleteQuarantineObject: jest.fn(async () => undefined),
    deleteQuarantinePrefix: jest.fn(async () => 0),
    getPublicUrl: jest.fn((key: string) => `https://cdn.test/${key}`),
    /** resultado de geração nasce na quarentena; o resto vai ao público (como o uploads.service com o modo ligado) */
    uploadBuffer: jest.fn(
      async (_body: Buffer, folder: string, filename: string, _contentType: string) =>
        folder.startsWith('generations/')
          ? `https://s3.test/quarentena/${folder}/q/${filename}?X-Amz-Expires=1800`
          : `https://cdn.test/${folder}/copia/${filename}`,
    ),
    uploadFromUrl: jest.fn(
      async (_url: string, folder: string, filename: string) =>
        `https://cdn.test/${folder}/direto/${filename}`,
    ),
  };

  const contentSafety = {
    record: jest.fn(async () => 'evt-1'),
    hasConsentForGeneration: jest.fn(async () => true),
  };
  const textClassifier = {
    classify: jest.fn(async () => null as TextVerdict | null),
    shouldAct: jest.fn((verdict: Pick<TextVerdict, 'ruleId' | 'strength'>) =>
      isRuleEnforced({ layer: 'text', ruleId: verdict.ruleId, strength: verdict.strength }, config),
    ),
    textSha256: jest.fn(() => 'f'.repeat(64)),
    withSexualRequest: jest.fn((verdict: TextVerdict) => verdict),
  };
  const blocklist = {
    match: jest.fn(async () => null),
    add: jest.fn(async () => 'block-1'),
    countRecent: jest.fn(async () => 0),
  };

  const scripts = options.scans ?? {};
  const scanner = {
    name: 'rekognition',
    detect: jest.fn(
      async (image: { jpeg: Buffer }, callOptions?: { signal?: AbortSignal }) => {
        const scripted = scripts[image.jpeg.toString()] ?? READINGS.adult;
        if (scripted === HANG_IGNORING_ABORT) return new Promise<ScannerResult>(() => undefined);
        if (scripted === HANG) {
          return new Promise<ScannerResult>((_, reject) => {
            const signal = callOptions?.signal;
            const fail = () => reject(new SafetyProviderUnavailableError('rekognition', 'timeout'));
            if (signal?.aborted) fail();
            signal?.addEventListener('abort', fail, { once: true });
          });
        }
        if (scripted instanceof Error) throw scripted;
        return scripted;
      },
    ),
  };
  const media: SafetyMediaToolkit = {
    normalizeImage: jest.fn(async (buffer: Buffer, mimeType: string | null) => [
      { jpeg: buffer, width: 1000, height: 1000, sha256: 'a'.repeat(64), sourceMimeType: mimeType },
    ]),
    sampleVideoFrames: jest.fn(async (buffer: Buffer) => [
      { jpeg: buffer, position: { index: 0, timeMs: 0 } },
    ]),
    phash: jest.fn(async () => '0123456789abcdef'),
  };

  const strikes = {
    enabled: config.imageMode !== 'off',
    applySignal: jest.fn(async () => ({
      action: 'point' as const,
      points: 1,
      causes: [],
      shadowCauses: [],
      linkedAccounts: [],
    })),
    isSuspended: jest.fn(async () => false),
    photoRetryAllowed: jest.fn(async () => true),
  };

  const imageSafety = new ImageSafetyService(
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
    strikes,
  );
  const check = new ExternalMediaCheck(
    imageSafety,
    uploads as never,
    contentSafety as never,
    prisma as never,
    strikes,
  );
  return {
    check,
    imageSafety,
    config,
    prisma,
    uploads,
    contentSafety,
    scanner,
    media,
    strikes,
    stored,
  };
}

export type MediaCheckHarness = ReturnType<typeof buildMediaCheck>;

/** A "foto" como o cliente de visão recebe (base64 dos bytes simulados). */
export const photoBase64 = (content: string): string =>
  Buffer.from(content).toString('base64');
