import { BadRequestException, HttpStatus, Logger } from '@nestjs/common';
import { AvatarStatus } from '@prisma/client';
import { BusinessException } from '../../common/exceptions/business.exception';
import {
  READINGS,
  buildMediaCheck,
} from '../../content-safety/image-safety/__tests__/external-media-check.harness';
import { SafetyProviderUnavailableError } from '../../content-safety/image-safety/types';
import { StorageReadError } from '../../uploads/uploads.service';
import { AvatarsService } from '../avatars.service';

/**
 * Avatar da HeyGen: a foto (ou o vídeo do digital twin) e a imagem de fundo passam pela checagem ANTES do débito e da
 * fila que manda à HeyGen. Leitor simulado (o conteúdo da "foto" é o texto `bytes:<chave>`), nenhuma imagem.
 */

const USER = 'user-1';
const KEY = 'avatar_source/u1/foto.jpg';
const VIDEO_KEY = 'avatar_source/u2/gravacao.mp4';
const CONTENT = (key: string) => `bytes:${key}`;

function build(mediaCheck = buildMediaCheck({ mode: 'off' })) {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    subscription: {
      findFirst: jest.fn(async () => ({
        plan: { slug: 'pro', avatar_clone_enabled: true, avatar_clone_limit: 3 },
      })),
    },
    userAvatar: {
      count: jest.fn(async () => 0),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        const row = { id: 'avatar-1', createdAt: new Date(), ...args.data };
        created.push(row);
        return row;
      }),
      delete: jest.fn(async () => ({})),
      findFirst: jest.fn(async () => ({
        id: 'avatar-1',
        userId: USER,
        name: 'Minha',
        status: AvatarStatus.READY,
        heygenLookId: 'look-1',
        supportedEngines: ['avatar_iv'],
      })),
    },
    voiceProfile: { findFirst: jest.fn(async () => null) },
    generation: {
      create: jest.fn(async () => ({ id: 'gen-1' })),
      delete: jest.fn(async () => ({})),
    },
  };
  const credits = {
    debitForAvatar: jest.fn(async () => undefined),
    debit: jest.fn(async () => undefined),
  };
  const heygen = { createPhotoAvatar: jest.fn(), createDigitalTwin: jest.fn() };
  const config = { get: jest.fn(() => undefined) };
  const models = { assertActiveBySlug: jest.fn(async () => undefined) };
  const queue = { add: jest.fn(async () => undefined) };
  const service = new AvatarsService(
    prisma as never,
    mediaCheck.uploads as never,
    credits as never,
    heygen as never,
    config as never,
    models as never,
    queue as never,
    mediaCheck.check,
  );
  return { service, prisma, credits, heygen, queue, created, mediaCheck };
}

const codeOf = (error: unknown) =>
  ((error as BusinessException).getResponse() as { code: string }).code;

describe('AvatarsService: mídia checada antes da HeyGen', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('criação (avatar_source)', () => {
    it('checagem desligada: a chave enviada vai à HeyGen como hoje, sem ler nada', async () => {
      const { service, created, queue, mediaCheck } = build();
      await service.create(USER, { name: 'Minha', sourceMediaKey: KEY });
      expect(created[0]).toMatchObject({ sourceVideoKey: KEY, sourceVideoUrl: `https://cdn.test/${KEY}` });
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(mediaCheck.uploads.readStoredObject).not.toHaveBeenCalled();
      expect(mediaCheck.scanner.detect).not.toHaveBeenCalled();
    });

    it('leitor acusa criança: 422, sem avatar, sem débito e nada vai à fila da HeyGen; a foto do caso leve é apagada', async () => {
      const mediaCheck = buildMediaCheck({ scans: { [CONTENT(KEY)]: READINGS.child } });
      const { service, prisma, credits, queue, heygen } = build(mediaCheck);
      const error = await service
        .create(USER, { name: 'Minha', sourceMediaKey: KEY })
        .catch((caught: unknown) => caught);
      expect((error as BusinessException).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(codeOf(error)).toBe('IMAGE_SAFETY_BLOCKED');
      expect(prisma.userAvatar.create).not.toHaveBeenCalled();
      expect(credits.debitForAvatar).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
      expect(heygen.createPhotoAvatar).not.toHaveBeenCalled();
      expect(mediaCheck.uploads.deleteStoredObject).toHaveBeenCalledWith('public', KEY);
    });

    it('leitor fora do ar: 503 e nada é criado nem enviado', async () => {
      const mediaCheck = buildMediaCheck({
        scans: { [CONTENT(KEY)]: new SafetyProviderUnavailableError('rekognition', 'timeout') },
      });
      const { service, prisma, queue } = build(mediaCheck);
      const error = await service
        .create(USER, { name: 'Minha', sourceMediaKey: KEY })
        .catch((caught: unknown) => caught);
      expect((error as BusinessException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(prisma.userAvatar.create).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('adulta: a HeyGen recebe a CÓPIA checada (chave nova) e o envio original sai do ar', async () => {
      const mediaCheck = buildMediaCheck({ scans: { [CONTENT(KEY)]: READINGS.adult } });
      const { service, created, queue } = build(mediaCheck);
      await service.create(USER, { name: 'Minha', sourceMediaKey: KEY });
      expect(mediaCheck.uploads.uploadBuffer).toHaveBeenCalledWith(
        Buffer.from(CONTENT(KEY)),
        'avatar_source',
        'foto.jpg',
        'image/jpeg',
      );
      expect(created[0]).toMatchObject({
        sourceVideoKey: 'avatar_source/copia/foto.jpg',
        sourceVideoUrl: 'https://cdn.test/avatar_source/copia/foto.jpg',
      });
      expect(mediaCheck.uploads.deleteStoredObject).toHaveBeenCalledWith('public', KEY);
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it('digital twin: o vídeo passa pelos quadros (prazo de vídeo) antes de ir à HeyGen', async () => {
      const mediaCheck = buildMediaCheck({ scans: { [CONTENT(VIDEO_KEY)]: READINGS.child } });
      const { service, queue } = build(mediaCheck);
      const error = await service
        .create(USER, { name: 'Gêmea', type: 'digital_twin', sourceMediaKey: VIDEO_KEY })
        .catch((caught: unknown) => caught);
      expect(codeOf(error)).toBe('IMAGE_SAFETY_BLOCKED');
      expect(mediaCheck.media.sampleVideoFrames).toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('arquivo enviado que não existe: 400 claro (não é falha da checagem)', async () => {
      const mediaCheck = buildMediaCheck();
      mediaCheck.uploads.readStoredObject.mockRejectedValueOnce(new StorageReadError('not_found', 'public'));
      const { service, prisma } = build(mediaCheck);
      const error = await service
        .create(USER, { name: 'Minha', sourceMediaKey: KEY })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(prisma.userAvatar.create).not.toHaveBeenCalled();
    });
  });

  describe('vídeo com imagem de fundo', () => {
    const DTO = {
      script: 'Oi, tudo bem?',
      resolution: '720p' as const,
      aspectRatio: '9:16' as const,
    };

    it('checagem desligada: o fundo segue como veio', async () => {
      const { service, prisma } = build();
      await service.generateVideo(USER, 'avatar-1', { ...DTO, backgroundImageUrl: 'https://fora.test/fundo.jpg' });
      expect(prisma.generation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            parameters: expect.objectContaining({ backgroundImageUrl: 'https://fora.test/fundo.jpg' }),
          }),
        }),
      );
    });

    it('checagem ligada e fundo fora do nosso storage: 400 e nenhuma geração', async () => {
      const { service, prisma } = build(buildMediaCheck());
      const error = await service
        .generateVideo(USER, 'avatar-1', { ...DTO, backgroundImageUrl: 'https://fora.test/fundo.jpg' })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(prisma.generation.create).not.toHaveBeenCalled();
    });

    it('fundo com criança: 422, sem geração e sem débito', async () => {
      const key = 'generations/g0/pub/fundo.png';
      const mediaCheck = buildMediaCheck({ scans: { [CONTENT(key)]: READINGS.child } });
      const { service, prisma, credits, queue } = build(mediaCheck);
      const error = await service
        .generateVideo(USER, 'avatar-1', { ...DTO, backgroundImageUrl: `https://cdn.test/${key}` })
        .catch((caught: unknown) => caught);
      expect(codeOf(error)).toBe('IMAGE_SAFETY_BLOCKED');
      expect(prisma.generation.create).not.toHaveBeenCalled();
      expect(credits.debit).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('fundo adulto da galeria: vai a cópia checada e o item da galeria NÃO é apagado', async () => {
      const key = 'generations/g0/pub/fundo.png';
      const mediaCheck = buildMediaCheck({ scans: { [CONTENT(key)]: READINGS.adult } });
      const { service, prisma } = build(mediaCheck);
      await service.generateVideo(USER, 'avatar-1', { ...DTO, backgroundImageUrl: `https://cdn.test/${key}` });
      expect(prisma.generation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            parameters: expect.objectContaining({
              backgroundImageUrl: 'https://cdn.test/avatar_background/copia/fundo.png',
            }),
          }),
        }),
      );
      expect(mediaCheck.uploads.deleteStoredObject).not.toHaveBeenCalled();
    });
  });
});
