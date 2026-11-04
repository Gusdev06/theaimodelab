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
  multipleAnglesPrompt,
  multipleAnglesSourceProblem,
  type MultipleAnglesSource,
} from '../multiple-angles.constants';
import { WavespeedVideoProvider } from '../providers/wavespeed-video.provider';
import { GenerationsService } from '../generations.service';

const SOURCE_ID = 'cmsourcegeneration00000001';
const SOURCE_URL = 'https://cdn.test/generations/cmsourcegeneration00000001/output_0.png';

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
      return { instance: new WavespeedVideoProvider(config as never, uploads as never), uploads };
    }

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
    function harness(found: unknown) {
      const prisma = {
        generation: {
          findFirst: jest.fn().mockResolvedValue(found),
          create: jest.fn().mockResolvedValue({ id: 'cmnewgeneration000000001' }),
          delete: jest.fn(),
        },
        generationInputImage: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
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
        logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      }) as GenerationsService;
      return { service, prisma, modelsService, creditsService, generationProcessor };
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
        parameters: { mode: 'multiple_angles', sourceGenerationId: SOURCE_ID, horizontalAngle: 90, verticalAngle: 0, distance: 1 },
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
