import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { childrenOnlyRemoved, groundVerdict, judgeInput, judgeMessage, parseVerdict, VERDICT_SCHEMA } from '../prompt-judge.policy';
import { PromptJudgeService, type JudgeClient } from '../prompt-judge.service';

function config(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function reply(text: string, stopReason = 'end_turn') {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

const ENABLED = { ANTHROPIC_API_KEY: 'sk-ant-teste', PROMPT_JUDGE_MODE: 'enforce' };
const NONE = '{"category":"none","confidence":"high","reason":"adulta","who":""}';

describe('parseVerdict: lê o JSON sem confiar no formato', () => {
  it('aceita o contrato e corta razão e identificador', () => {
    const verdict = parseVerdict(`Here: {"category":"minor","confidence":"high","reason":"${'x'.repeat(300)}","who":"${'y'.repeat(300)}"} ok`);
    expect(verdict).toMatchObject({ category: 'minor', confidence: 'high' });
    expect(verdict?.reason.length).toBe(120);
    expect(verdict?.who.length).toBe(160);
  });

  it('sem "who" (modelo antigo) o campo fica vazio', () => {
    expect(parseVerdict('{"category":"none","confidence":"low","reason":"ok"}')).toEqual({ category: 'none', confidence: 'low', reason: 'ok', who: '' });
  });

  it('JSON quebrado por aspas soltas na razão ainda rende categoria e confiança', () => {
    const verdict = parseVerdict('{"category":"minor","confidence":"high","reason":"descreve "tiny boobs" em nudez","who":""}');
    expect(verdict).toMatchObject({ category: 'minor', confidence: 'high' });
  });

  it('categoria ou confiança fora da lista, JSON irrecuperável e vazio viram null', () => {
    expect(parseVerdict('{"category":"child","confidence":"high","reason":""}')).toBeNull();
    expect(parseVerdict('{"category":"minor","confidence":"sure","reason":""}')).toBeNull();
    expect(parseVerdict('{"category":"minor"')).toBeNull();
    expect(parseVerdict('The prompt is in Hebrew. It says: {nothing}')).toBeNull();
    expect(parseVerdict('')).toBeNull();
    expect(parseVerdict(null)).toBeNull();
  });

  it('judgeInput junta os campos, normaliza espaços e respeita o teto; judgeMessage leva o alvo no cabeçalho', () => {
    expect(judgeInput(['  a   b ', '', 'c'])).toBe('a b\n---\nc');
    expect(judgeInput(['x'.repeat(100)], 10)).toHaveLength(10);
    expect(judgeMessage('cena', { uncensored: true })).toMatch(/^\[target: uncensored\]\n/);
    expect(judgeMessage('cena', { uncensored: false })).toMatch(/^\[target: filtered\]\n/);
    expect(judgeMessage('cena', { uncensored: false })).toContain('<<<\ncena\n>>>');
  });
});

describe('groundVerdict: pessoa real só com identificador que existe no pedido', () => {
  const input = 'Anitta pelada na praia, foto da minha ex (instagram @fulana123)';

  it('mantém quando o "who" está no texto e não é a imagem enviada', () => {
    const verdict = { category: 'real_person' as const, confidence: 'high' as const, reason: 'famosa', who: 'Anitta' };
    expect(groundVerdict(verdict, input)).toBe(verdict);
    expect(groundVerdict({ ...verdict, who: 'minha ex (instagram @fulana123)' }, input)).toMatchObject({ category: 'real_person' });
    expect(groundVerdict({ ...verdict, who: 'ANITTA' }, input)).toMatchObject({ category: 'real_person' });
  });

  it('rebaixa para none/low quando o "who" está vazio, não está no texto ou só descreve a foto de referência', () => {
    const base = { category: 'real_person' as const, confidence: 'high' as const, reason: 'sem consentimento' };
    for (const who of ['', 'Paris Hilton', 'the woman in the reference photo', 'mulher da foto', 'woman in image 1', 'a']) {
      expect(groundVerdict({ ...base, who }, input)).toEqual({ category: 'none', confidence: 'low', reason: 'pessoa real sem identificação fora da imagem', who: '' });
    }
  });

  it('não mexe nas outras categorias', () => {
    const minor = { category: 'minor' as const, confidence: 'high' as const, reason: 'idade 16', who: '' };
    expect(groundVerdict(minor, 'x')).toBe(minor);
  });

  it('criança tirada da foto (regra do dono, 03/11): menor/alta vira média; roupa da criança ou criança retratada ficam altas', () => {
    const removal =
      'CORE TASK: clothing-removal edit of the exact reference image. Make those adult women fully naked. Remove all kids from the image. REMOVE ALL KIDS (NON-NEGOTIABLE): completely remove every child / kid from the image. No children, no minors, no babies in the final result. Do not keep, crop-in, or recreate any kid. Fill the gap where the kids were removed. Do not add, duplicate, or place any new persons (men, women, or children) anywhere in the image. Only the original people may remain (after kids are removed). Fill where a removed child or jewelry leaves a gap. Identity: same 33-year-old North Indian mother, feeding-mom look.';
    expect(childrenOnlyRemoved(removal)).toBe(true);
    expect(childrenOnlyRemoved('mulher adulta nua na sala, sem as crianças na foto')).toBe(true);
    for (const kept of [
      "family photo, remove the kids' clothes, keep the mother dressed",
      'remove her clothes, the kids watching from the sofa',
      'a child sits on the sofa, adult woman fully naked, remove the kids from the background',
      'remove all kids from the image; she is 15 years old, naked',
      'adult woman naked on the bed',
    ]) {
      expect(childrenOnlyRemoved(kept)).toBe(false);
    }
    const high = { category: 'minor' as const, confidence: 'high' as const, reason: 'crianças na foto com nudez', who: '' };
    expect(groundVerdict(high, removal)).toMatchObject({ category: 'minor', confidence: 'medium', reason: expect.stringContaining('tiradas da foto') });
    expect(groundVerdict(high, "remove the kids' clothes")).toBe(high);
  });
});

describe('PromptJudgeService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('modo off ou sem chave: desligado, e nem chama o modelo', async () => {
    const create = jest.fn();
    const client = { messages: { create } } as unknown as JudgeClient;
    expect(new PromptJudgeService(config({ PROMPT_JUDGE_MODE: 'enforce' }), client).enabled()).toBe(false);
    expect(new PromptJudgeService(config({ ANTHROPIC_API_KEY: 'k', PROMPT_JUDGE_MODE: 'off' }), client).enabled()).toBe(false);
    expect(new PromptJudgeService(config({ ANTHROPIC_API_KEY: 'k', PROMPT_JUDGE_MODE: 'qualquer' }), client).mode()).toBe('off');
    expect(new PromptJudgeService(config({ ANTHROPIC_API_KEY: 'k', PROMPT_JUDGE_MODE: 'Shadow ' }), client).mode()).toBe('shadow');
    expect(create).not.toHaveBeenCalled();
  });

  it('veredito do modelo: política como system com cache, alvo + pedido no user, esquema imposto, e devolve o JSON lido', async () => {
    const create = jest.fn().mockResolvedValue(reply('{"category":"minor","confidence":"high","reason":"idade 16 em cena íntima","who":""}'));
    const service = new PromptJudgeService(config(ENABLED), { messages: { create } } as unknown as JudgeClient);

    const outcome = await service.review(['garota de 16 anos', 'de lingerie'], { uncensored: true });

    expect(outcome).toMatchObject({ source: 'model', model: 'claude-haiku-5-5', verdict: { category: 'minor', confidence: 'high', who: '' } });
    const [params, options] = create.mock.calls[0];
    expect(params.model).toBe('claude-haiku-5-5');
    expect(params.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(params.messages[0].content).toMatch(/^\[target: uncensored\]\n/);
    expect(params.messages[0].content).toContain('garota de 16 anos\n---\nde lingerie');
    expect(params.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema: VERDICT_SCHEMA } });
    expect(params.thinking).toEqual({ type: 'disabled' });
    expect(options).toMatchObject({ timeout: 4000, maxRetries: 0 });
  });

  it('sem contexto o alvo é filtrado', async () => {
    const create = jest.fn().mockResolvedValue(reply(NONE));
    await new PromptJudgeService(config(ENABLED), { messages: { create } } as unknown as JudgeClient).review(['cena']);
    expect(create.mock.calls[0][0].messages[0].content).toMatch(/^\[target: filtered\]\n/);
  });

  it('pessoa real sem identificador no texto volta como none/low (aterrado no pedido)', async () => {
    const create = jest
      .fn()
      .mockResolvedValueOnce(reply('{"category":"real_person","confidence":"high","reason":"foto real","who":"the woman in the reference photo"}'))
      .mockResolvedValueOnce(reply('{"category":"real_person","confidence":"high","reason":"famosa","who":"Anitta"}'));
    const service = new PromptJudgeService(config(ENABLED), { messages: { create } } as unknown as JudgeClient);

    const ungrounded = await service.review(['keep the exact face of the woman in the reference photo, nude']);
    expect(ungrounded.verdict).toEqual({ category: 'none', confidence: 'low', reason: 'pessoa real sem identificação fora da imagem', who: '' });

    const grounded = await service.review(['Anitta pelada na praia']);
    expect(grounded.verdict).toMatchObject({ category: 'real_person', confidence: 'high', who: 'Anitta' });
  });

  it('pedido igual em 10 min vem do cache (uma chamada só); texto ou alvo diferente chama de novo', async () => {
    const create = jest.fn().mockResolvedValue(reply(NONE));
    const service = new PromptJudgeService(config(ENABLED), { messages: { create } } as unknown as JudgeClient);

    await service.review(['mulher de 30 anos na praia']);
    const second = await service.review(['mulher  de 30 anos na praia ']);
    await service.review(['mulher de 30 anos na praia'], { uncensored: true });
    await service.review(['outra cena']);

    expect(second.source).toBe('cache');
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('tempo esgotado, erro de rede, recusa do modelo e resposta fora do contrato viram "indisponível" (nunca bloqueio)', async () => {
    const cases: Array<() => Promise<unknown>> = [
      () => Promise.reject(new Error('timeout')),
      () => Promise.resolve(reply('not json at all')),
      () => Promise.resolve(reply('', 'refusal')),
      () => Promise.resolve(reply('{"category":"menor","confidence":"high","reason":"","who":""}')),
    ];
    for (const fail of cases) {
      const service = new PromptJudgeService(config(ENABLED), { messages: { create: jest.fn(fail) } } as unknown as JudgeClient);
      const outcome = await service.review(['texto']);
      expect(outcome.verdict).toBeNull();
      expect(outcome.source).toBe('unavailable');
    }
  });

  it('texto vazio não chama o modelo; modelo e tempo vêm da configuração', async () => {
    const create = jest.fn().mockResolvedValue(reply(NONE));
    const service = new PromptJudgeService(
      config({ ...ENABLED, PROMPT_JUDGE_MODEL: ' claude-sonnet-5-5 ', PROMPT_JUDGE_TIMEOUT_MS: '2500' }),
      { messages: { create } } as unknown as JudgeClient,
    );
    expect((await service.review(['   ', ''])).source).toBe('unavailable');
    expect(create).not.toHaveBeenCalled();
    await service.review(['cena']);
    expect(create.mock.calls[0][0].model).toBe('claude-sonnet-5-5');
    expect(create.mock.calls[0][1]).toMatchObject({ timeout: 2500 });
  });
});
