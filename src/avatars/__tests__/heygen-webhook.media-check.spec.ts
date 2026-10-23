import { Logger } from '@nestjs/common';
import { ContentSafetyEventKind, GenerationStatus } from '@prisma/client';
import {
  NUDITY,
  READINGS,
  buildMediaCheck,
  face,
  reading,
} from '../../content-safety/image-safety/__tests__/external-media-check.harness';
import { SafetyProviderUnavailableError } from '../../content-safety/image-safety/types';
import { GenerationFailureCode } from '../../generations/errors/failure-reason';
import {
  HeyGenScreeningInProgressError,
  HeyGenWebhookService,
} from '../webhooks/heygen-webhook.service';

/**
 * Vídeo pronto da HeyGen: com a checagem ligada, passa pela quarentena e pela régua por quadros (checkOutput DE
 * VERDADE, leitor simulado) antes de publicar. Nenhuma imagem: o "vídeo" são bytes de texto e o quadro é o mesmo texto.
 */

const GEN = 'gen-1';
const USER = 'user-1';
const STAGED_KEY = `generations/${GEN}/q/output.mp4`;
const FRAME = `bytes:${STAGED_KEY}`;

const EVENT = {
  event_type: 'avatar_video.success',
  event_data: {
    video_id: 'v1',
    video_url: 'https://heygen.test/v1.mp4',
    thumbnail_url: 'https://heygen.test/t.jpg',
    duration: 10,
  },
};

function generationRow(status: GenerationStatus = GenerationStatus.PROCESSING) {
  return {
    id: GEN,
    userId: USER,
    status,
    type: 'AVATAR_VIDEO',
    modelUsed: 'heygen-avatar_iv',
    prompt: 'Oi, tudo bem?',
    negativePrompt: null,
    parameters: { resolution: '720p' },
    safetyCheckedAt: null,
    updatedAt: new Date('2026-10-22T10:00:00Z'),
    processingStartedAt: new Date(Date.now() - 60_000),
    creditsConsumed: 100,
    heygenVideoId: 'v1',
  };
}

function build(options: Parameters<typeof buildMediaCheck>[0] = {}) {
  const mediaCheck = buildMediaCheck({ generation: generationRow(), ...options });
  const prisma = Object.assign(mediaCheck.prisma, {
    webhookLog: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: 'log-1' })),
      update: jest.fn(async () => ({})),
    },
    generationOutput: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma)),
  });
  Object.assign(prisma.generation, { update: jest.fn(async () => ({})) });
  const credits = {
    refund: jest.fn(async () => undefined),
    adjustGenerationCost: jest.fn(async () => undefined),
    refundForAvatar: jest.fn(async () => undefined),
  };
  const heygen = { getVideoStatus: jest.fn(), getAvatarGroup: jest.fn() };
  const events = { emit: jest.fn() };
  const service = new HeyGenWebhookService(
    prisma as never,
    credits as never,
    mediaCheck.uploads as never,
    heygen as never,
    {} as never,
    events as never,
    mediaCheck.imageSafety,
  );
  const fetchMock = jest
    .spyOn(global, 'fetch')
    .mockImplementation(
      async () =>
        new Response(Buffer.from('video-da-heygen'), {
          status: 200,
          headers: { 'content-type': 'video/mp4' },
        }),
    );
  return { service, prisma, credits, mediaCheck, fetchMock };
}

describe('HeyGenWebhookService: vídeo checado antes de publicar', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('checagem desligada: publica direto como hoje (uploadFromUrl), sem baixar nem checar', async () => {
    const { service, prisma, mediaCheck, fetchMock } = build({ mode: 'off' });
    await service.handle(EVENT, EVENT);
    expect(mediaCheck.uploads.uploadFromUrl).toHaveBeenCalledWith(
      'https://heygen.test/v1.mp4',
      `generations/${GEN}`,
      'output.mp4',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mediaCheck.scanner.detect).not.toHaveBeenCalled();
    expect(prisma.generationOutput.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ url: `https://cdn.test/generations/${GEN}/direto/output.mp4` }),
      }),
    );
  });

  it('vídeo de adulta: grava na quarentena, checa os quadros e publica a cópia promovida', async () => {
    const { service, prisma, mediaCheck } = build({ scans: { [FRAME]: READINGS.adult } });
    await service.handle(EVENT, EVENT);
    expect(mediaCheck.uploads.uploadBuffer).toHaveBeenCalledWith(
      Buffer.from('video-da-heygen'),
      `generations/${GEN}`,
      'output.mp4',
      'video/mp4',
    );
    // o vídeo não vai ao público pelo caminho direto; só a miniatura, depois da aprovação
    expect(mediaCheck.uploads.uploadFromUrl).not.toHaveBeenCalledWith(
      'https://heygen.test/v1.mp4',
      expect.anything(),
      expect.anything(),
    );
    expect(mediaCheck.media.sampleVideoFrames).toHaveBeenCalled();
    expect(prisma.generationOutput.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ url: `https://cdn.test/generations/${GEN}/pub/output.mp4` }),
      }),
    );
    // trava antes de baixar e conclusão só com a geração ainda aberta
    expect(prisma.generation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: [{ safetyCheckedAt: null }, expect.anything()] }),
        data: { safetyCheckedAt: expect.any(Date) },
      }),
    );
    expect(prisma.generation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: GEN,
          status: { in: [GenerationStatus.PENDING, GenerationStatus.PROCESSING] },
        },
        data: expect.objectContaining({ status: GenerationStatus.COMPLETED }),
      }),
    );
  });

  it('webhook repetido enquanto o 1º ainda checa (reenvio por demora): o 2º não baixa, não publica, não ajusta crédito e responde 503 sem marcar processado', async () => {
    const { service, prisma, credits, mediaCheck, fetchMock } = build({ scans: { [FRAME]: READINGS.adult } });
    // a trava (safetyCheckedAt) já é do 1º webhook
    prisma.generation.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.handle(EVENT, EVENT)).rejects.toBeInstanceOf(
      HeyGenScreeningInProgressError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mediaCheck.uploads.uploadBuffer).not.toHaveBeenCalled();
    expect(prisma.generationOutput.create).not.toHaveBeenCalled();
    expect(credits.adjustGenerationCost).not.toHaveBeenCalled();
    expect(prisma.webhookLog.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { processed: true } }),
    );
  });

  it('1º segura a trava, o 2º pula, o 1º falha no download: um 3º evento igual passa pela dedupe, baixa e conclui', async () => {
    const { service, prisma, fetchMock } = build({ scans: { [FRAME]: READINGS.adult } });
    // registro de webhooks com estado, para a dedupe de entrada valer de verdade
    const logs: Array<{
      id: string;
      eventType: string;
      externalId: string;
      processed: boolean;
    }> = [];
    Object.assign(prisma.webhookLog, {
      findFirst: jest.fn(
        async (args: { where: { eventType: string; externalId: string; processed: boolean } }) =>
          logs.find(
            (row) =>
              row.eventType === args.where.eventType &&
              row.externalId === args.where.externalId &&
              row.processed === args.where.processed,
          ) ?? null,
      ),
      create: jest.fn(async (args: { data: { eventType: string; externalId: string } }) => {
        const row = { id: `log-${logs.length + 1}`, processed: false, ...args.data };
        logs.push(row);
        return row;
      }),
      update: jest.fn(
        async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = logs.find((item) => item.id === args.where.id);
          if (row) Object.assign(row, args.data);
          return row;
        },
      ),
    });
    // 2º webhook: a trava é do 1º
    prisma.generation.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.handle(EVENT, EVENT)).rejects.toBeInstanceOf(
      HeyGenScreeningInProgressError,
    );
    // 1º webhook: o download estoura e a trava é solta
    fetchMock.mockImplementationOnce(async () => new Response('erro', { status: 502 }));
    await expect(service.handle(EVENT, EVENT)).rejects.toThrow('HTTP 502');
    expect(logs.some((row) => row.processed)).toBe(false);
    // 3º webhook (reenvio da HeyGen): não cai na dedupe, baixa, checa e conclui
    await service.handle(EVENT, EVENT);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(prisma.generationOutput.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ url: `https://cdn.test/generations/${GEN}/pub/output.mp4` }),
      }),
    );
    expect(logs.filter((row) => row.processed)).toHaveLength(1);
  });

  it('o cron de presas encerrou durante a checagem: nada concluído, cópia publicada apagada e crédito sem ajuste', async () => {
    const { service, prisma, credits, mediaCheck } = build({ scans: { [FRAME]: READINGS.adult } });
    prisma.generation.updateMany.mockImplementation(async (args?: unknown) => {
      const data = (args as { data: Record<string, unknown> }).data;
      // a trava passa; a conclusão já não acha a geração aberta (FAILED com estorno)
      return { count: data.status === GenerationStatus.COMPLETED ? 0 : 1 };
    });
    await service.handle(EVENT, EVENT);
    expect(prisma.generationOutput.create).not.toHaveBeenCalled();
    expect(credits.adjustGenerationCost).not.toHaveBeenCalled();
    expect(mediaCheck.uploads.deleteStoredObject).toHaveBeenCalledWith(
      'public',
      `generations/${GEN}/pub/output.mp4`,
    );
    // a miniatura copiada também sai
    expect(mediaCheck.uploads.deleteStoredObject).toHaveBeenCalledWith(
      'public',
      `generations/${GEN}/direto/thumb.jpg`,
    );
  });

  it('download que falha: a trava é solta para o reenvio da HeyGen refazer', async () => {
    const { service, prisma, fetchMock } = build({ scans: { [FRAME]: READINGS.adult } });
    fetchMock.mockImplementation(async () => new Response('erro', { status: 502 }));
    await expect(service.handle(EVENT, EVENT)).rejects.toThrow('HTTP 502');
    const claim = (
      prisma.generation.updateMany.mock.calls[0][0] as { data: { safetyCheckedAt: Date } }
    ).data.safetyCheckedAt;
    expect(prisma.generation.updateMany).toHaveBeenCalledWith({
      where: {
        id: GEN,
        safetyCheckedAt: claim,
        status: { in: [GenerationStatus.PENDING, GenerationStatus.PROCESSING] },
      },
      data: { safetyCheckedAt: null },
    });
    expect(prisma.generationOutput.create).not.toHaveBeenCalled();
  });

  it('checagem desligada e geração já encerrada no meio da cópia: não conclui e apaga a cópia direta', async () => {
    const { service, prisma, credits, mediaCheck } = build({ mode: 'off' });
    prisma.generation.updateMany.mockResolvedValue({ count: 0 });
    await service.handle(EVENT, EVENT);
    expect(prisma.generationOutput.create).not.toHaveBeenCalled();
    expect(credits.adjustGenerationCost).not.toHaveBeenCalled();
    expect(mediaCheck.uploads.deleteStoredObject).toHaveBeenCalledWith(
      'public',
      `generations/${GEN}/direto/output.mp4`,
    );
  });

  it('quadro com nudez e criança: nada é publicado, evidência guardada, falha genérica com estorno', async () => {
    const { service, prisma, credits, mediaCheck } = build({
      scans: { [FRAME]: reading({ faces: [face(5, 9)], moderation: NUDITY }) },
    });
    await service.handle(EVENT, EVENT);
    expect(prisma.generationOutput.create).not.toHaveBeenCalled();
    expect(mediaCheck.uploads.copyQuarantineToPublic).not.toHaveBeenCalled();
    expect(mediaCheck.uploads.moveToEvidence).toHaveBeenCalledWith(
      'quarantine',
      STAGED_KEY,
      expect.anything(),
      expect.anything(),
    );
    expect(mediaCheck.contentSafety.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: ContentSafetyEventKind.OUTPUT_MINOR_BLOCKED, generationId: GEN }),
    );
    expect(prisma.generation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: GenerationStatus.FAILED,
          errorCode: GenerationFailureCode.IMAGE_SAFETY_BLOCKED,
        }),
      }),
    );
    expect(credits.refund).toHaveBeenCalledWith(USER, 100, GEN);
  });

  it('quadro com criança sem nudez: fica na quarentena (IN_REVIEW), nada publicado e nada estornado ainda', async () => {
    const { service, prisma, credits, mediaCheck } = build({ scans: { [FRAME]: READINGS.child } });
    await service.handle(EVENT, EVENT);
    expect(prisma.generationOutput.create).not.toHaveBeenCalled();
    expect(mediaCheck.uploads.copyQuarantineToPublic).not.toHaveBeenCalled();
    expect(prisma.generation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: GenerationStatus.IN_REVIEW }) }),
    );
    expect(mediaCheck.contentSafety.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: ContentSafetyEventKind.OUTPUT_HELD }),
    );
    expect(credits.refund).not.toHaveBeenCalled();
  });

  it('leitor fora do ar: o vídeo espera na quarentena (nunca publicado sem checagem)', async () => {
    const { service, prisma, mediaCheck } = build({
      scans: { [FRAME]: new SafetyProviderUnavailableError('rekognition', 'timeout') },
    });
    await service.handle(EVENT, EVENT);
    expect(prisma.generationOutput.create).not.toHaveBeenCalled();
    expect(mediaCheck.uploads.copyQuarantineToPublic).not.toHaveBeenCalled();
    expect(prisma.generation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: GenerationStatus.IN_REVIEW }) }),
    );
  });

  it('webhook repetido de geração segurada: ignorado (só o cron da quarentena ou o revisor concluem)', async () => {
    const { service, fetchMock, mediaCheck } = build({
      generation: generationRow(GenerationStatus.IN_REVIEW),
    });
    await service.handle(EVENT, EVENT);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mediaCheck.uploads.uploadFromUrl).not.toHaveBeenCalled();
  });
});
