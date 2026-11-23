import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ADULT_ENHANCER_SYSTEM_PROMPT,
  adultEnhancerMessage,
  composeEnhanced,
  deterministicEnhancement,
  ENHANCEMENT_SCHEMA,
  FIRST_FRAME_VIDEO_ANCHOR,
  isFirstFrameVideo,
  looksLikeEdit,
  parseEnhancement,
} from '../adult-enhancer.policy';
import { AdultPromptEnhancerService, type EnhancerClient } from '../adult-prompt-enhancer.service';

function config(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const ENABLED = { OPENROUTER_API_KEY: 'sk-or-teste' };
const IMAGE = { type: 'image' as const, model: 'sem-censura', hasReferenceImages: true, referenceCount: 1, locale: 'pt-BR' };
const GOOD = JSON.stringify({
  prompt: 'Same person as in the reference image. Adult woman, 27 years old, lying on the bed in black lace lingerie, looking at the camera. Real skin texture with visible pores, soft window light from the left.',
  avoid: 'different face from the reference, deformed hands, extra fingers, plastic skin, anime, text, watermark',
  note: 'Travei a identidade na foto, escrevi a idade adulta e o bloco de realismo.',
});

describe('política do melhorador 18+', () => {
  it('parseEnhancement lê o contrato e recusa o que está fora dele', () => {
    expect(parseEnhancement(GOOD)).toMatchObject({ note: expect.stringContaining('identidade') });
    expect(parseEnhancement('{"prompt":"x"}')).toEqual({ prompt: 'x', avoid: '', note: '' });
    expect(parseEnhancement('{"prompt":"   "}')).toBeNull();
    expect(parseEnhancement('I cannot help with that')).toBeNull();
    expect(parseEnhancement('')).toBeNull();
  });

  it('piso de idade 18 (regra do dono, 13/11): a casa escreve 20+ por padrão e mantém a idade adulta da cliente', () => {
    expect(ADULT_ENHANCER_SYSTEM_PROMPT).toContain('18 or older ("adult woman');
    expect(ADULT_ENHANCER_SYSTEM_PROMPT).toContain('adult age (18 or older), keep it exactly');
    expect(ADULT_ENHANCER_SYSTEM_PROMPT).not.toMatch(/25 or older/);
    for (const age of ['19', '22']) {
      const text = deterministicEnhancement(`mulher de ${age} anos de lingerie na cama`, IMAGE).prompt;
      expect(text).toContain(`mulher de ${age} anos`);
      expect(text).not.toContain('27 years old');
    }
  });

  it('composeEnhanced anexa a lista "evitar" no fim, uma vez só', () => {
    expect(composeEnhanced({ prompt: 'cena', avoid: 'Avoid: blur, text', note: '' })).toBe('cena\n\nAvoid: blur, text');
    expect(composeEnhanced({ prompt: 'cena', avoid: '', note: '' })).toBe('cena');
  });

  it('bloco fixo: escreve a idade adulta quando falta, mantém a idade da cliente, trava a referência e lista o que evitar', () => {
    const noAge = composeEnhanced(deterministicEnhancement('ela de lingerie na cama', IMAGE));
    expect(noAge).toContain('Adult woman, 27 years old. ela de lingerie na cama');
    expect(noAge).toContain('Same person as in the reference image');
    expect(noAge).toContain('Do not change the face or the body proportions from the reference.');
    expect(noAge).toMatch(/Avoid: different face from the reference/);

    const withAge = composeEnhanced(deterministicEnhancement('mulher de 32 anos na praia', { type: 'image' }));
    expect(withAge).not.toContain('27 years old');
    expect(withAge).toContain('mulher de 32 anos na praia');
    expect(withAge).not.toContain('reference');

    const video = composeEnhanced(deterministicEnhancement('she walks to the camera', { type: 'video', hasReferenceImages: true, referenceCount: 2 }));
    expect(video).toContain('Image 1 is the identity reference');
    expect(video).toContain('morphing face');
  });

  it('cabeçalho do pedido leva tipo, modelo, referências e idioma; looksLikeEdit só para pedido curto de mudança', () => {
    const message = adultEnhancerMessage('  cena  ', { ...IMAGE, aspectRatio: '3:4' });
    expect(message).toMatch(/^\[type: image\] \[model: sem-censura\] \[reference images: 1\] \[aspect ratio: 3:4\] \[interface language: pt-BR\]/);
    expect(message).toContain('<<<\ncena\n>>>');
    expect(looksLikeEdit('muda a cor do top para vermelho')).toBe(true);
    expect(looksLikeEdit('ela deitada na cama de lingerie preta olhando para a câmera')).toBe(false);
    expect(ENHANCEMENT_SCHEMA.required).toEqual(['prompt', 'avoid', 'note']);
  });
});

describe('vídeo que parte de uma foto (estudo de 19–20/11)', () => {
  it('1 referência no vídeo = 1º quadro; 2+ referências = vídeo por referência; o campo explícito manda', () => {
    expect(isFirstFrameVideo({ type: 'video', hasReferenceImages: true, referenceCount: 1 })).toBe(true);
    expect(isFirstFrameVideo({ type: 'video', hasReferenceImages: true, referenceCount: 2 })).toBe(false);
    expect(isFirstFrameVideo({ type: 'video', hasReferenceImages: true, hasFirstFrame: false })).toBe(false);
    expect(isFirstFrameVideo({ type: 'video', hasFirstFrame: true })).toBe(true);
    expect(isFirstFrameVideo({ type: 'image', hasReferenceImages: true, hasFirstFrame: true })).toBe(false);
  });

  it('bloco fixo do 1º quadro: âncora de identidade + pedido intacto + movimento; sem redescrever idade, corpo ou cenário', () => {
    const text = composeEnhanced(deterministicEnhancement('ela tira a alça devagar', { type: 'video', hasReferenceImages: true, referenceCount: 1 }));
    expect(text.startsWith(FIRST_FRAME_VIDEO_ANCHOR)).toBe(true);
    expect(text).toContain('ela tira a alça devagar');
    expect(text).toContain('steady camera');
    expect(text).toMatch(/Avoid: different face from the first frame/);
    expect(text).not.toContain('27 years old');
    expect(text).not.toContain('Image 1 is the identity reference');
    expect(text).not.toMatch(/(?:photorealistic|cinematic|perfect|flawless)/i);
  });

  it('cabeçalho marca o 1º quadro e a política tem a regra por motor (H3 sem colchete de câmera)', () => {
    expect(adultEnhancerMessage('x', { type: 'video', model: 'wavespeed-ltx-spicy', hasReferenceImages: true })).toContain('[first frame: yes]');
    expect(ADULT_ENHANCER_SYSTEM_PROMPT).toContain('Write ONLY what changes over time');
    expect(ADULT_ENHANCER_SYSTEM_PROMPT).toContain('not H3: do not use them');
  });
});

describe('AdultPromptEnhancerService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const client = (complete: jest.Mock) => ({ complete }) as unknown as EnhancerClient;

  it('sem chave do OpenRouter: desligado, e o enhance devolve o bloco fixo sem chamar o modelo', async () => {
    const complete = jest.fn();
    const service = new AdultPromptEnhancerService(config({ ANTHROPIC_API_KEY: 'sk-ant-nao-serve-aqui' }), client(complete));
    expect(service.enabled()).toBe(false);
    const result = await service.enhance('ela na praia', IMAGE);
    expect(result.source).toBe('fallback');
    expect(result.enhancedPrompt).toContain('Adult woman, 27 years old. ela na praia');
    expect(complete).not.toHaveBeenCalled();
  });

  it('modelo responde no contrato: prompt + "Avoid:" + nota; chamada ao Grok 4.3 pelo OpenRouter com a política e o cabeçalho', async () => {
    const complete = jest.fn().mockResolvedValue(GOOD);
    const service = new AdultPromptEnhancerService(config(ENABLED), client(complete));

    const result = await service.enhance('ela de lingerie na cama', IMAGE);

    expect(result.source).toBe('model');
    expect(result.enhancedPrompt).toMatch(/^Same person as in the reference image\. Adult woman, 27 years old/);
    expect(result.enhancedPrompt).toMatch(/\n\nAvoid: different face from the reference/);
    expect(result.note).toContain('identidade');
    expect(result.negativePrompt).toBe('');
    const [params] = complete.mock.calls[0];
    expect(params.model).toBe('x-ai/grok-4.3');
    expect(params.maxTokens).toBe(2400);
    expect(params.timeoutMs).toBe(60000);
    expect(params.system).toContain('adults-only (18+)');
    expect(params.user).toContain('[type: image] [model: sem-censura] [reference images: 1]');
  });

  it('recusa, erro de rede, resposta fora do contrato ou pedido devolvido intacto: bloco fixo, nunca erro', async () => {
    const cases: Array<() => Promise<unknown>> = [
      () => Promise.resolve(''),
      () => Promise.reject(new Error('timeout')),
      () => Promise.resolve('Sorry, I cannot help with that request.'),
      () => Promise.resolve(JSON.stringify({ prompt: 'ela na praia', avoid: '', note: '' })),
    ];
    for (const fail of cases) {
      const service = new AdultPromptEnhancerService(config(ENABLED), client(jest.fn(fail)));
      const result = await service.enhance('ela na praia', IMAGE);
      expect(result.source).toBe('fallback');
      expect(result.enhancedPrompt).toContain('ela na praia');
      expect(result.note).toBe('');
    }
  });

  it('o primeiro modelo falha e o segundo da lista responde: vale o segundo', async () => {
    const complete = jest.fn().mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValueOnce(GOOD);
    const service = new AdultPromptEnhancerService(config({ ...ENABLED, OPENROUTER_ENHANCER_MODELS: 'x-ai/grok-4.3, qwen/qwen3-235b-a22b' }), client(complete));
    const result = await service.enhance('ela de lingerie na cama', IMAGE);
    expect(result.source).toBe('model');
    expect(complete.mock.calls.map((call) => call[0].model)).toEqual(['x-ai/grok-4.3', 'qwen/qwen3-235b-a22b']);
  });

  it('texto do modelo que a trava de termos barraria nunca volta: cai no bloco fixo', async () => {
    const bad = JSON.stringify({ prompt: 'Adult woman, 27 years old, dressed as a schoolgirl in the classroom, lingerie', avoid: 'blur', note: 'x' });
    const service = new AdultPromptEnhancerService(config(ENABLED), client(jest.fn().mockResolvedValue(bad)));
    const result = await service.enhance('ela de lingerie', IMAGE);
    expect(result.source).toBe('fallback');
    expect(result.enhancedPrompt).not.toMatch(/schoolgirl|classroom/);
    expect(result.enhancedPrompt).toContain('ela de lingerie');
  });

  it('modelos e tempo vêm da configuração; prompt vazio é erro do chamador', async () => {
    const complete = jest.fn().mockResolvedValue(GOOD);
    const service = new AdultPromptEnhancerService(config({ ...ENABLED, OPENROUTER_ENHANCER_MODELS: ' x-ai/grok-4.3-fast ', PROMPT_ENHANCER_TIMEOUT_MS: '30000' }), client(complete));
    await service.enhance('cena', { type: 'video' });
    expect(complete.mock.calls[0][0]).toMatchObject({ model: 'x-ai/grok-4.3-fast', timeoutMs: 30000 });
    await expect(service.enhance('   ', { type: 'image' })).rejects.toThrow('prompt vazio');
  });
});

describe('deterministicEnhancement · homem, casal e 60+ (23/11)', () => {
  it('idade de 60+ escrita conta como idade adulta: sem o prefixo de mulher de 27', () => {
    const text = deterministicEnhancement('homem de barba, 62 anos, na academia', IMAGE).prompt;
    expect(text).toContain('62 anos');
    expect(text).not.toContain('Adult woman, 27 years old');
  });
  it('pedido de homem ou casal sem idade leva só a âncora de adulto', () => {
    const text = deterministicEnhancement('casal na cama, luz de abajur', IMAGE).prompt;
    expect(text).toContain('Every person shown is an adult (18 or older).');
    expect(text).not.toContain('Adult woman, 27 years old');
  });
  it('idade abaixo de 18 nunca conta como idade adulta', () => {
    expect(deterministicEnhancement('ela, 15 anos', IMAGE).prompt).toContain('Adult woman, 27 years old.');
  });
});
