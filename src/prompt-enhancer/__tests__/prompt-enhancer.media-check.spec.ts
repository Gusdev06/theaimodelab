import { HttpStatus, Logger } from '@nestjs/common';
import { BusinessException } from '../../common/exceptions/business.exception';
import {
  READINGS,
  buildMediaCheck,
  photoBase64,
} from '../../content-safety/image-safety/__tests__/external-media-check.harness';
import { SafetyProviderUnavailableError } from '../../content-safety/image-safety/types';
import type { EnhanceInfluencerDto } from '../dto/enhance-influencer.dto';
import { PromptEnhancerService } from '../prompt-enhancer.service';

/**
 * Construtor de influencer com foto de referência e Turbinar com imagens: a foto passa pela checagem ANTES do modelo
 * de visão. Leitor simulado (rostos e rótulos inventados), nenhuma imagem; o cliente de visão é simulado.
 */

const SELECTIONS = {
  characterType: 'human',
  gender: 'female',
  ethnicity: 'latina',
  skinColor: 'tan',
  eyeColor: 'brown',
  age: '25',
} as EnhanceInfluencerDto;

function build(options: { mediaCheck?: ReturnType<typeof buildMediaCheck> } = {}) {
  const chat = {
    chat: jest.fn(async () => ({
      text: JSON.stringify({ prompt: 'retrato', negativePrompt: '' }),
      finishReason: 'STOP',
    })),
  };
  const mediaCheck = options.mediaCheck ?? buildMediaCheck({ mode: 'off' });
  const service = new PromptEnhancerService(chat as never, mediaCheck.check);
  // a compressão real usa o sharp: aqui devolve os bytes simulados como vieram
  jest
    .spyOn(
      service as unknown as {
        compressImageForVision: (base64: string) => Promise<{ base64: string; mime_type: string }>;
      },
      'compressImageForVision',
    )
    .mockImplementation(async (base64: string) => ({ base64, mime_type: 'image/jpeg' }));
  return { service, chat, mediaCheck };
}

async function rejection(promise: Promise<unknown>): Promise<BusinessException> {
  const error = await promise.then(
    () => {
      throw new Error('devia ter recusado');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(BusinessException);
  return error as BusinessException;
}

const codeOf = (error: BusinessException) => (error.getResponse() as { code: string }).code;

describe('PromptEnhancerService: foto checada antes do modelo de visão', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('enhance-influencer com referenceImageBase64', () => {
    it('checagem desligada: segue como hoje, sem leitor', async () => {
      const { service, chat, mediaCheck } = build();
      await service.enhanceInfluencer(
        { ...SELECTIONS, referenceImageBase64: photoBase64('crianca') },
        'user-1',
      );
      expect(chat.chat).toHaveBeenCalledTimes(1);
      expect(mediaCheck.scanner.detect).not.toHaveBeenCalled();
    });

    it('leitor acusa criança: 422 e o Gemini nunca é chamado', async () => {
      const mediaCheck = buildMediaCheck({ scans: { crianca: READINGS.child } });
      const { service, chat } = build({ mediaCheck });
      const error = await rejection(
        service.enhanceInfluencer({ ...SELECTIONS, referenceImageBase64: photoBase64('crianca') }, 'user-1'),
      );
      expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(codeOf(error)).toBe('IMAGE_SAFETY_BLOCKED');
      expect(chat.chat).not.toHaveBeenCalled();
      expect(mediaCheck.stored[0]).toMatchObject({ userId: 'user-1', generationId: null });
    });

    it('leitor fora do ar: 503 e o Gemini nunca é chamado', async () => {
      const mediaCheck = buildMediaCheck({
        scans: { foto: new SafetyProviderUnavailableError('rekognition', 'throttled') },
      });
      const { service, chat } = build({ mediaCheck });
      const error = await rejection(
        service.enhanceInfluencer({ ...SELECTIONS, referenceImageBase64: photoBase64('foto') }, 'user-1'),
      );
      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(chat.chat).not.toHaveBeenCalled();
    });

    it('sem foto de referência: não chama o leitor', async () => {
      const mediaCheck = buildMediaCheck();
      const { service, chat } = build({ mediaCheck });
      await service.enhanceInfluencer(SELECTIONS, 'user-1');
      expect(mediaCheck.scanner.detect).not.toHaveBeenCalled();
      expect(chat.chat).toHaveBeenCalledTimes(1);
    });

    it('adulta: segue para o modelo de visão', async () => {
      const mediaCheck = buildMediaCheck({ scans: { adulta: READINGS.adult } });
      const { service, chat } = build({ mediaCheck });
      await service.enhanceInfluencer({ ...SELECTIONS, referenceImageBase64: photoBase64('adulta') }, 'user-1');
      expect(mediaCheck.scanner.detect).toHaveBeenCalledTimes(1);
      expect(chat.chat).toHaveBeenCalledTimes(1);
    });
  });

  describe('enhance (Turbinar) com imagens', () => {
    it('uma das imagens com criança: 422 e o Gemini nunca é chamado', async () => {
      const mediaCheck = buildMediaCheck({ scans: { adulta: READINGS.adult, crianca: READINGS.child } });
      const { service, chat } = build({ mediaCheck });
      const error = await rejection(
        service.enhance(
          'foto dela na praia',
          { type: 'image', model: 'nano-banana-2' },
          [
            { base64: photoBase64('adulta'), mime_type: 'image/png' },
            { base64: photoBase64('crianca'), mime_type: 'image/png' },
          ],
          'user-1',
        ),
      );
      expect(codeOf(error)).toBe('IMAGE_SAFETY_BLOCKED');
      expect(chat.chat).not.toHaveBeenCalled();
    });

    it('sem imagens (agente, Turbinar de texto): nenhuma checagem de imagem', async () => {
      const mediaCheck = buildMediaCheck();
      const { service, chat } = build({ mediaCheck });
      await service.enhance('um prompt');
      expect(mediaCheck.scanner.detect).not.toHaveBeenCalled();
      expect(chat.chat).toHaveBeenCalledTimes(1);
    });
  });
});
