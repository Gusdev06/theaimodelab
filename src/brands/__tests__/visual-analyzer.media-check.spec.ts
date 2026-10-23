import { HttpStatus, Logger } from '@nestjs/common';
import { BusinessException } from '../../common/exceptions/business.exception';
import {
  READINGS,
  buildMediaCheck,
  photoBase64,
} from '../../content-safety/image-safety/__tests__/external-media-check.harness';
import { SafetyProviderUnavailableError } from '../../content-safety/image-safety/types';
import { VisualAnalyzerService } from '../visual-analyzer.service';

/** Análise de marca: as imagens passam pela checagem antes do modelo de visão (leitor e cliente simulados). */

const ANALYSIS = {
  brand_identity: {
    palette: ['#000000'],
    visual_style: 'minimalista',
    tone: 'sério',
    composition_patterns: [],
    subject_focus: 'produto',
    typography_hints: 'sem texto visível',
    mood_keywords: ['clean'],
  },
  assets: [],
};

function build(options: { mediaCheck?: ReturnType<typeof buildMediaCheck> } = {}) {
  const chat = { chat: jest.fn(async () => ({ text: JSON.stringify(ANALYSIS) })) };
  const mediaCheck = options.mediaCheck ?? buildMediaCheck({ mode: 'off' });
  const service = new VisualAnalyzerService(chat as never, mediaCheck.check);
  // download simulado: cada URL vira a "imagem" com o nome do arquivo como conteúdo
  jest
    .spyOn(service as unknown as { fetchImageBlock: (url: string) => Promise<unknown> }, 'fetchImageBlock')
    .mockImplementation(async (url: string) => ({
      inline_data: { base64: photoBase64(url.split('/').pop() ?? ''), mime_type: 'image/png' },
    }));
  return { service, chat, mediaCheck };
}

describe('VisualAnalyzerService: imagens checadas antes do modelo de visão', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('checagem desligada: analisa como hoje, sem leitor', async () => {
    const { service, chat, mediaCheck } = build();
    await expect(service.analyze(['https://x.test/logo'], 'user-1')).resolves.toMatchObject({
      brand_identity: { visual_style: 'minimalista' },
    });
    expect(chat.chat).toHaveBeenCalledTimes(1);
    expect(mediaCheck.scanner.detect).not.toHaveBeenCalled();
  });

  it('uma referência com criança: 422 e o Gemini nunca é chamado', async () => {
    const mediaCheck = buildMediaCheck({ scans: { logo: READINGS.adult, familia: READINGS.child } });
    const { service, chat } = build({ mediaCheck });
    const error = await service
      .analyze(['https://x.test/logo', 'https://x.test/familia'], 'user-1')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BusinessException);
    expect((error as BusinessException).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(chat.chat).not.toHaveBeenCalled();
    expect(mediaCheck.scanner.detect).toHaveBeenCalledTimes(2);
  });

  it('leitor fora do ar: 503 e o Gemini nunca é chamado', async () => {
    const mediaCheck = buildMediaCheck({
      scans: { logo: new SafetyProviderUnavailableError('rekognition', 'server_error') },
    });
    const { service, chat } = build({ mediaCheck });
    const error = await service.analyze(['https://x.test/logo'], 'user-1').catch((caught: unknown) => caught);
    expect((error as BusinessException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(chat.chat).not.toHaveBeenCalled();
  });
});
