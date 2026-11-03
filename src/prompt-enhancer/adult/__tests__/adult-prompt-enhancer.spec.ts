import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  adultEnhancerMessage,
  composeEnhanced,
  deterministicEnhancement,
  ENHANCEMENT_SCHEMA,
  looksLikeEdit,
  parseEnhancement,
} from '../adult-enhancer.policy';
import { AdultPromptEnhancerService, type EnhancerClient } from '../adult-prompt-enhancer.service';

function config(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function reply(text: string, stopReason = 'end_turn') {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-fable-5-1',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

const ENABLED = { ANTHROPIC_API_KEY: 'sk-ant-teste' };
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

describe('AdultPromptEnhancerService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sem chave: desligado, e o enhance devolve o bloco fixo sem chamar o modelo', async () => {
    const create = jest.fn();
    const service = new AdultPromptEnhancerService(config({}), { messages: { create } } as unknown as EnhancerClient);
    expect(service.enabled()).toBe(false);
    const result = await service.enhance('ela na praia', IMAGE);
    expect(result.source).toBe('fallback');
    expect(result.enhancedPrompt).toContain('Adult woman, 27 years old. ela na praia');
    expect(create).not.toHaveBeenCalled();
  });

  it('modelo responde no contrato: prompt + "Avoid:" + nota; chamada com política em cache, esquema, sem thinking, Fable por padrão', async () => {
    const create = jest.fn().mockResolvedValue(reply(GOOD));
    const service = new AdultPromptEnhancerService(config(ENABLED), { messages: { create } } as unknown as EnhancerClient);

    const result = await service.enhance('ela de lingerie na cama', IMAGE);

    expect(result.source).toBe('model');
    expect(result.enhancedPrompt).toMatch(/^Same person as in the reference image\. Adult woman, 27 years old/);
    expect(result.enhancedPrompt).toMatch(/\n\nAvoid: different face from the reference/);
    expect(result.note).toContain('identidade');
    expect(result.negativePrompt).toBe('');
    const [params, options] = create.mock.calls[0];
    expect(params.model).toBe('claude-fable-5-1');
    expect(params.max_tokens).toBe(2400);
    expect(params.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(params.messages[0].content).toContain('[type: image] [model: sem-censura] [reference images: 1]');
    expect(params.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema: ENHANCEMENT_SCHEMA } });
    expect(params).not.toHaveProperty('thinking');
    expect(options).toMatchObject({ timeout: 60000, maxRetries: 1 });
  });

  it('recusa, erro de rede, resposta fora do contrato ou pedido devolvido intacto: bloco fixo, nunca erro', async () => {
    const cases: Array<() => Promise<unknown>> = [
      () => Promise.resolve(reply('', 'refusal')),
      () => Promise.reject(new Error('timeout')),
      () => Promise.resolve(reply('Sorry, I cannot help with that request.')),
      () => Promise.resolve(reply(JSON.stringify({ prompt: 'ela na praia', avoid: '', note: '' }))),
    ];
    for (const fail of cases) {
      const service = new AdultPromptEnhancerService(config(ENABLED), { messages: { create: jest.fn(fail) } } as unknown as EnhancerClient);
      const result = await service.enhance('ela na praia', IMAGE);
      expect(result.source).toBe('fallback');
      expect(result.enhancedPrompt).toContain('ela na praia');
      expect(result.note).toBe('');
    }
  });

  it('texto do modelo que a trava de termos barraria nunca volta: cai no bloco fixo', async () => {
    const bad = JSON.stringify({ prompt: 'Adult woman, 27 years old, dressed as a schoolgirl in the classroom, lingerie', avoid: 'blur', note: 'x' });
    const create = jest.fn().mockResolvedValue(reply(bad));
    const service = new AdultPromptEnhancerService(config(ENABLED), { messages: { create } } as unknown as EnhancerClient);
    const result = await service.enhance('ela de lingerie', IMAGE);
    expect(result.source).toBe('fallback');
    expect(result.enhancedPrompt).not.toMatch(/schoolgirl|classroom/);
    expect(result.enhancedPrompt).toContain('ela de lingerie');
  });

  it('modelo e tempo vêm da configuração; prompt vazio é erro do chamador', async () => {
    const create = jest.fn().mockResolvedValue(reply(GOOD));
    const service = new AdultPromptEnhancerService(
      config({ ...ENABLED, PROMPT_ENHANCER_MODEL: ' claude-opus-5-5 ', PROMPT_ENHANCER_TIMEOUT_MS: '30000' }),
      { messages: { create } } as unknown as EnhancerClient,
    );
    await service.enhance('cena', { type: 'video' });
    expect(create.mock.calls[0][0].model).toBe('claude-opus-5-5');
    expect(create.mock.calls[0][1]).toMatchObject({ timeout: 30000 });
    await expect(service.enhance('   ', { type: 'image' })).rejects.toThrow('prompt vazio');
  });
});
