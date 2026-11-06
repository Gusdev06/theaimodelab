import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { HttpException, NotFoundException } from '@nestjs/common';
import { GenerationImageRole, GenerationStatus, GenerationType } from '@prisma/client';
import { GenerateMultipleAnglesDto } from '../dto/generate-multiple-angles.dto';
import {
  MULTIPLE_ANGLES_CREDITS,
  MULTIPLE_ANGLES_MODEL,
  MULTIPLE_ANGLES_SLUG,
  lineageParentsOf,
  multipleAnglesJudgeTexts,
  multipleAnglesPrompt,
  multipleAnglesSafety,
  multipleAnglesSourceProblem,
  resolveMultipleAnglesLineage,
  type MultipleAnglesLineageNode,
  type MultipleAnglesSource,
} from '../multiple-angles.constants';
import { transientPollDelayMs, WavespeedVideoProvider } from '../providers/wavespeed-video.provider';
import { ProviderFailureError } from '../errors/failure-reason';
import { GenerationsService } from '../generations.service';

const SOURCE_ID = 'cmsourcegeneration00000001';
const ROOT_ID = 'cmrootgeneration000000001';
const SOURCE_URL = 'https://cdn.test/generations/cmsourcegeneration00000001/output_0.png';
/** Prompt que a trava de menor barra hoje (termo 'teen'). */
const MINOR_PROMPT = 'a cinematic photo of a teen girl in soft window light';
const ANGLE_PROMPT = multipleAnglesPrompt(90, 0, 1);

const ADULT_PROMPT = 'Photorealistic portrait of an adult woman, 27 years old';

function link(id: string, overrides: Partial<MultipleAnglesLineageNode> = {}): MultipleAnglesLineageNode {
  return { id, type: GenerationType.TEXT_TO_IMAGE, prompt: ADULT_PROMPT, negativePrompt: null, parameters: {}, ...overrides };
}

const angleOf = (parentId: string) => ({ provider: 'wavespeed', mode: 'multiple_angles', sourceGenerationId: parentId });
/** Foto feita a partir de foto, com a trilha gravada na conclusão (as gerações com que as fotos de entrada bateram). */
const fromPhotos = (...sourceIds: string[]) => ({ lineageSourceIds: sourceIds });

function source(overrides: Partial<MultipleAnglesSource> = {}): MultipleAnglesSource {
  return {
    status: GenerationStatus.COMPLETED,
    type: GenerationType.TEXT_TO_IMAGE,
    isDeleted: false,
    expiresAt: null,
    prompt: 'Photorealistic portrait of an adult woman, 27 years old',
    parameters: {},
    inputImageCount: 0,
    outputUrl: SOURCE_URL,
    cleanLineage: null,
    ...overrides,
  };
}

describe('multiple-angles', () => {
  describe('preço e texto guardado', () => {
    it('100 créditos por foto e o texto começa com "The same" (o site não lista como modelo nova)', () => {
      expect(MULTIPLE_ANGLES_CREDITS).toBe(100);
      expect(multipleAnglesPrompt(45, 0, 1)).toBe('The same photo seen from another camera angle (horizontal 45°, vertical 0°, medium shot).');
      expect(multipleAnglesPrompt(180, 30, 0)).toMatch(/^The same .*horizontal 180°, vertical 30°, close-up/);
      expect(multipleAnglesPrompt(0, 0, 9)).toMatch(/medium shot/);
    });
  });

  describe('foto de origem', () => {
    it('aceita a modelo feita do zero aqui (texto puro, sem impressão) e a de linhagem limpa gravada', () => {
      expect(multipleAnglesSourceProblem(source())).toBeNull();
      expect(multipleAnglesSourceProblem(source({ type: GenerationType.IMAGE_TO_IMAGE, inputImageCount: 1, cleanLineage: true }))).toBeNull();
    });

    it('recusa o que não é a modelo de IA da conta: linhagem suja, foto enviada sem impressão, busca na web e prompt clonado', () => {
      expect(multipleAnglesSourceProblem(source({ cleanLineage: false }))).toBe('not_own');
      expect(multipleAnglesSourceProblem(source({ type: GenerationType.IMAGE_TO_IMAGE, inputImageCount: 1 }))).toBe('not_own');
      expect(multipleAnglesSourceProblem(source({ type: GenerationType.IMAGE_TO_IMAGE, inputImageCount: 0 }))).toBe('not_own');
      expect(multipleAnglesSourceProblem(source({ parameters: { google_search: true } }))).toBe('not_own');
      expect(multipleAnglesSourceProblem(source({ prompt: '[reference_override] a woman in a red dress' }))).toBe('not_own');
    });

    it('sem impressão, prompt que a trava barra hoje nunca é linhagem limpa (geração de antes da trava)', () => {
      expect(multipleAnglesSourceProblem(source({ prompt: MINOR_PROMPT }))).toBe('not_own');
      expect(multipleAnglesSourceProblem(source({ prompt: 'नग्न महिला' }))).toBe('not_own');
    });

    it('recusa troca de rosto, provador e vídeo antes de olhar a linhagem', () => {
      for (const type of [GenerationType.FACE_SWAP, GenerationType.VIRTUAL_TRY_ON, GenerationType.IMAGE_TO_VIDEO, GenerationType.MOTION_CONTROL]) {
        expect(multipleAnglesSourceProblem(source({ type, cleanLineage: true }))).toBe('not_image');
      }
    });

    it('recusa o que não existe, foi apagado, não terminou, não tem saída ou já venceu na galeria', () => {
      const now = new Date('2026-11-04T12:00:00Z');
      expect(multipleAnglesSourceProblem(null)).toBe('not_found');
      expect(multipleAnglesSourceProblem(source({ isDeleted: true }))).toBe('not_found');
      expect(multipleAnglesSourceProblem(source({ status: GenerationStatus.PROCESSING }))).toBe('not_ready');
      expect(multipleAnglesSourceProblem(source({ status: GenerationStatus.FAILED }))).toBe('not_ready');
      expect(multipleAnglesSourceProblem(source({ outputUrl: null }))).toBe('not_ready');
      expect(multipleAnglesSourceProblem(source({ outputUrl: 'http://cdn.test/x.png' }))).toBe('not_ready');
      expect(multipleAnglesSourceProblem(source({ expiresAt: new Date('2026-11-04T11:59:59Z') }), now)).toBe('expired');
      expect(multipleAnglesSourceProblem(source({ expiresAt: new Date('2026-11-05T00:00:00Z') }), now)).toBeNull();
    });
  });

  describe('trava de menor sobre a origem', () => {
    it('prompt com menor barra e marca o registro como texto relido; prompt adulto passa', () => {
      expect(multipleAnglesSafety([link(SOURCE_ID)])).toEqual({ kind: 'ok' });
      const minor = multipleAnglesSafety([link(SOURCE_ID, { prompt: MINOR_PROMPT })]);
      expect(minor).toMatchObject({ kind: 'minor', node: { id: SOURCE_ID } });
      expect(minor.kind === 'minor' && minor.match).toBe('angles-source:teen');
    });

    it('prompt negativo com "child, teen" é lista do que evitar, como no pedido original: não barra', () => {
      expect(multipleAnglesSafety([link(SOURCE_ID, { negativePrompt: 'child, teen, underage, deformed hands' })])).toEqual({ kind: 'ok' });
    });

    it('alfabeto sem lista e texto grande demais: ilegível (sem registro); menor na outra ponta da cadeia vence', () => {
      expect(multipleAnglesSafety([link(SOURCE_ID, { prompt: 'नग्न महिला' })])).toEqual({ kind: 'unreadable' });
      expect(multipleAnglesSafety([link(SOURCE_ID, { prompt: 'a'.repeat(50_001) })])).toEqual({ kind: 'unreadable' });
      const chain = [
        link(SOURCE_ID, { type: GenerationType.IMAGE_TO_IMAGE, prompt: 'नग्न महिला', parameters: angleOf(ROOT_ID) }),
        link(ROOT_ID, { prompt: MINOR_PROMPT }),
      ];
      expect(multipleAnglesSafety(chain)).toMatchObject({ kind: 'minor', node: { id: ROOT_ID } });
    });

    it('ângulo de ângulo: o texto fixo do ângulo passa, a raiz é que decide', () => {
      const chain = [
        link(SOURCE_ID, { type: GenerationType.IMAGE_TO_IMAGE, prompt: ANGLE_PROMPT, parameters: angleOf(ROOT_ID) }),
        link(ROOT_ID, { prompt: MINOR_PROMPT }),
      ];
      expect(multipleAnglesSafety(chain)).toMatchObject({ kind: 'minor', node: { id: ROOT_ID } });
      expect(multipleAnglesSafety([chain[0], link(ROOT_ID)])).toEqual({ kind: 'ok' });
    });

    it('foto feita a partir de foto: o texto de cada geração relida da linhagem passa pela trava, não só a ponta', () => {
      const middle = 'cmmiddlegeneration0000001';
      const lineage = [
        link(SOURCE_ID, { type: GenerationType.IMAGE_TO_IMAGE, parameters: fromPhotos(middle) }),
        link(middle, { type: GenerationType.IMAGE_TO_IMAGE, prompt: MINOR_PROMPT, parameters: fromPhotos(ROOT_ID) }),
        link(ROOT_ID),
      ];
      expect(multipleAnglesSafety(lineage)).toMatchObject({ kind: 'minor', node: { id: middle }, match: 'angles-source:teen' });
    });

    it('de onde cada geração saiu: ângulo pela foto de origem, foto a partir de foto pela trilha, texto puro de nada', () => {
      expect(lineageParentsOf(link(SOURCE_ID))).toEqual([]);
      expect(lineageParentsOf(link(SOURCE_ID, { type: GenerationType.IMAGE_TO_IMAGE, parameters: fromPhotos(ROOT_ID) }))).toEqual([ROOT_ID]);
      expect(lineageParentsOf(link(SOURCE_ID, { type: GenerationType.IMAGE_TO_IMAGE, parameters: angleOf(ROOT_ID) }))).toEqual([ROOT_ID]);
      // imagem a partir de foto sem trilha (impressão de antes dela): as fotos de entrada já foram apagadas
      expect(lineageParentsOf(link(SOURCE_ID, { type: GenerationType.IMAGE_TO_IMAGE }))).toBe('untraceable');
      expect(lineageParentsOf(link(SOURCE_ID, { type: GenerationType.IMAGE_TO_IMAGE, parameters: { lineageSourceIds: ['../x'] } }))).toBe('untraceable');
      expect(lineageParentsOf(link(SOURCE_ID, { type: GenerationType.IMAGE_TO_IMAGE, parameters: { mode: 'multiple_angles' } }))).toBe('untraceable');
      expect(lineageParentsOf(link(SOURCE_ID, { type: GenerationType.FACE_SWAP, parameters: fromPhotos(ROOT_ID) }))).toBe('not_image');
    });

    it('sobe a linhagem até o pedido de texto; geração sumida, repetida, sem trilha ou além do limite = não fecha', async () => {
      const middle = 'cmmiddlegeneration0000001';
      const store: Record<string, MultipleAnglesLineageNode> = {
        [middle]: link(middle, { type: GenerationType.IMAGE_TO_IMAGE, prompt: ANGLE_PROMPT, parameters: angleOf(ROOT_ID) }),
        [ROOT_ID]: link(ROOT_ID),
      };
      const loadMany = jest.fn(async (ids: string[]) => ids.map((id) => store[id]).filter((node): node is MultipleAnglesLineageNode => !!node));
      const origin = link(SOURCE_ID, { type: GenerationType.IMAGE_TO_IMAGE, prompt: ANGLE_PROMPT, parameters: angleOf(middle) });

      const full = await resolveMultipleAnglesLineage(origin, loadMany);
      expect(full).toMatchObject({ gap: null, chainRootId: ROOT_ID });
      expect(full.nodes.map((item) => item.id)).toEqual([SOURCE_ID, middle, ROOT_ID]);

      expect(await resolveMultipleAnglesLineage(link(SOURCE_ID), loadMany)).toEqual({ nodes: [link(SOURCE_ID)], chainRootId: SOURCE_ID, gap: null });

      const missing = await resolveMultipleAnglesLineage(
        link(SOURCE_ID, { type: GenerationType.IMAGE_TO_IMAGE, parameters: angleOf('cmnotinthisaccount000001') }),
        loadMany,
      );
      expect(missing.gap).toBe('missing');

      const loop = await resolveMultipleAnglesLineage(link(SOURCE_ID, { type: GenerationType.IMAGE_TO_IMAGE, parameters: angleOf(SOURCE_ID) }), loadMany);
      expect(loop.gap).toBe('missing');

      const noTrail = await resolveMultipleAnglesLineage(link(SOURCE_ID, { type: GenerationType.IMAGE_TO_IMAGE }), loadMany);
      expect(noTrail).toMatchObject({ gap: 'untraceable', nodes: [{ id: SOURCE_ID }] });

      expect((await resolveMultipleAnglesLineage(origin, loadMany, { maxHops: 1, maxNodes: 24 })).gap).toBe('too_deep');
      expect((await resolveMultipleAnglesLineage(origin, loadMany, { maxHops: 10, maxNodes: 2 })).gap).toBe('too_deep');
    });

    it('duas fotos de entrada da mesma raiz: cada geração é relida uma vez, nível a nível', async () => {
      const left = 'cmleftgeneration000000001';
      const right = 'cmrightgeneration00000001';
      const store: Record<string, MultipleAnglesLineageNode> = {
        [left]: link(left, { type: GenerationType.IMAGE_TO_IMAGE, parameters: fromPhotos(ROOT_ID) }),
        [right]: link(right, { type: GenerationType.IMAGE_TO_IMAGE, parameters: fromPhotos(ROOT_ID) }),
        [ROOT_ID]: link(ROOT_ID),
      };
      const loadMany = jest.fn(async (ids: string[]) => ids.map((id) => store[id]).filter((node): node is MultipleAnglesLineageNode => !!node));
      const lineage = await resolveMultipleAnglesLineage(
        link(SOURCE_ID, { type: GenerationType.IMAGE_TO_IMAGE, parameters: fromPhotos(left, right) }),
        loadMany,
      );
      expect(lineage.gap).toBeNull();
      expect(lineage.nodes.map((node) => node.id)).toEqual([SOURCE_ID, left, right, ROOT_ID]);
      expect(loadMany.mock.calls).toEqual([[[left, right]], [[ROOT_ID]]]);
      // a origem não é ângulo: é ela a foto que originou a cadeia
      expect(lineage.chainRootId).toBe(SOURCE_ID);
    });

    it('textos para o juiz: os pedidos da cliente na linhagem, sem o texto fixo dos ângulos e sem repetir', () => {
      expect(
        multipleAnglesJudgeTexts([
          link(SOURCE_ID, { type: GenerationType.IMAGE_TO_IMAGE, prompt: ANGLE_PROMPT, parameters: angleOf(ROOT_ID) }),
          link(ROOT_ID),
          link('cmothergeneration00000001', { prompt: `  ${ADULT_PROMPT} ` }),
          link('cmemptygeneration00000001', { prompt: null }),
        ]),
      ).toEqual([ADULT_PROMPT]);
    });
  });

  describe('DTO', () => {
    const valid = { source_generation_id: SOURCE_ID, horizontal_angle: 45 };

    it('aceita o pedido mínimo e converte números que chegam como texto', () => {
      const dto = plainToInstance(GenerateMultipleAnglesDto, { ...valid, horizontal_angle: '90', vertical_angle: '30', distance: '0', source_output: '1' });
      expect(validateSync(dto)).toHaveLength(0);
      expect(dto).toMatchObject({ horizontal_angle: 90, vertical_angle: 30, distance: 0, source_output: 1 });
    });

    it('recusa ângulo fora da grade do modelo, id estranho e saída fora da faixa', () => {
      const props = (body: Record<string, unknown>) => validateSync(plainToInstance(GenerateMultipleAnglesDto, { ...valid, ...body })).map((error) => error.property);
      expect(props({ horizontal_angle: 30 })).toEqual(['horizontal_angle']);
      expect(props({ horizontal_angle: 360 })).toEqual(['horizontal_angle']);
      expect(props({ vertical_angle: 15 })).toEqual(['vertical_angle']);
      expect(props({ distance: 3 })).toEqual(['distance']);
      expect(props({ source_output: 4 })).toEqual(['source_output']);
      expect(props({ source_generation_id: '../../etc' })).toEqual(['source_generation_id']);
      expect(validateSync(plainToInstance(GenerateMultipleAnglesDto, { horizontal_angle: 0 })).map((error) => error.property)).toEqual(['source_generation_id']);
    });

    it('não tem campo de foto nem de texto', () => {
      const dto = plainToInstance(GenerateMultipleAnglesDto, { ...valid, prompt: 'nude', images: ['AAAA'] });
      expect(validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).map((error) => error.property).sort()).toEqual(['images', 'prompt']);
    });
  });

  describe('provedor WaveSpeed', () => {
    function provider(fetchImpl: typeof fetch) {
      const config = { get: (key: string, fallback?: string) => (key === 'WAVESPEED_API_KEY' ? 'k' : fallback) };
      const uploads = { uploadBuffer: jest.fn().mockResolvedValue('https://cdn.test/generations/g1/output_0.png') };
      global.fetch = fetchImpl;
      const instance = new WavespeedVideoProvider(config as never, uploads as never);
      const wait = jest
        .spyOn(instance as unknown as { wait: (ms: number) => Promise<void> }, 'wait')
        .mockResolvedValue(undefined);
      return { instance, uploads, wait };
    }

    /** Fetch simulado: criar → id 'p'; cada consulta devolve a próxima resposta da lista; download da foto. */
    function scripted(polls: Array<Response | Error>) {
      let next = 0;
      return jest.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.endsWith(`/api/v3/${MULTIPLE_ANGLES_MODEL}`)) return new Response(JSON.stringify({ data: { id: 'p' } }), { status: 200 });
        if (href.endsWith('/predictions/p/result')) {
          const answer = polls[Math.min(next++, polls.length - 1)];
          if (answer instanceof Error) throw answer;
          return answer.clone();
        }
        return new Response(Buffer.from('jpg'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      });
    }
    const pollCalls = (fetchImpl: jest.Mock) => fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/result')).length;
    const completed = () => new Response(JSON.stringify({ data: { id: 'p', status: 'completed', outputs: ['https://ws.test/o.jpg'] } }), { status: 200 });
    const run = (instance: WavespeedVideoProvider) =>
      instance.generateMultipleAngles({ id: 'g1', imageUrl: SOURCE_URL, horizontalAngle: 0, verticalAngle: 0, distance: 1 });

    it('consulta com 502, 429 ou rede fora por um instante: espera e conclui (a foto já foi cobrada lá)', async () => {
      const fetchImpl = scripted([
        new Response('bad gateway', { status: 502 }),
        new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }),
        Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
        new Response(JSON.stringify({ data: { id: 'p', status: 'processing' } }), { status: 200 }),
        completed(),
      ]);
      const { instance, uploads, wait } = provider(fetchImpl as unknown as typeof fetch);
      await expect(run(instance)).resolves.toEqual({ outputUrls: ['https://cdn.test/generations/g1/output_0.png'], modelUsed: MULTIPLE_ANGLES_MODEL });
      expect(pollCalls(fetchImpl)).toBe(5);
      expect(uploads.uploadBuffer).toHaveBeenCalledTimes(1);
      // 3 s depois do 502, o Retry-After de 7 s, 10 s depois da 3ª falha seguida; resposta boa volta aos 3 s
      expect(wait.mock.calls.map(([ms]) => ms)).toEqual([3_000, 7_000, 10_000, 3_000]);
    });

    it('status cancelled, timeout ou deleted: falha final na hora, com mensagem de foto', async () => {
      for (const status of ['cancelled', 'timeout', 'deleted']) {
        const fetchImpl = scripted([new Response(JSON.stringify({ data: { id: 'p', status } }), { status: 200 })]);
        const { instance } = provider(fetchImpl as unknown as typeof fetch);
        const attempt = run(instance);
        await expect(attempt).rejects.toBeInstanceOf(ProviderFailureError);
        await expect(attempt).rejects.toMatchObject({ message: 'A geração da foto falhou. Tente novamente.', providerDetail: `status=${status}` });
        expect(pollCalls(fetchImpl)).toBe(1);
      }
    });

    it('404 na consulta encerra na hora; 6 falhas passageiras seguidas também (mensagem de foto)', async () => {
      const notFound = scripted([new Response('not found', { status: 404 })]);
      const first = provider(notFound as unknown as typeof fetch);
      await expect(run(first.instance)).rejects.toMatchObject({ message: 'Não foi possível gerar a foto agora. Tente novamente em alguns instantes.' });
      expect(pollCalls(notFound)).toBe(1);

      const down = scripted([new Response('unavailable', { status: 503 })]);
      const second = provider(down as unknown as typeof fetch);
      await expect(run(second.instance)).rejects.toMatchObject({ message: 'Não foi possível gerar a foto agora. Tente novamente em alguns instantes.', providerDetail: expect.stringMatching(/^503/) });
      expect(pollCalls(down)).toBe(6);
    });

    it('espera da consulta: 3 s, 6 s, 10 s no máximo; Retry-After em segundos ou data, até 60 s', () => {
      expect([1, 2, 3, 4].map((streak) => transientPollDelayMs(streak, null))).toEqual([3_000, 6_000, 10_000, 10_000]);
      expect(transientPollDelayMs(1, '1')).toBe(3_000);
      expect(transientPollDelayMs(1, '20')).toBe(20_000);
      expect(transientPollDelayMs(1, '600')).toBe(60_000);
      const now = Date.parse('2026-11-05T12:00:00Z');
      expect(transientPollDelayMs(1, 'Thu, 05 Nov 2026 12:00:15 GMT', now)).toBe(15_000);
      expect(transientPollDelayMs(2, 'amanhã', now)).toBe(6_000);
    });

    it('manda a foto e o ângulo (sem prompt), espera a predição e guarda a foto com o tipo certo', async () => {
      const calls: Array<{ url: string; body?: unknown }> = [];
      const fetchImpl = jest.fn(async (url: string | URL, init?: RequestInit) => {
        const href = String(url);
        calls.push({ url: href, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (href.endsWith(`/api/v3/${MULTIPLE_ANGLES_MODEL}`)) return new Response(JSON.stringify({ data: { id: 'pred-9' } }), { status: 200 });
        if (href.endsWith('/api/v3/predictions/pred-9/result')) {
          return new Response(JSON.stringify({ data: { status: 'completed', outputs: ['https://ws.test/out.png'] } }), { status: 200 });
        }
        if (href === 'https://ws.test/out.png') return new Response(Buffer.from('png'), { status: 200, headers: { 'content-type': 'image/png' } });
        throw new Error(`unexpected ${href}`);
      });
      const { instance, uploads } = provider(fetchImpl as unknown as typeof fetch);
      const result = await instance.generateMultipleAngles({ id: 'g1', imageUrl: SOURCE_URL, horizontalAngle: 180, verticalAngle: 0, distance: 1 });
      expect(result).toEqual({ outputUrls: ['https://cdn.test/generations/g1/output_0.png'], modelUsed: MULTIPLE_ANGLES_MODEL });
      expect(calls[0].body).toEqual({
        images: [SOURCE_URL],
        horizontal_angle: 180,
        vertical_angle: 0,
        distance: 1,
        output_format: 'jpeg',
        enable_base64_output: false,
        enable_sync_mode: false,
      });
      expect(calls[0].body).not.toHaveProperty('prompt');
      expect(uploads.uploadBuffer).toHaveBeenCalledWith(expect.any(Buffer), 'generations/g1', 'output_0.png', 'image/png');
    });

    it('tipo desconhecido vira jpeg; foto sem https não chama o provedor', async () => {
      const fetchImpl = jest.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.endsWith(`/api/v3/${MULTIPLE_ANGLES_MODEL}`)) return new Response(JSON.stringify({ data: { id: 'p' } }), { status: 200 });
        if (href.endsWith('/predictions/p/result')) return new Response(JSON.stringify({ data: { status: 'completed', outputs: ['https://ws.test/o'] } }), { status: 200 });
        return new Response(Buffer.from('jpg'), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      });
      const { instance, uploads } = provider(fetchImpl as unknown as typeof fetch);
      await instance.generateMultipleAngles({ id: 'g1', imageUrl: SOURCE_URL, horizontalAngle: 0, verticalAngle: 0, distance: 1 });
      expect(uploads.uploadBuffer).toHaveBeenCalledWith(expect.any(Buffer), 'generations/g1', 'output_0.jpg', 'image/jpeg');

      const never = jest.fn();
      const second = provider(never as unknown as typeof fetch);
      await expect(second.instance.generateMultipleAngles({ id: 'g1', imageUrl: 'data:image/png;base64,AAAA', horizontalAngle: 0, verticalAngle: 0, distance: 1 })).rejects.toThrow(/origem/);
      expect(never).not.toHaveBeenCalled();
    });
  });

  describe('serviço', () => {
    interface StoredEvent {
      generationId: string;
      kind: string;
      match: string;
      releasedAt: Date | null;
    }

    interface HarnessOptions {
      /** conta na guarda legal por menor */
      onHold?: boolean;
      /** juiz de prompt (PR #16); ausente = módulo sem o juiz */
      judge?: { enabled: () => boolean; mode: () => string; review: jest.Mock };
    }

    /** `ancestors`: gerações buscadas ao subir a linhagem (por id); `events`: content_safety_events da conta. */
    function harness(found: unknown, ancestors: Record<string, unknown> = {}, events: StoredEvent[] = [], options: HarnessOptions = {}) {
      const prisma = {
        generation: {
          findFirst: jest.fn(async ({ where }: { where: { id: string } }) => (where.id === SOURCE_ID ? found : null)),
          findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ancestors[id]).filter(Boolean)),
          create: jest.fn().mockResolvedValue({ id: 'cmnewgeneration000000001' }),
          delete: jest.fn(),
        },
        generationInputImage: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
        contentSafetyEvent: {
          findFirst: jest.fn(
            async ({ where }: { where: { generationId: string | { in: string[] }; kind: string; releasedAt?: null; match?: { startsWith: string } } }) => {
              const ids = typeof where.generationId === 'string' ? [where.generationId] : where.generationId.in;
              const hit = events.find(
                (event) =>
                  ids.includes(event.generationId) &&
                  event.kind === where.kind &&
                  (where.releasedAt !== null || event.releasedAt === null) &&
                  (!where.match || event.match.startsWith(where.match.startsWith)),
              );
              return hit ? { id: 'evt', generationId: hit.generationId } : null;
            },
          ),
        },
      };
      const contentSafety = {
        record: jest.fn(async (event: { generationId: string; kind: string; match: string }) => {
          events.push({ generationId: event.generationId, kind: event.kind, match: event.match, releasedAt: null });
          return 'evt-new';
        }),
        isUnderMinorHold: jest.fn().mockResolvedValue(options.onHold ?? false),
      };
      const modelsService = { assertActiveBySlug: jest.fn().mockResolvedValue(undefined) };
      const creditsService = {
        getBalance: jest.fn().mockResolvedValue({ totalCreditsAvailable: 5_000 }),
        debit: jest.fn().mockResolvedValue(undefined),
      };
      const generationProcessor = { runMultipleAnglesDirectly: jest.fn().mockResolvedValue(undefined) };
      const service = Object.assign(Object.create(GenerationsService.prototype), {
        prisma,
        modelsService,
        creditsService,
        generationProcessor,
        contentSafety,
        promptJudge: options.judge,
        logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      }) as GenerationsService;
      return { service, prisma, modelsService, creditsService, generationProcessor, contentSafety, events };
    }

    /** Recusa antes de criar a geração, de olhar o saldo e de cobrar. */
    function expectNothingCharged(h: ReturnType<typeof harness>) {
      expect(h.prisma.generation.create).not.toHaveBeenCalled();
      expect(h.creditsService.getBalance).not.toHaveBeenCalled();
      expect(h.creditsService.debit).not.toHaveBeenCalled();
      expect(h.generationProcessor.runMultipleAnglesDirectly).not.toHaveBeenCalled();
    }

    const stored = {
      status: GenerationStatus.COMPLETED,
      type: GenerationType.TEXT_TO_IMAGE,
      isDeleted: false,
      expiresAt: null,
      prompt: 'Photorealistic portrait of an adult woman, 27 years old',
      parameters: {},
      aspectRatio: '9:16',
      _count: { inputImages: 0 },
      outputs: [{ url: SOURCE_URL }],
      mediaFingerprints: [{ cleanLineage: true }],
    };

    it('usa a NOSSA cópia da foto de origem, cobra 100 e manda o ângulo ao processador', async () => {
      const { service, prisma, modelsService, creditsService, generationProcessor } = harness(stored);
      const result = await service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 90 });

      expect(modelsService.assertActiveBySlug).toHaveBeenCalledWith(MULTIPLE_ANGLES_SLUG, 'IMAGE');
      expect(prisma.generation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: SOURCE_ID, userId: 'user-1' } }));
      const created = prisma.generation.create.mock.calls[0][0].data;
      expect(created).toMatchObject({
        userId: 'user-1',
        type: GenerationType.IMAGE_TO_IMAGE,
        modelUsed: MULTIPLE_ANGLES_MODEL,
        creditsConsumed: 100,
        aspectRatio: '9:16',
        parameters: {
          mode: 'multiple_angles',
          sourceGenerationId: SOURCE_ID,
          rootGenerationId: SOURCE_ID,
          horizontalAngle: 90,
          verticalAngle: 0,
          distance: 1,
        },
      });
      expect(created.prompt).toMatch(/^The same /);
      expect(prisma.generationInputImage.createMany).toHaveBeenCalledWith({
        data: [{ generationId: 'cmnewgeneration000000001', role: GenerationImageRole.REFERENCE, order: 0, url: SOURCE_URL }],
      });
      expect(creditsService.debit).toHaveBeenCalledWith('user-1', 100, 'GENERATION_DEBIT', 'cmnewgeneration000000001', expect.any(String));
      expect(generationProcessor.runMultipleAnglesDirectly).toHaveBeenCalledWith(
        expect.objectContaining({ generationId: 'cmnewgeneration000000001', imageUrl: SOURCE_URL, horizontalAngle: 90, verticalAngle: 0, distance: 1, creditsConsumed: 100 }),
      );
      expect(result).toEqual({ id: 'cmnewgeneration000000001', status: GenerationStatus.PROCESSING, creditsConsumed: 100 });
    });

    it('origem de texto com prompt que a trava barra: 422 CONTENT_POLICY_MINOR, registro ligado à origem, nada cobrado', async () => {
      for (const fingerprint of [[], [{ cleanLineage: true }], [{ cleanLineage: false }]]) {
        const h = harness({ ...stored, prompt: MINOR_PROMPT, mediaFingerprints: fingerprint });
        const attempt = h.service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 0 });
        await expect(attempt).rejects.toMatchObject({ status: 422, response: { code: 'CONTENT_POLICY_MINOR' } });
        expect(h.contentSafety.record).toHaveBeenCalledTimes(1);
        expect(h.contentSafety.record).toHaveBeenCalledWith({
          userId: 'user-1',
          kind: 'MINOR_BLOCKED',
          route: 'POST /api/v1/generations/multiple-angles',
          match: 'angles-source:teen',
          excerpt: MINOR_PROMPT,
          generationId: SOURCE_ID,
        });
        expectNothingCharged(h);
      }
    });

    it('ângulo de um ângulo cuja foto original foi pedida com menor: 422 e o registro vai para a raiz', async () => {
      const h = harness(
        { ...stored, type: GenerationType.IMAGE_TO_IMAGE, prompt: ANGLE_PROMPT, parameters: angleOf(ROOT_ID), _count: { inputImages: 1 } },
        { [ROOT_ID]: link(ROOT_ID, { prompt: MINOR_PROMPT }) },
      );
      await expect(h.service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 0 })).rejects.toMatchObject({
        status: 422,
        response: { code: 'CONTENT_POLICY_MINOR' },
      });
      expect(h.prisma.generation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [ROOT_ID] }, userId: 'user-1' } }));
      expect(h.contentSafety.record).toHaveBeenCalledWith(expect.objectContaining({ generationId: ROOT_ID, match: 'angles-source:teen' }));
      expectNothingCharged(h);
    });

    it('ângulo de um ângulo com a raiz limpa: cobra e grava a raiz na geração nova', async () => {
      const h = harness(
        { ...stored, type: GenerationType.IMAGE_TO_IMAGE, prompt: ANGLE_PROMPT, parameters: angleOf(ROOT_ID), _count: { inputImages: 1 } },
        { [ROOT_ID]: link(ROOT_ID) },
      );
      await h.service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 45 });
      expect(h.prisma.generation.create.mock.calls[0][0].data.parameters).toMatchObject({ sourceGenerationId: SOURCE_ID, rootGenerationId: ROOT_ID });
      expect(h.contentSafety.record).not.toHaveBeenCalled();
      expect(h.creditsService.debit).toHaveBeenCalledTimes(1);
    });

    /** "Foto nova" do hub: imagem feita a partir de uma foto da conta, impressão limpa, com a trilha gravada na conclusão. */
    const INPUT_ID = 'cminputgeneration00000001';
    const fromOwnPhoto = (parameters: Record<string, unknown> = fromPhotos(INPUT_ID)) => ({
      ...stored,
      type: GenerationType.IMAGE_TO_IMAGE,
      prompt: 'the same woman sitting at a cafe terrace, golden hour',
      parameters,
      mediaFingerprints: [{ cleanLineage: true }],
    });

    it('foto feita a partir de uma foto antiga cujo pedido a trava barra hoje: 422, registro na foto de entrada, nada cobrado', async () => {
      const h = harness(fromOwnPhoto(), { [INPUT_ID]: link(INPUT_ID, { prompt: MINOR_PROMPT }) });
      await expect(h.service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 0 })).rejects.toMatchObject({
        status: 422,
        response: { code: 'CONTENT_POLICY_MINOR' },
      });
      expect(h.prisma.generation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [INPUT_ID] }, userId: 'user-1' } }));
      expect(h.contentSafety.record).toHaveBeenCalledTimes(1);
      expect(h.contentSafety.record).toHaveBeenCalledWith(expect.objectContaining({ generationId: INPUT_ID, match: 'angles-source:teen' }));
      expectNothingCharged(h);
    });

    it('foto feita a partir de foto com impressão limpa mas sem trilha (gravada antes dela): 422 MULTIPLE_ANGLES_SOURCE_POLICY, sem registro', async () => {
      const h = harness(fromOwnPhoto({}));
      await expect(h.service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 0 })).rejects.toMatchObject({
        status: 422,
        response: { code: 'MULTIPLE_ANGLES_SOURCE_POLICY' },
      });
      expect(h.prisma.generation.findMany).not.toHaveBeenCalled();
      expect(h.contentSafety.record).not.toHaveBeenCalled();
      expectNothingCharged(h);
    });

    it('foto feita a partir de foto sem trilha e de linhagem suja: continua "não é a modelo da conta"', async () => {
      const h = harness({ ...fromOwnPhoto({}), mediaFingerprints: [{ cleanLineage: false }] });
      await expect(h.service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 0 })).rejects.toMatchObject({
        status: 422,
        response: { code: 'MULTIPLE_ANGLES_SOURCE_NOT_OWN' },
      });
      expectNothingCharged(h);
    });

    it('foto de entrada com recusa do provedor por menor ligada a ela: 422 sem registro novo', async () => {
      const h = harness(fromOwnPhoto(), { [INPUT_ID]: link(INPUT_ID) }, [
        { generationId: INPUT_ID, kind: 'MINOR_BLOCKED', match: 'provider-minor', releasedAt: null },
      ]);
      await expect(h.service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 0 })).rejects.toMatchObject({
        response: { code: 'CONTENT_POLICY_MINOR' },
      });
      expect(h.contentSafety.record).not.toHaveBeenCalled();
      expectNothingCharged(h);
    });

    it('foto feita a partir de foto limpa, com trilha: cobra, e a geração nova aponta para a própria origem', async () => {
      const h = harness(fromOwnPhoto(), { [INPUT_ID]: link(INPUT_ID) });
      await h.service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 90 });
      expect(h.prisma.generation.create.mock.calls[0][0].data.parameters).toMatchObject({ sourceGenerationId: SOURCE_ID, rootGenerationId: SOURCE_ID });
      expect(h.contentSafety.record).not.toHaveBeenCalled();
      expect(h.creditsService.debit).toHaveBeenCalledTimes(1);
    });

    it('conta na guarda legal por menor (admin, suspensão desligada ou guarda antiga): 422 sem registro novo', async () => {
      const h = harness(stored, {}, [], { onHold: true });
      await expect(h.service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 0 })).rejects.toMatchObject({
        status: 422,
        response: { code: 'CONTENT_POLICY_MINOR' },
      });
      expect(h.contentSafety.isUnderMinorHold).toHaveBeenCalledWith('user-1');
      expect(h.contentSafety.record).not.toHaveBeenCalled();
      expectNothingCharged(h);
    });

    describe('juiz de prompt sobre a linhagem', () => {
      const judge = (mode: 'enforce' | 'shadow', category = 'minor', confidence = 'high') => ({
        enabled: () => true,
        mode: () => mode,
        review: jest.fn().mockResolvedValue({
          verdict: { category, confidence, reason: 'descreve criança', who: '' },
          source: 'model',
          latencyMs: 12,
          model: 'claude-haiku-5-5',
        }),
      });
      const angleOfRoot = { ...stored, type: GenerationType.IMAGE_TO_IMAGE, prompt: ANGLE_PROMPT, parameters: angleOf(ROOT_ID) };

      it('enforce + menor com confiança alta: 422, registro na foto que originou a cadeia, nada cobrado', async () => {
        const reader = judge('enforce');
        const h = harness(angleOfRoot, { [ROOT_ID]: link(ROOT_ID) }, [], { judge: reader });
        await expect(h.service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 0 })).rejects.toMatchObject({
          status: 422,
          response: { code: 'CONTENT_POLICY_MINOR' },
        });
        // o texto fixo do ângulo não vai ao juiz; o alvo (Qwen) não tem filtro
        expect(reader.review).toHaveBeenCalledWith([ADULT_PROMPT], { uncensored: true });
        expect(h.contentSafety.record).toHaveBeenCalledWith(
          expect.objectContaining({ generationId: ROOT_ID, match: 'angles-source:judge:minor', excerpt: ADULT_PROMPT }),
        );
        expectNothingCharged(h);
      });

      it('shadow, confiança média ou juiz desligado: segue e cobra', async () => {
        for (const reader of [judge('shadow'), judge('enforce', 'minor', 'medium'), { ...judge('enforce'), enabled: () => false }]) {
          const h = harness(angleOfRoot, { [ROOT_ID]: link(ROOT_ID) }, [], { judge: reader });
          await expect(h.service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 0 })).resolves.toMatchObject({
            id: 'cmnewgeneration000000001',
          });
          expect(h.contentSafety.record).not.toHaveBeenCalled();
        }
      });

      it('a trava de termos e a falta de trilha decidem antes: o juiz nem é chamado', async () => {
        const reader = judge('enforce');
        await expect(
          harness({ ...stored, prompt: MINOR_PROMPT }, {}, [], { judge: reader }).service.generateMultipleAngles('user-1', {
            source_generation_id: SOURCE_ID,
            horizontal_angle: 0,
          }),
        ).rejects.toMatchObject({ response: { code: 'CONTENT_POLICY_MINOR' } });
        await expect(
          harness(fromOwnPhoto({}), {}, [], { judge: reader }).service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 0 }),
        ).rejects.toMatchObject({ response: { code: 'MULTIPLE_ANGLES_SOURCE_POLICY' } });
        expect(reader.review).not.toHaveBeenCalled();
      });
    });

    it('ângulo cuja foto de origem não está na conta: 422 MULTIPLE_ANGLES_SOURCE_POLICY sem registro', async () => {
      const h = harness({ ...stored, type: GenerationType.IMAGE_TO_IMAGE, prompt: ANGLE_PROMPT, parameters: angleOf(ROOT_ID), _count: { inputImages: 1 } });
      await expect(h.service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 0 })).rejects.toMatchObject({
        status: 422,
        response: { code: 'MULTIPLE_ANGLES_SOURCE_POLICY' },
      });
      expect(h.contentSafety.record).not.toHaveBeenCalled();
      expectNothingCharged(h);
    });

    it('origem com bloqueio por menor ligado a ela (filtro ou recusa do provedor): 422 sem registro novo', async () => {
      for (const match of ['teen', 'provider-minor']) {
        const h = harness(stored, {}, [{ generationId: SOURCE_ID, kind: 'MINOR_BLOCKED', match, releasedAt: null }]);
        await expect(h.service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 0 })).rejects.toMatchObject({
          status: 422,
          response: { code: 'CONTENT_POLICY_MINOR' },
        });
        expect(h.contentSafety.record).not.toHaveBeenCalled();
        expectNothingCharged(h);
      }
      // bloqueio já liberado pelo jurídico não segura a origem limpa
      const released = harness(stored, {}, [{ generationId: SOURCE_ID, kind: 'MINOR_BLOCKED', match: 'teen', releasedAt: new Date() }]);
      await expect(released.service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 0 })).resolves.toMatchObject({ id: 'cmnewgeneration000000001' });
    });

    it('toque repetido na mesma origem barrada: um registro só (a suspensão automática não escala)', async () => {
      const events: StoredEvent[] = [];
      const h = harness({ ...stored, prompt: MINOR_PROMPT }, {}, events);
      for (let tap = 0; tap < 3; tap++) {
        await expect(h.service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 0 })).rejects.toMatchObject({
          response: { code: 'CONTENT_POLICY_MINOR' },
        });
      }
      expect(h.contentSafety.record).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(1);

      // o registro foi liberado pelo jurídico, mas a trava ainda barra o texto: recusa sem gravar de novo
      events[0].releasedAt = new Date();
      await expect(h.service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 0 })).rejects.toMatchObject({
        response: { code: 'CONTENT_POLICY_MINOR' },
      });
      expect(h.contentSafety.record).toHaveBeenCalledTimes(1);
      expectNothingCharged(h);
    });

    it('origem em alfabeto que a trava não lê: 422 MULTIPLE_ANGLES_SOURCE_POLICY sem registro de abuso', async () => {
      const h = harness({ ...stored, prompt: 'नग्न महिला' });
      await expect(h.service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 0 })).rejects.toMatchObject({
        status: 422,
        response: { code: 'MULTIPLE_ANGLES_SOURCE_POLICY' },
      });
      expect(h.contentSafety.record).not.toHaveBeenCalled();
      expectNothingCharged(h);
    });

    it('foto que não é a modelo da conta: 422 sem criar nem cobrar', async () => {
      const { service, prisma, creditsService } = harness({ ...stored, mediaFingerprints: [{ cleanLineage: false }] });
      const attempt = service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 0 });
      await expect(attempt).rejects.toBeInstanceOf(HttpException);
      await expect(attempt).rejects.toMatchObject({ status: 422, response: { code: 'MULTIPLE_ANGLES_SOURCE_NOT_OWN' } });
      expect(prisma.generation.create).not.toHaveBeenCalled();
      expect(creditsService.debit).not.toHaveBeenCalled();
    });

    it('geração de outra conta (a busca filtra pela conta): 404', async () => {
      const { service, prisma } = harness(null);
      await expect(service.generateMultipleAngles('user-2', { source_generation_id: SOURCE_ID, horizontal_angle: 0 })).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.generation.create).not.toHaveBeenCalled();
    });

    it('sem saldo: 402 antes de criar a geração', async () => {
      const { service, prisma, creditsService } = harness(stored);
      creditsService.getBalance.mockResolvedValue({ totalCreditsAvailable: 99 });
      await expect(service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 0 })).rejects.toMatchObject({
        response: { code: 'INSUFFICIENT_CREDITS' },
      });
      expect(prisma.generation.create).not.toHaveBeenCalled();
    });

    it('modelo desligado no admin: nada é lido nem cobrado', async () => {
      const { service, prisma, modelsService } = harness(stored);
      modelsService.assertActiveBySlug.mockRejectedValue(new NotFoundException({ code: 'MODEL_NOT_FOUND' }));
      await expect(service.generateMultipleAngles('user-1', { source_generation_id: SOURCE_ID, horizontal_angle: 0 })).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.generation.findFirst).not.toHaveBeenCalled();
    });
  });
});
