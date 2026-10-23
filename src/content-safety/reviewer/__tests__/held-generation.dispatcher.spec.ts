import { Logger } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import {
  GENERATION_QUEUE,
  GENERATION_UNLIMITED_QUEUE,
} from '../../../generations/queue/generation-queue.constants';
import { GenerationProcessor } from '../../../generations/queue/generation.processor';
import {
  HeldGenerationDispatcher,
  type HeldGenerationRow,
} from '../held-generation.dispatcher';

/** Reenfileirar a entrada segurada: filas e processor simulados (sem Redis). */

const HELD_AT = new Date('2026-10-22T10:00:00.000Z');

interface FakeJob {
  name: string;
  data: Record<string, unknown>;
  opts?: Record<string, unknown>;
  finishedOn?: number;
}

/** Fila com os jobs concluídos do mais novo para o mais velho (como o getJobs(['completed'], …, false)). */
function fakeQueue(jobs: FakeJob[]) {
  return {
    getJobs: jest.fn(async (_types: string[], start: number, end: number) =>
      jobs.slice(start, end + 1),
    ),
    add: jest.fn(
      async (_name: string, _data: unknown, _opts?: Record<string, unknown>) => ({
        id: 'novo',
      }),
    ),
  };
}

function generation(extra: Partial<HeldGenerationRow> = {}): HeldGenerationRow {
  return {
    id: 'gen-1',
    userId: 'user-1',
    type: 'IMAGE_TO_IMAGE',
    modelUsed: 'nano-banana',
    prompt: 'retrato de estúdio',
    resolution: 'RES_2K',
    aspectRatio: '3:4',
    creditsConsumed: 200,
    usedFreeGeneration: false,
    parameters: { mimeType: 'image/png' },
    ...extra,
  } as HeldGenerationRow;
}

function setup(seed: { generation?: FakeJob[]; unlimited?: FakeJob[]; queues?: boolean } = {}) {
  const queues = {
    generation: fakeQueue(seed.generation ?? []),
    unlimited: fakeQueue(seed.unlimited ?? []),
  };
  const finisher = { runImageJobDirectly: jest.fn(async () => undefined) };
  const moduleRef = {
    get: jest.fn((token: unknown) => {
      if (seed.queues !== false && token === getQueueToken(GENERATION_QUEUE)) return queues.generation;
      if (seed.queues !== false && token === getQueueToken(GENERATION_UNLIMITED_QUEUE)) return queues.unlimited;
      if (token === GenerationProcessor) return finisher;
      throw new Error('não registrado');
    }),
  };
  const dispatcher = new HeldGenerationDispatcher(moduleRef as never);
  return { dispatcher, queues, finisher };
}

const recent = (offsetMs: number) => HELD_AT.getTime() + offsetMs;

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('HeldGenerationDispatcher.planRequeue', () => {
  it('acha o job concluído da geração e devolve os mesmos dados sem a janela de espera da rodada anterior', async () => {
    const { dispatcher } = setup({
      generation: [
        { name: 'image', data: { generationId: 'outra' }, finishedOn: recent(60_000) },
        {
          name: 'image-to-video-kie',
          data: {
            generationId: 'gen-1',
            userId: 'user-1',
            imageUrl: 'https://cdn.test/input-private/inputs/gen-1/a.png',
            safetyFirstAttemptAt: 123,
            safetyDeferrals: 2,
          },
          opts: { attempts: 3, backoff: { type: 'fixed', delay: 5 }, removeOnComplete: true, removeOnFail: false, delay: 999 },
          finishedOn: recent(1_000),
        },
      ],
    });
    const plan = await dispatcher.planRequeue(generation(), HELD_AT);
    expect(plan).toEqual({
      kind: 'queue',
      source: 'generation',
      jobName: 'image-to-video-kie',
      data: {
        generationId: 'gen-1',
        userId: 'user-1',
        imageUrl: 'https://cdn.test/input-private/inputs/gen-1/a.png',
      },
      opts: {
        attempts: 3,
        backoff: { type: 'fixed', delay: 5 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });
  });

  it('para de procurar nos jobs que concluíram bem antes do hold', async () => {
    const { dispatcher, queues } = setup({
      generation: [
        { name: 'image', data: { generationId: 'velha' }, finishedOn: HELD_AT.getTime() - 3 * 3_600_000 },
        { name: 'image', data: { generationId: 'gen-1' }, finishedOn: HELD_AT.getTime() - 4 * 3_600_000 },
      ],
    });
    const plan = await dispatcher.planRequeue(generation(), HELD_AT);
    expect(plan).toBeNull();
    expect(queues.generation.getJobs).toHaveBeenCalledTimes(1);
  });

  it('percorre as páginas até achar', async () => {
    const jobs: FakeJob[] = Array.from({ length: 230 }, (_, index) => ({
      name: 'image',
      data: { generationId: `g-${index}` },
      finishedOn: recent(10_000_000 - index),
    }));
    jobs.push({ name: 'image', data: { generationId: 'gen-1' }, finishedOn: recent(5) });
    const { dispatcher, queues } = setup({ generation: jobs });
    const plan = await dispatcher.planRequeue(generation(), HELD_AT);
    expect(plan).toMatchObject({ kind: 'queue', jobName: 'image' });
    expect(queues.generation.getJobs).toHaveBeenCalledTimes(2);
  });

  it('job do ilimitado: volta pela fila comum (o lock da conta já foi solto)', async () => {
    const { dispatcher, queues } = setup({
      unlimited: [{ name: 'image', data: { generationId: 'gen-1', creditsConsumed: 0 }, opts: { priority: 1 }, finishedOn: recent(10) }],
    });
    const plan = await dispatcher.planRequeue(generation(), HELD_AT);
    expect(plan).toMatchObject({ kind: 'queue', source: 'unlimited' });
    await dispatcher.dispatch(plan!);
    expect(queues.generation.add).toHaveBeenCalledWith(
      'image',
      { generationId: 'gen-1', creditsConsumed: 0 },
      expect.objectContaining({ attempts: 2 }),
    );
    expect(queues.unlimited.add).not.toHaveBeenCalled();
    expect(queues.generation.add.mock.calls[0][2]).not.toHaveProperty('priority');
  });

  it('Unlocked de imagem sem fila: refaz o job direto a partir da geração e não espera a geração', async () => {
    const { dispatcher, finisher } = setup();
    const plan = await dispatcher.planRequeue(
      generation({ modelUsed: 'sem-censura', type: 'IMAGE_TO_IMAGE' }),
      HELD_AT,
    );
    expect(plan).toEqual({
      kind: 'direct',
      data: {
        generationId: 'gen-1',
        userId: 'user-1',
        creditsConsumed: 200,
        usedFreeGeneration: false,
        prompt: 'retrato de estúdio',
        model: 'sem-censura',
        resolution: 'RES_2K',
        aspectRatio: '3:4',
        mimeType: 'image/png',
        hasInputImages: true,
      },
    });
    finisher.runImageJobDirectly.mockRejectedValueOnce(new Error('provedor fora'));
    await expect(dispatcher.dispatch(plan!)).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(finisher.runImageJobDirectly).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining('gen=gen-1'));
  });

  it('sem job e fora do Unlocked direto (ou ilimitado): null', async () => {
    const { dispatcher } = setup();
    await expect(dispatcher.planRequeue(generation(), HELD_AT)).resolves.toBeNull();
    await expect(
      dispatcher.planRequeue(
        generation({ modelUsed: 'sem-censura', parameters: { unlimited: true } }),
        HELD_AT,
      ),
    ).resolves.toBeNull();
  });

  it('Redis com erro na busca: trata como não achado', async () => {
    const { dispatcher, queues } = setup();
    queues.generation.getJobs.mockRejectedValueOnce(new Error('redis fora'));
    await expect(dispatcher.planRequeue(generation(), HELD_AT)).resolves.toBeNull();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('busca do job'));
  });
});

describe('HeldGenerationDispatcher.dispatch', () => {
  it('fila não registrada: lança (o revisor recebe 503 e a geração volta para a revisão)', async () => {
    const { dispatcher } = setup({ queues: false });
    await expect(
      dispatcher.dispatch({
        kind: 'queue',
        source: 'generation',
        jobName: 'image',
        data: { generationId: 'gen-1' },
        opts: {},
      }),
    ).rejects.toThrow('fila de geração indisponível');
  });
});
