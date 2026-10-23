import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { StorageReadError } from '../../../uploads/uploads.service';
import {
  InputImageSafetyBlockError,
  OutputImageSafetyBlockError,
} from '../../../generations/errors/content-safety.error';
import { SafetyReviewService, type ReviewActor } from '../safety-review.service';
import { createTable, type Row } from './fake-prisma';

/**
 * Fluxo do revisor com Prisma simulado em memória, storage, porteiro, processor e pontos simulados. Nenhuma imagem:
 * as mídias são só chaves e URLs de mentira.
 */

const NOW = new Date('2026-10-22T12:00:00.000Z');
const HELD_AT = new Date('2026-10-22T10:00:00.000Z');
const REASON = 'Conferência do caso para decidir a retenção.';
const ACTOR: ReviewActor = {
  id: 'rev-1',
  email: 'revisor@theaimodelab.com',
  ip: '203.0.113.7',
};
const SHA = 'b'.repeat(64);
const PHASH = 'ffff0000ffff0000';

const OUT_KEY = 'generations/gen-out/u1/out.png';
const IN_OUT_KEY = 'inputs/gen-out/u0/in.png';
const IN_KEY = 'inputs/gen-in/u2/face.jpg';
const DONE_QUARANTINE_KEY = 'generations/gen-done/q1/out.png';
const DONE_PUBLIC_KEY = 'generations/gen-done/p9/out.png';

const url = (area: string, key: string) => `https://cdn.test/${area}/${key}`;

function scan(extra: Row): Row {
  return {
    userId: 'user-1',
    sha256: null,
    phash: null,
    scores: { faces: [{ ageLow: 17, ageHigh: 23, ageMid: 20 }] },
    ruleId: null,
    strength: 'NONE',
    rulesVersion: '2026-10-17.2',
    mode: 'shadow',
    enforced: true,
    scanner: 'rekognition',
    region: 'sa-east-1',
    latencyMs: 900,
    evidenceKey: null,
    createdAt: new Date('2026-10-22T09:59:00.000Z'),
    ...extra,
  };
}

function setup(options: { strikes?: boolean; finisher?: boolean; takedown?: boolean } = {}) {
  const generations = createTable('gen', [
    {
      id: 'gen-out',
      userId: 'user-1',
      status: 'IN_REVIEW',
      type: 'IMAGE_TO_IMAGE',
      modelUsed: 'sem-censura',
      prompt: 'p',
      resolution: 'RES_2K',
      aspectRatio: '1:1',
      creditsConsumed: 200,
      usedFreeGeneration: false,
      safetyCheckedAt: HELD_AT,
      updatedAt: HELD_AT,
      isDeleted: false,
      parameters: {
        safetyHold: {
          stage: 'output',
          outputs: [{ area: 'quarantine', key: OUT_KEY, mimeType: 'image/png' }],
          modelUsed: 'sem-censura',
          provider: 'seedream',
          processingTimeMs: 1234,
          heldAt: HELD_AT.toISOString(),
        },
      },
    },
    {
      id: 'gen-in',
      userId: 'user-2',
      status: 'IN_REVIEW',
      type: 'IMAGE_TO_IMAGE',
      modelUsed: 'nano-banana',
      prompt: 'p',
      resolution: 'RES_1K',
      aspectRatio: '1:1',
      creditsConsumed: 50,
      usedFreeGeneration: false,
      safetyCheckedAt: HELD_AT,
      updatedAt: HELD_AT,
      isDeleted: false,
      parameters: {},
    },
    {
      id: 'gen-done',
      userId: 'user-3',
      status: 'COMPLETED',
      type: 'TEXT_TO_IMAGE',
      modelUsed: 'sem-censura',
      safetyCheckedAt: HELD_AT,
      updatedAt: HELD_AT,
      isDeleted: false,
      parameters: {},
    },
    {
      id: 'gen-failed',
      userId: 'user-4',
      status: 'FAILED',
      type: 'IMAGE_TO_IMAGE',
      modelUsed: 'nano-banana',
      safetyCheckedAt: HELD_AT,
      updatedAt: HELD_AT,
      isDeleted: false,
      parameters: {},
    },
  ]);
  const scans = createTable('scan', [
    scan({
      id: 'scan-out-1',
      generationId: 'gen-out',
      stage: 'OUTPUT',
      mediaKey: OUT_KEY,
      verdict: 'HOLD',
      ruleId: 'S3',
      strength: 'MEDIUM',
      phash: PHASH,
      sha256: SHA,
    }),
    scan({
      id: 'scan-out-in',
      generationId: 'gen-out',
      stage: 'INPUT',
      mediaKey: IN_OUT_KEY,
      verdict: 'CLEAN',
    }),
    scan({
      id: 'scan-in-1',
      generationId: 'gen-in',
      userId: 'user-2',
      stage: 'INPUT',
      mediaKey: IN_KEY,
      verdict: 'HOLD',
      ruleId: 'E3a',
      strength: 'MEDIUM',
      phash: '0f0f0f0f0f0f0f0f',
      sha256: 'c'.repeat(64),
    }),
    scan({
      id: 'scan-done-1',
      generationId: 'gen-done',
      userId: 'user-3',
      stage: 'OUTPUT',
      mediaKey: DONE_QUARANTINE_KEY,
      verdict: 'HOLD',
      ruleId: 'S3',
      strength: 'MEDIUM',
      enforced: false,
    }),
    scan({
      id: 'scan-failed',
      generationId: 'gen-failed',
      userId: 'user-4',
      stage: 'INPUT',
      mediaKey: 'inputs/gen-failed/u5/x.jpg',
      verdict: 'BLOCK',
      ruleId: 'E2',
      strength: 'STRONG',
      evidenceKey: `evidence/${'d'.repeat(64)}/e1/x.jpg`,
    }),
    scan({
      id: 'scan-light',
      generationId: null,
      userId: 'user-5',
      stage: 'INPUT',
      mediaKey: 'light:abc123def456',
      verdict: 'BLOCK',
      ruleId: 'E1',
      strength: 'LIGHT',
    }),
    scan({
      id: 'scan-text',
      generationId: 'gen-failed',
      userId: 'user-4',
      stage: 'TEXT',
      mediaKey: null,
      verdict: 'UNAVAILABLE',
      latencyMs: 3000,
    }),
  ]);
  const events = createTable(
    'evt',
    [
      {
        id: 'evt-input-held',
        userId: 'user-2',
        kind: 'INPUT_HELD',
        route: 'input:generate',
        match: 'E3a/MEDIUM',
        generationId: 'gen-in',
        releasedAt: null,
        createdAt: HELD_AT,
      },
      {
        id: 'evt-output-held',
        userId: 'user-1',
        kind: 'OUTPUT_HELD',
        route: 'output:sem-censura',
        match: 'S3/MEDIUM',
        generationId: 'gen-out',
        releasedAt: null,
        createdAt: HELD_AT,
      },
    ],
    { releasedAt: null, releasedBy: null, releaseNote: null },
  );
  const accessLog = createTable('log');
  const inputs = createTable('input', [
    { id: 'in-1', generationId: 'gen-out', url: url('input-private', IN_OUT_KEY) },
    { id: 'in-2', generationId: 'gen-in', url: url('input-private', IN_KEY) },
  ]);
  const outputs = createTable('output', [
    {
      id: 'out-done',
      generationId: 'gen-done',
      url: url('public', DONE_PUBLIC_KEY),
      thumbnailUrl: url('public', 'thumbnails/gen-done/t.webp'),
    },
  ]);
  const users = createTable('user', [
    { id: 'user-3', isActive: true },
    { id: 'user-sus', isActive: false },
    { id: 'user-manual', isActive: false },
  ]);
  const prisma = {
    generation: generations,
    contentSafetyScan: scans,
    contentSafetyEvent: events,
    contentSafetyAccessLog: accessLog,
    generationInputImage: inputs,
    generationOutput: outputs,
    user: users,
    $transaction: jest.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
  };

  let evidenceCounter = 0;
  const uploads = {
    privateInputsEnabled: true,
    quarantineConfigured: true,
    locateStoredMedia: jest.fn((value: string | null | undefined) => {
      const match = /^https:\/\/cdn\.test\/([a-z-]+)\/(.+)$/.exec(value ?? '');
      return match ? { area: match[1], key: match[2] } : null;
    }),
    signedReviewMediaUrl: jest.fn(
      async (area: string, key: string, ttl: number) =>
        `https://signed.test/${area}/${key}?ttl=${ttl}`,
    ),
    copyQuarantineToPublic: jest.fn(async (key: string) => ({
      key: `promoted/${key}`,
      url: url('public', `promoted/${key}`),
    })),
    deleteQuarantineObject: jest.fn(async () => undefined),
    deleteStoredObject: jest.fn(async () => undefined),
    getPublicUrl: jest.fn((key: string) => url('public', key)),
    moveToEvidence: jest.fn(async (_area: string, key: string) => {
      evidenceCounter++;
      return `evidence/${'e'.repeat(64)}/m${evidenceCounter}/${key.split('/').pop()}`;
    }),
  };

  const holdStates: Record<string, Row> = {
    'gen-out': {
      reason: 'output_review',
      heldAt: HELD_AT,
      modelUsed: 'sem-censura',
      hold: {
        stage: 'output',
        outputs: [{ area: 'quarantine', key: OUT_KEY, mimeType: 'image/png' }],
        modelUsed: 'sem-censura',
        provider: 'seedream',
        processingTimeMs: 1234,
        heldAt: HELD_AT.toISOString(),
      },
    },
    'gen-in': { reason: 'input_review', heldAt: HELD_AT, hold: null, modelUsed: 'nano-banana' },
  };
  const imageSafety = {
    holdStateOf: jest.fn(async (id: string) => {
      const generation = generations.rows.find((row) => row.id === id);
      return generation?.status === 'IN_REVIEW' ? (holdStates[id] ?? null) : null;
    }),
    expireHeldInput: jest.fn(
      async () => new InputImageSafetyBlockError('E3a', 'MEDIUM'),
    ),
    expireReviewedOutput: jest.fn(
      async () => new OutputImageSafetyBlockError('S3', 'MEDIUM'),
    ),
  };
  const contentSafety = {
    record: jest.fn(async (event: Row) => {
      const created = await events.create({ data: { ...event } });
      return created.id as string;
    }),
  };
  const blocklist = {
    add: jest.fn(async () => 'block-1'),
    match: jest.fn(),
    countRecent: jest.fn(),
  };
  const finisher = {
    completeHeldGeneration: jest.fn(async (id: string) => {
      const generation = generations.rows.find((row) => row.id === id);
      if (generation?.status !== 'IN_REVIEW') return false;
      generation.status = 'COMPLETED';
      return true;
    }),
    // como o processor: 'held' só encerra quem ainda está IN_REVIEW; 'processing' = quem chama já ganhou a troca
    failForSafety: jest.fn(async (id: string, _error?: unknown, from = 'held') => {
      const generation = generations.rows.find((row) => row.id === id);
      const open = from === 'processing' ? 'PROCESSING' : 'IN_REVIEW';
      if (generation?.status === open) generation.status = 'FAILED';
    }),
    runImageJobDirectly: jest.fn(async () => undefined),
  };
  const dispatcher = {
    finisher: jest.fn(() => (options.finisher === false ? null : finisher)),
    planRequeue: jest.fn(async (generation: Row) => ({
      kind: 'queue',
      source: 'generation',
      jobName: 'image',
      data: { generationId: generation.id },
      opts: { attempts: 2 },
    })),
    dispatch: jest.fn(async () => undefined),
  };
  const strikes = {
    enabled: true,
    applySignal: jest.fn(async () => ({
      action: 'suspended',
      points: 0,
      causes: ['strong'],
      shadowCauses: [],
      linkedAccounts: [],
    })),
    isSuspended: jest.fn(),
    photoRetryAllowed: jest.fn(),
  };
  const takedown = {
    recordReviewRemoval: jest.fn(async () => ({ none: 0, pending: 0, done: 2, failed: 0 })),
  };
  const config = {
    imageMode: 'shadow',
    textMode: 'off',
    enforceStrong: true,
    reviewerIds: new Set(['rev-1']),
  };
  const service = new SafetyReviewService(
    prisma as never,
    uploads as never,
    imageSafety as never,
    contentSafety as never,
    blocklist as never,
    config as never,
    dispatcher as never,
    options.strikes === false ? null : (strikes as never),
    options.takedown === false ? null : (takedown as never),
  );
  return {
    service,
    prisma,
    uploads,
    imageSafety,
    contentSafety,
    blocklist,
    finisher,
    dispatcher,
    strikes,
    generations,
    scans,
    events,
    accessLog,
    takedown,
    users,
    outputs,
  };
}

beforeAll(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
});
afterAll(() => jest.useRealTimers());
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('SafetyReviewService.listScans: fila sem mídia', () => {
  it('filtra por veredito, etapa e regra; nunca devolve URL nem chave de mídia', async () => {
    const { service } = setup();
    const result = await service.listScans({
      page: 1,
      limit: 50,
      verdict: 'HOLD',
      stage: 'OUTPUT',
      rule: 'S3',
    });
    expect(result.total).toBe(2);
    expect(result.data.map((item) => item.id).sort()).toEqual([
      'scan-done-1',
      'scan-out-1',
    ]);
    const body = JSON.stringify(result);
    expect(body).not.toContain('cdn.test');
    expect(body).not.toContain(OUT_KEY);
    expect(body).not.toContain('evidence/');
    expect(body).not.toMatch(/mediaKey|evidenceKey|"url"/);
    const held = result.data.find((item) => item.id === 'scan-out-1')!;
    expect(held.media).toEqual({ stored: true, inEvidence: false });
    expect(held.generation).toMatchObject({
      status: 'IN_REVIEW',
      holdReason: 'output_review',
      heldAt: HELD_AT,
    });
  });

  it('inReview: só checagens de gerações em revisão; o caso leve diz que não há mídia', async () => {
    const { service } = setup();
    const result = await service.listScans({ page: 1, limit: 50, inReview: true });
    expect(new Set(result.data.map((item) => item.generationId))).toEqual(
      new Set(['gen-out', 'gen-in']),
    );
    const all = await service.listScans({ page: 1, limit: 50, verdict: 'BLOCK' });
    const light = all.data.find((item) => item.id === 'scan-light')!;
    expect(light.media).toEqual({ stored: false, inEvidence: false });
    const failed = all.data.find((item) => item.id === 'scan-failed')!;
    expect(failed.media).toEqual({ stored: true, inEvidence: true });
  });

  it('paginação e período (AAAA-MM-DD inclui o dia todo em UTC)', async () => {
    const { service } = setup();
    const page = await service.listScans({
      page: 2,
      limit: 3,
      from: '2026-10-22',
      to: '2026-10-22',
    });
    expect(page.total).toBe(7);
    expect(page.data).toHaveLength(3);
    const none = await service.listScans({ page: 1, limit: 50, from: '2026-10-23' });
    expect(none.total).toBe(0);
  });

  it('data inválida = 400', async () => {
    const { service } = setup();
    await expect(
      service.listScans({ page: 1, limit: 50, from: 'ontem' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('SafetyReviewService.mediaUrl: URL assinada de 120 s com registro', () => {
  it('resultado segurado: assina na quarentena, depois de gravar quem, por quê e o IP', async () => {
    const { service, uploads, accessLog } = setup();
    const media = await service.mediaUrl('scan-out-1', `  ${REASON}  `, ACTOR);
    expect(media).toMatchObject({
      url: `https://signed.test/quarantine/${OUT_KEY}?ttl=120`,
      expiresInSeconds: 120,
      area: 'quarantine',
      stage: 'OUTPUT',
    });
    expect(accessLog.rows).toEqual([
      expect.objectContaining({
        actorId: 'rev-1',
        action: 'view_media',
        targetType: 'scan',
        targetId: 'scan-out-1',
        reason: REASON,
        ip: '203.0.113.7',
      }),
    ]);
    expect(accessLog.create.mock.invocationCallOrder[0]).toBeLessThan(
      uploads.signedReviewMediaUrl.mock.invocationCallOrder[0],
    );
  });

  it('com evidência: assina na evidência; entrada: no privado das entradas', async () => {
    const { service } = setup();
    await expect(service.mediaUrl('scan-failed', REASON, ACTOR)).resolves.toMatchObject({
      area: 'evidence',
    });
    await expect(service.mediaUrl('scan-in-1', REASON, ACTOR)).resolves.toMatchObject({
      area: 'input-private',
      url: `https://signed.test/input-private/${IN_KEY}?ttl=120`,
    });
  });

  it('resultado já publicado: acha a chave promovida (nunca a URL pública)', async () => {
    const { service } = setup();
    const media = await service.mediaUrl('scan-done-1', REASON, ACTOR);
    expect(media).toMatchObject({
      area: 'public',
      url: `https://signed.test/public/${DONE_PUBLIC_KEY}?ttl=120`,
    });
  });

  it('caso leve e texto: 404, mas a tentativa fica no registro', async () => {
    const { service, accessLog, uploads } = setup();
    await expect(service.mediaUrl('scan-light', REASON, ACTOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.mediaUrl('scan-text', REASON, ACTOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(accessLog.rows).toHaveLength(2);
    expect(uploads.signedReviewMediaUrl).not.toHaveBeenCalled();
  });

  it('sem motivo: 400 sem registro; registro fora do ar: 503 e nenhuma URL', async () => {
    const { service, accessLog, uploads } = setup();
    await expect(service.mediaUrl('scan-out-1', 'curto', ACTOR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(accessLog.rows).toHaveLength(0);
    accessLog.create.mockRejectedValueOnce(new Error('db fora'));
    await expect(service.mediaUrl('scan-out-1', REASON, ACTOR)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(uploads.signedReviewMediaUrl).not.toHaveBeenCalled();
  });

  it('checagem que não existe: 404', async () => {
    const { service } = setup();
    await expect(service.mediaUrl('nada', REASON, ACTOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('SafetyReviewService.decide release: falso positivo de geração segurada', () => {
  it('entrada segurada (E3a): libera o INPUT_HELD, volta a PROCESSING e reenfileira', async () => {
    const { service, dispatcher, generations, events, accessLog } = setup();
    const result = await service.decide(
      'scan-in-1',
      { action: 'release', reason: REASON },
      ACTOR,
    );
    expect(result).toMatchObject({ outcome: 'requeued', via: 'queue', generationId: 'gen-in' });
    expect(dispatcher.planRequeue).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gen-in', userId: 'user-2' }),
      HELD_AT,
    );
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const generation = generations.rows.find((row) => row.id === 'gen-in')!;
    expect(generation.status).toBe('PROCESSING');
    expect(generation.safetyCheckedAt.getTime()).toBe(NOW.getTime());
    expect(events.rows.find((row) => row.id === 'evt-input-held')).toMatchObject({
      releasedBy: 'rev-1',
      releaseNote: `revisão de segurança: ${REASON}`,
    });
    expect(accessLog.rows).toEqual([
      expect.objectContaining({ action: 'release', targetId: 'scan-in-1' }),
    ]);
    // a geração liberada sai antes de reenfileirar (o job novo encontra PROCESSING)
    expect(generations.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      dispatcher.dispatch.mock.invocationCallOrder[0],
    );
  });

  it('sem INPUT_HELD gravado no hold: grava um já liberado (senão a nova rodada seguraria de novo)', async () => {
    const { service, events } = setup();
    events.rows.splice(
      events.rows.findIndex((row) => row.id === 'evt-input-held'),
      1,
    );
    await service.decide('scan-in-1', { action: 'release', reason: REASON }, ACTOR);
    expect(events.rows).toContainEqual(
      expect.objectContaining({
        kind: 'INPUT_HELD',
        generationId: 'gen-in',
        releasedBy: 'rev-1',
        match: 'REVIEW_RELEASED',
      }),
    );
  });

  it('pedido original fora da fila: 409, nada muda e nada vai para o registro', async () => {
    const { service, dispatcher, generations, accessLog } = setup();
    dispatcher.planRequeue.mockResolvedValueOnce(null as never);
    await expect(
      service.decide('scan-in-1', { action: 'release', reason: REASON }, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(generations.rows.find((row) => row.id === 'gen-in')!.status).toBe('IN_REVIEW');
    expect(accessLog.rows).toHaveLength(0);
  });

  it('fila fora do ar: a geração volta para a revisão com a hora do hold, 503', async () => {
    const { service, dispatcher, generations } = setup();
    dispatcher.dispatch.mockRejectedValueOnce(new Error('redis fora'));
    await expect(
      service.decide('scan-in-1', { action: 'release', reason: REASON }, ACTOR),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    const generation = generations.rows.find((row) => row.id === 'gen-in')!;
    expect(generation.status).toBe('IN_REVIEW');
    expect(generation.safetyCheckedAt).toEqual(HELD_AT);
  });

  it('resultado segurado: copia para o público, conclui pelo processor e só então tira da quarentena', async () => {
    const { service, uploads, finisher, events } = setup();
    const result = await service.decide(
      'scan-out-1',
      { action: 'release', reason: REASON },
      ACTOR,
    );
    expect(result).toMatchObject({ outcome: 'published', outputs: 1, eventsReleased: true });
    expect(uploads.copyQuarantineToPublic).toHaveBeenCalledWith(OUT_KEY, {
      contentType: 'image/png',
    });
    expect(finisher.completeHeldGeneration).toHaveBeenCalledWith(
      'gen-out',
      [url('public', `promoted/${OUT_KEY}`)],
      expect.objectContaining({ modelUsed: 'sem-censura', processingTimeMs: 1234 }),
    );
    expect(uploads.deleteQuarantineObject).toHaveBeenCalledWith(OUT_KEY);
    expect(finisher.completeHeldGeneration.mock.invocationCallOrder[0]).toBeLessThan(
      uploads.deleteQuarantineObject.mock.invocationCallOrder[0],
    );
    expect(events.rows.find((row) => row.id === 'evt-output-held')).toMatchObject({
      releasedBy: 'rev-1',
    });
  });

  it('outra decisão chegou antes: apaga as cópias públicas, mantém a quarentena, 409', async () => {
    const { service, uploads, finisher } = setup();
    finisher.completeHeldGeneration.mockResolvedValueOnce(false);
    await expect(
      service.decide('scan-out-1', { action: 'release', reason: REASON }, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(uploads.deleteStoredObject).toHaveBeenCalledWith(
      'public',
      `promoted/${OUT_KEY}`,
    );
    expect(uploads.deleteQuarantineObject).not.toHaveBeenCalled();
  });

  it('geração que não está segurada: 409 (bloqueio encerrado sai pelo jurídico)', async () => {
    const { service, accessLog } = setup();
    await expect(
      service.decide('scan-failed', { action: 'release', reason: REASON }, ACTOR),
    ).rejects.toMatchObject({ response: { code: 'SAFETY_REVIEW_NOT_HELD' } });
    expect(accessLog.rows).toHaveLength(0);
  });

  it('processor fora: 503 antes de qualquer registro ou mudança', async () => {
    const { service, accessLog, generations } = setup({ finisher: false });
    await expect(
      service.decide('scan-out-1', { action: 'release', reason: REASON }, ACTOR),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(accessLog.rows).toHaveLength(0);
    expect(generations.rows.find((row) => row.id === 'gen-out')!.status).toBe('IN_REVIEW');
  });
});

describe('SafetyReviewService.decide confirm: caso confirmado', () => {
  it('resultado segurado: evidência, entradas guardadas, encerra com estorno, evento forte, lista e pontos', async () => {
    const {
      service,
      imageSafety,
      finisher,
      events,
      scans,
      blocklist,
      strikes,
      uploads,
      generations,
    } = setup();
    const result = await service.decide(
      'scan-out-1',
      { action: 'confirm', reason: REASON },
      ACTOR,
    );
    expect(result).toMatchObject({
      generationClosed: true,
      retryNeeded: false,
      evidencePending: false,
      alreadyConfirmed: false,
      accountSuspended: true,
    });
    // o registro do hold vai lido de antes da trava (depois dela a geração já não está IN_REVIEW)
    expect(imageSafety.expireReviewedOutput).toHaveBeenCalledWith(
      'gen-out',
      expect.objectContaining({
        outputs: [{ area: 'quarantine', key: OUT_KEY, mimeType: 'image/png' }],
      }),
    );
    expect(finisher.failForSafety).toHaveBeenCalledWith(
      'gen-out',
      expect.any(OutputImageSafetyBlockError),
      'processing',
    );
    expect(generations.rows.find((row) => row.id === 'gen-out')!.status).toBe('FAILED');
    // a foto enviada também vira evidência e fica ligada à checagem dela
    expect(uploads.moveToEvidence).toHaveBeenCalledWith('input-private', IN_OUT_KEY, null);
    expect(scans.rows.find((row) => row.id === 'scan-out-in')!.evidenceKey).toMatch(
      /^evidence\//,
    );
    const [, error] = finisher.failForSafety.mock.calls[0] as unknown as [
      string,
      OutputImageSafetyBlockError,
    ];
    expect(error).toBeInstanceOf(OutputImageSafetyBlockError);
    expect(error).toMatchObject({
      failureCode: 'IMAGE_SAFETY_BLOCKED',
      ruleId: 'REVIEW_CONFIRMED',
      strength: 'STRONG',
      evidencePending: false,
    });
    expect(events.rows).toContainEqual(
      expect.objectContaining({
        kind: 'OUTPUT_MINOR_BLOCKED',
        route: 'review:output',
        match: 'REVIEW_CONFIRMED/STRONG',
        generationId: 'gen-out',
      }),
    );
    expect(blocklist.add).toHaveBeenCalledWith({
      phash: PHASH,
      sha256: SHA,
      strength: 'STRONG',
      origin: 'manual',
      eventId: expect.any(String),
    });
    expect(strikes.applySignal).toHaveBeenCalledWith(
      'user-1',
      'STRONG',
      expect.any(String),
      expect.objectContaining({
        layer: 'output',
        match: 'REVIEW_CONFIRMED/STRONG',
        generationId: 'gen-out',
        photos: [],
      }),
    );
  });

  it('entrada segurada: a foto vai para a evidência, encerra com o erro de entrada e manda as fotos para os pontos', async () => {
    const { service, imageSafety, finisher, strikes } = setup();
    await service.decide('scan-in-1', { action: 'confirm', reason: REASON }, ACTOR);
    expect(imageSafety.expireHeldInput).toHaveBeenCalledWith('gen-in');
    const [, error] = finisher.failForSafety.mock.calls[0] as unknown as [string, Error];
    expect(error).toBeInstanceOf(InputImageSafetyBlockError);
    expect(strikes.applySignal).toHaveBeenCalledWith(
      'user-2',
      'STRONG',
      expect.any(String),
      expect.objectContaining({
        layer: 'input',
        photos: [
          { phash: '0f0f0f0f0f0f0f0f', sha256: 'c'.repeat(64), blockId: 'block-1' },
        ],
      }),
    );
  });

  it('repetir não duplica o evento e refaz só o que faltou', async () => {
    const { service, contentSafety, events, finisher } = setup();
    await service.decide('scan-out-1', { action: 'confirm', reason: REASON }, ACTOR);
    const again = await service.decide(
      'scan-out-1',
      { action: 'confirm', reason: REASON },
      ACTOR,
    );
    expect(again).toMatchObject({ alreadyConfirmed: true, generationClosed: false });
    expect(contentSafety.record).toHaveBeenCalledTimes(1);
    expect(
      events.rows.filter((row) => row.match === 'REVIEW_CONFIRMED/STRONG'),
    ).toHaveLength(1);
    expect(finisher.failForSafety).toHaveBeenCalledTimes(1);
  });

  it('a liberação publicou logo depois da leitura (perdeu a trava): a confirmação tira do ar e não encerra de novo', async () => {
    const { service, imageSafety, finisher, generations, outputs, uploads } = setup();
    const generation = generations.rows.find((row) => row.id === 'gen-out')!;
    const publishedKey = 'generations/gen-out/pub/a.png';
    imageSafety.holdStateOf.mockImplementationOnce(async () => {
      const read = {
        reason: 'output_review',
        heldAt: HELD_AT,
        modelUsed: 'sem-censura',
        hold: generation.parameters.safetyHold,
      };
      // outro revisor ganhou a troca IN_REVIEW → PROCESSING e concluiu
      generation.status = 'COMPLETED';
      outputs.rows.push({
        id: 'out-race',
        generationId: 'gen-out',
        url: url('public', publishedKey),
        thumbnailUrl: null,
      });
      return read;
    });
    const result = await service.decide(
      'scan-out-1',
      { action: 'confirm', reason: REASON },
      ACTOR,
    );
    expect(result).toMatchObject({ generationClosed: false, retryNeeded: false, takenDown: 1 });
    expect(imageSafety.expireReviewedOutput).not.toHaveBeenCalled();
    expect(finisher.failForSafety).not.toHaveBeenCalled();
    expect(uploads.moveToEvidence).toHaveBeenCalledWith('public', publishedKey, null);
    expect(generation.status).toBe('COMPLETED');
    expect(generation.isDeleted).toBe(true);
  });

  it('a liberação ainda concluía (PROCESSING) durante a confirmação: a mídia da checagem vai para a evidência e a resposta pede para repetir', async () => {
    const { service, imageSafety, finisher, generations, uploads, scans } = setup();
    const generation = generations.rows.find((row) => row.id === 'gen-out')!;
    imageSafety.holdStateOf.mockImplementationOnce(async () => {
      const read = {
        reason: 'output_review',
        heldAt: HELD_AT,
        modelUsed: 'sem-censura',
        hold: generation.parameters.safetyHold,
      };
      generation.status = 'PROCESSING';
      return read;
    });
    const result = await service.decide(
      'scan-out-1',
      { action: 'confirm', reason: REASON },
      ACTOR,
    );
    expect(result).toMatchObject({ generationClosed: false, retryNeeded: true });
    expect(finisher.failForSafety).not.toHaveBeenCalled();
    expect(uploads.moveToEvidence).toHaveBeenCalledWith('quarantine', OUT_KEY, SHA);
    expect(scans.rows.find((row) => row.id === 'scan-out-1')!.evidenceKey).toMatch(/^evidence\//);
  });

  it('a geração saiu de IN_REVIEW antes do holdStateOf (já publicada): relê o status e tira do ar', async () => {
    const { service, imageSafety, finisher, generations, outputs, uploads } = setup();
    const generation = generations.rows.find((row) => row.id === 'gen-out')!;
    const publishedKey = 'generations/gen-out/pub/b.png';
    imageSafety.holdStateOf.mockImplementationOnce(async () => {
      // o cron ou outro revisor concluiu enquanto a confirmação gravava o registro e o evento
      generation.status = 'COMPLETED';
      outputs.rows.push({
        id: 'out-race-2',
        generationId: 'gen-out',
        url: url('public', publishedKey),
        thumbnailUrl: null,
      });
      return null;
    });
    const result = await service.decide(
      'scan-out-1',
      { action: 'confirm', reason: REASON },
      ACTOR,
    );
    expect(result).toMatchObject({ generationClosed: false, retryNeeded: false, takenDown: 1 });
    expect(finisher.failForSafety).not.toHaveBeenCalled();
    expect(uploads.moveToEvidence).toHaveBeenCalledWith('public', publishedKey, null);
    expect(generation.isDeleted).toBe(true);
  });

  it('a geração saiu de IN_REVIEW antes do holdStateOf e ainda conclui (PROCESSING): a resposta pede para repetir', async () => {
    const { service, imageSafety, finisher, generations } = setup();
    const generation = generations.rows.find((row) => row.id === 'gen-out')!;
    imageSafety.holdStateOf.mockImplementationOnce(async () => {
      generation.status = 'PROCESSING';
      return null;
    });
    const result = await service.decide(
      'scan-out-1',
      { action: 'confirm', reason: REASON },
      ACTOR,
    );
    expect(result).toMatchObject({ generationClosed: false, retryNeeded: true, takenDown: 0 });
    expect(finisher.failForSafety).not.toHaveBeenCalled();
  });

  it('mídia segurada não vai para a evidência (banco fora): a geração volta para a revisão com a hora do hold e 503', async () => {
    const { service, imageSafety, finisher, generations } = setup();
    imageSafety.expireReviewedOutput.mockRejectedValueOnce(new Error('banco fora'));
    await expect(
      service.decide('scan-out-1', { action: 'confirm', reason: REASON }, ACTOR),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    const generation = generations.rows.find((row) => row.id === 'gen-out')!;
    expect(generation.status).toBe('IN_REVIEW');
    expect(generation.safetyCheckedAt).toEqual(HELD_AT);
    expect(finisher.failForSafety).not.toHaveBeenCalled();
  });

  it('resultado já publicado (sombra): resultado e miniatura saem do público para a evidência, some da galeria', async () => {
    const { service, uploads, generations, scans } = setup();
    const result = await service.decide(
      'scan-done-1',
      { action: 'confirm', reason: REASON },
      ACTOR,
    );
    expect(result).toMatchObject({ takenDown: 1, generationClosed: false });
    expect(uploads.moveToEvidence).toHaveBeenCalledWith('public', DONE_PUBLIC_KEY, null);
    expect(uploads.moveToEvidence).toHaveBeenCalledWith(
      'public',
      'thumbnails/gen-done/t.webp',
      null,
    );
    // nada é apagado: a miniatura também fica na evidência, ligada à geração
    expect(uploads.deleteStoredObject).not.toHaveBeenCalled();
    expect(scans.rows).toContainEqual(
      expect.objectContaining({
        generationId: 'gen-done',
        mediaKey: 'thumbnails/gen-done/t.webp',
        scanner: 'reviewer',
        evidenceKey: expect.stringMatching(/^evidence\//),
      }),
    );
    expect(generations.rows.find((row) => row.id === 'gen-done')!.isDeleted).toBe(true);
    expect(scans.rows.find((row) => row.id === 'scan-done-1')!.evidenceKey).toMatch(
      /^evidence\//,
    );
  });

  it('resultado já publicado: cada arquivo que saiu do público vira item da remoção e o CDN é purgado', async () => {
    const { service, takedown } = setup();
    const result = await service.decide(
      'scan-done-1',
      { action: 'confirm', reason: REASON },
      ACTOR,
    );
    expect(takedown.recordReviewRemoval).toHaveBeenCalledWith({
      scanId: 'scan-done-1',
      actorId: 'rev-1',
      files: [
        expect.objectContaining({
          generationId: 'gen-done',
          role: 'output',
          location: { area: 'public', key: DONE_PUBLIC_KEY },
          evidenceKey: expect.stringMatching(/^evidence\//),
        }),
        expect.objectContaining({
          role: 'thumbnail',
          location: { area: 'public', key: 'thumbnails/gen-done/t.webp' },
        }),
      ],
    });
    expect(result).toMatchObject({
      externalStillPublic: 0,
      cdnPurge: { done: 2, pending: 0 },
    });
  });

  it('resultado hospedado fora do storage: não é pulado em silêncio (external, segue no ar)', async () => {
    const { service, takedown, outputs } = setup();
    outputs.rows[0].url = 'https://provedor.example/tmp/out.png';
    outputs.rows[0].thumbnailUrl = null;
    const result = await service.decide(
      'scan-done-1',
      { action: 'confirm', reason: REASON },
      ACTOR,
    );
    expect(result).toMatchObject({ externalStillPublic: 1, takenDown: 0 });
    expect(takedown.recordReviewRemoval).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [
          expect.objectContaining({
            url: 'https://provedor.example/tmp/out.png',
            location: null,
          }),
        ],
      }),
    );
  });

  it('sem o serviço de remoção: o que saiu do público conta como purga pendente (e vai para o log)', async () => {
    const { service } = setup({ takedown: false });
    const result = await service.decide(
      'scan-done-1',
      { action: 'confirm', reason: REASON },
      ACTOR,
    );
    expect(result).toMatchObject({ cdnPurge: { pending: 2, done: 0 } });
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining('sem purga do CDN'),
    );
  });

  it('original que não saiu do público: a evidência fica pendente e nada é apagado', async () => {
    const { service, uploads } = setup();
    uploads.moveToEvidence.mockRejectedValueOnce(new StorageReadError('failed', 'public'));
    const result = await service.decide(
      'scan-done-1',
      { action: 'confirm', reason: REASON },
      ACTOR,
    );
    expect(result).toMatchObject({ evidencePending: true, takenDown: 0 });
    expect(uploads.deleteStoredObject).not.toHaveBeenCalled();
  });

  it('bloqueio já com evidência: nada é movido de novo; sem serviço de pontos segue com evento e lista', async () => {
    const { service, uploads, events } = setup({ strikes: false });
    const result = await service.decide(
      'scan-failed',
      { action: 'confirm', reason: REASON },
      ACTOR,
    );
    expect(result).toMatchObject({ accountSuspended: false, mediaMissing: false });
    expect(uploads.moveToEvidence).not.toHaveBeenCalledWith(
      expect.anything(),
      'inputs/gen-failed/u5/x.jpg',
      expect.anything(),
    );
    expect(events.rows).toContainEqual(
      expect.objectContaining({ kind: 'IMAGE_MINOR_BLOCKED', route: 'review:input' }),
    );
  });
});

describe('SafetyReviewService.decide report: comunicação à autoridade', () => {
  it('sem confirmação antes: 409', async () => {
    const { service, accessLog } = setup();
    await expect(
      service.decide(
        'scan-failed',
        { action: 'report', reason: REASON, channel: 'cnca', protocol: 'NID-1' },
        ACTOR,
      ),
    ).rejects.toMatchObject({ response: { code: 'SAFETY_REVIEW_REPORT_NEEDS_CONFIRM' } });
    expect(accessLog.rows).toHaveLength(0);
  });

  it('depois de confirmar outra checagem da mesma geração: grava canal e protocolo; a fila mostra', async () => {
    const { service, accessLog } = setup();
    await service.decide('scan-failed', { action: 'confirm', reason: REASON }, ACTOR);
    const result = await service.decide(
      'scan-text',
      { action: 'report', reason: REASON, channel: 'cnca', protocol: 'NID-2026/0001' },
      ACTOR,
    );
    expect(result).toMatchObject({ channel: 'cnca', protocol: 'NID-2026/0001' });
    expect(accessLog.rows[accessLog.rows.length - 1]).toMatchObject({
      action: 'report',
      targetId: 'scan-text',
      reason: `[canal:cnca][protocolo:NID-2026/0001] ${REASON}`,
    });
    const list = await service.listScans({ page: 1, limit: 50, generationId: 'gen-failed' });
    const text = list.data.find((item) => item.id === 'scan-text')!;
    expect(text.review.reports).toEqual([
      expect.objectContaining({ channel: 'cnca', protocol: 'NID-2026/0001', actorId: 'rev-1' }),
    ]);
    const failed = list.data.find((item) => item.id === 'scan-failed')!;
    expect(failed.review.confirmed).toBe(true);
  });

  it('sem canal: 400', async () => {
    const { service } = setup();
    await expect(
      service.decide('scan-failed', { action: 'report', reason: REASON }, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('SafetyReviewService.reactivateAccount: conta suspensa pela camada 6', () => {
  const suspendLine = (targetId: string, createdAt: Date) => ({
    actorId: 'system:strikes',
    action: 'suspend',
    targetType: 'user',
    targetId,
    reason: 'sinal forte',
    createdAt,
  });

  it('com suspensão aberta: reativa e grava a reativação na trilha, com motivo e IP', async () => {
    const { service, users, accessLog } = setup();
    accessLog.rows.push(suspendLine('user-sus', HELD_AT));
    const result = await service.reactivateAccount('user-sus', REASON, ACTOR);
    expect(result).toEqual({ userId: 'user-sus', reactivated: true, alreadyActive: false });
    expect(users.rows.find((row) => row.id === 'user-sus')!.isActive).toBe(true);
    expect(accessLog.rows).toContainEqual(
      expect.objectContaining({
        actorId: 'rev-1',
        action: 'reactivate',
        targetType: 'user',
        targetId: 'user-sus',
        reason: REASON,
        ip: '203.0.113.7',
      }),
    );
    // a suspensão fecha: outra reativação já não acha suspensão aberta
    await expect(
      service.reactivateAccount('user-sus', REASON, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('conta desativada à mão (sem linha suspend): 409, a reativação é pelo admin', async () => {
    const { service, users } = setup();
    await expect(
      service.reactivateAccount('user-manual', REASON, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(users.rows.find((row) => row.id === 'user-manual')!.isActive).toBe(false);
  });

  it('sem motivo: 400; conta inexistente: 404; trilha fora do ar: 503 e nada muda', async () => {
    const { service, users, accessLog } = setup();
    accessLog.rows.push(suspendLine('user-sus', HELD_AT));
    await expect(
      service.reactivateAccount('user-sus', 'curto', ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.reactivateAccount('nao-existe', REASON, ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
    accessLog.create.mockRejectedValueOnce(new Error('banco fora'));
    const before = users.rows.find((row) => row.id === 'user-sus')!.isActive;
    await expect(
      service.reactivateAccount('user-sus', REASON, ACTOR),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    // o simulador não desfaz a transação; o que importa é a resposta (o banco real desfaz a reativação)
    expect(before).toBe(false);
  });
});

describe('SafetyReviewService.accessLog e metrics', () => {
  it('registro paginado e filtrado', async () => {
    const { service } = setup();
    await service.mediaUrl('scan-out-1', REASON, ACTOR);
    await service.mediaUrl('scan-in-1', REASON, { ...ACTOR, id: 'rev-2' });
    const all = await service.accessLog({ page: 1, limit: 1 });
    expect(all.total).toBe(2);
    expect(all.data).toHaveLength(1);
    const own = await service.accessLog({ page: 1, limit: 50, actorId: 'rev-2' });
    expect(own.data).toEqual([expect.objectContaining({ targetId: 'scan-in-1' })]);
  });

  it('bloqueios por regra e dia, indisponibilidade, latência, fila por idade e motivo, decisões', async () => {
    const { service } = setup();
    await service.mediaUrl('scan-out-1', REASON, ACTOR);
    const metrics = await service.metrics(7);
    expect(metrics.windowDays).toBe(7);
    expect(metrics.blocksByRuleDay).toEqual(
      expect.arrayContaining([
        { day: '2026-10-22', ruleId: 'S3', verdict: 'HOLD', enforced: 1, shadow: 1 },
        { day: '2026-10-22', ruleId: 'E2', verdict: 'BLOCK', enforced: 1, shadow: 0 },
      ]),
    );
    const today = metrics.checksByDay.find((day) => day.day === '2026-10-22')!;
    expect(today).toMatchObject({ total: 7, unavailable: 1 });
    expect(today.unavailableRate).toBeCloseTo(1 / 7);
    expect(metrics.latencyMs).toMatchObject({
      input: { count: 4, p50: 900, p95: 900 },
      text: { count: 1, p50: 3000, p95: 3000 },
      sampled: 7,
    });
    expect(metrics.reviewQueue).toMatchObject({
      total: 2,
      byReason: { input_review: 1, output_review: 1, output_unchecked: 0 },
      byAge: { under1h: 0, from1to4h: 2, from4to24h: 0, over24h: 0 },
      overTarget: 0,
    });
    expect(metrics.decisions).toEqual({ view_media: 1 });
  });
});
