/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- clientes simulados são async por contrato; matchers do jest devolvem any */
import { Logger } from '@nestjs/common';
import type { ImageSafetyConfig } from '../../image-safety/image-safety.config';
import {
  SafetyProviderUnavailableError,
  type TextClassifierInput,
  type TextClassifierPort,
  type TextClassifierResult,
} from '../../image-safety/types';
import * as minorGuard from '../../minor-guard';
import type { SafetyPolicy } from '../policy-loader';
import {
  TextVerdictCache,
  type TextCacheStore,
} from '../text-classifier.cache';
import { createTextClassifierBackends } from '../text-classifier.providers';
import {
  decideTextVerdict,
  TextClassifierService,
  textUnavailableAction,
  type TextDecisionInput,
} from '../text-classifier.service';
import type { TextClassifierBackends } from '../text-classifier.tokens';
import { fakePolicy, safeguardResult, textConfig } from './helpers';

const SHA = 'f'.repeat(64);
const NO_NEGATIVE = { flagged: false, markerHits: 0 };

function decision(
  overrides: Partial<TextDecisionInput> = {},
): TextDecisionInput {
  return {
    sha256: SHA,
    source: 'request',
    layerOne: null,
    negative: NO_NEGATIVE,
    safeguard: safeguardResult(),
    safeguardFailure: null,
    shadow: [],
    ...overrides,
  };
}

const violation = (band: 'medium' | 'high', explicitMinor = false) =>
  safeguardResult({ violation: true, band, explicitMinor, policyRuleId: 'R1' });

describe('decideTextVerdict (regras do texto)', () => {
  it('sem violação → CLEAN, intenção sexual vinda do safeguard', () => {
    expect(
      decideTextVerdict(
        decision({ safeguard: safeguardResult({ sexual: true }) }),
      ),
    ).toMatchObject({
      verdict: 'CLEAN',
      ruleId: null,
      strength: 'NONE',
      sexualIntent: true,
      sha256: SHA,
    });
  });

  it('T_CLASSIFIER: confiança alta = BLOCK médio; com menor explícito = forte', () => {
    expect(
      decideTextVerdict(decision({ safeguard: violation('high') })),
    ).toMatchObject({
      verdict: 'BLOCK',
      ruleId: 'T_CLASSIFIER',
      strength: 'MEDIUM',
    });
    expect(
      decideTextVerdict(decision({ safeguard: violation('high', true) })),
    ).toMatchObject({
      verdict: 'BLOCK',
      ruleId: 'T_CLASSIFIER',
      strength: 'STRONG',
    });
  });

  it('T_CLASSIFIER: confiança alta com pedido de remover criança = forte; sem violação alta não pesa', () => {
    expect(
      decideTextVerdict(
        decision({ safeguard: violation('high'), minorRemoval: true }),
      ),
    ).toMatchObject({
      verdict: 'BLOCK',
      ruleId: 'T_CLASSIFIER',
      strength: 'STRONG',
    });
    expect(
      decideTextVerdict(
        decision({ safeguard: violation('medium'), minorRemoval: true }),
      ),
    ).toMatchObject({ ruleId: 'T_AMBIGUOUS', strength: 'NONE' });
    expect(decideTextVerdict(decision({ minorRemoval: true }))).toMatchObject({
      verdict: 'CLEAN',
    });
  });

  it('T_AMBIGUOUS: faixa média = BLOCK sem ponto (não gera, estorno)', () => {
    expect(
      decideTextVerdict(decision({ safeguard: violation('medium') })),
    ).toMatchObject({
      verdict: 'BLOCK',
      ruleId: 'T_AMBIGUOUS',
      strength: 'NONE',
    });
  });

  it('T_REFINER: saída do refinador com violação em qualquer faixa = BLOCK médio', () => {
    for (const result of [violation('medium'), violation('high', true)]) {
      expect(
        decideTextVerdict(decision({ source: 'refiner', safeguard: result })),
      ).toMatchObject({
        verdict: 'BLOCK',
        ruleId: 'T_REFINER',
        strength: 'MEDIUM',
      });
    }
  });

  it('T_NEGATIVE: marcador no negativo de pedido sexual = HOLD médio, mesmo com o classificador fora', () => {
    const negative = { flagged: true, markerHits: 1 };
    expect(decideTextVerdict(decision({ negative }))).toMatchObject({
      verdict: 'HOLD',
      ruleId: 'T_NEGATIVE',
      strength: 'MEDIUM',
    });
    expect(
      decideTextVerdict(
        decision({ negative, safeguard: null, safeguardFailure: 'timeout' }),
      ),
    ).toMatchObject({ verdict: 'HOLD', ruleId: 'T_NEGATIVE' });
    // vence o ambíguo e o médio; perde para o forte
    expect(
      decideTextVerdict(decision({ negative, safeguard: violation('medium') })),
    ).toMatchObject({
      ruleId: 'T_NEGATIVE',
    });
    expect(
      decideTextVerdict(
        decision({ negative, safeguard: violation('high', true) }),
      ),
    ).toMatchObject({ ruleId: 'T_CLASSIFIER', strength: 'STRONG' });
  });

  it('safeguard indisponível → UNAVAILABLE com o motivo (nunca CLEAN)', () => {
    expect(
      decideTextVerdict(
        decision({ safeguard: null, safeguardFailure: 'throttled' }),
      ),
    ).toMatchObject({
      verdict: 'UNAVAILABLE',
      ruleId: 'UNAVAILABLE',
      sexualIntent: null,
      reason: expect.stringContaining('throttled'),
    });
  });

  it('camada 1 acusou: decide sem classificador', () => {
    expect(
      decideTextVerdict(
        decision({
          layerOne: { blocked: true, reason: 'age' },
          safeguard: null,
        }),
      ),
    ).toMatchObject({
      verdict: 'BLOCK',
      ruleId: 'T_CLASSIFIER',
      strength: 'STRONG',
      results: [],
    });
    expect(
      decideTextVerdict(
        decision({
          layerOne: { blocked: true, reason: 'term' },
          safeguard: null,
        }),
      ),
    ).toMatchObject({ ruleId: 'T_CLASSIFIER', strength: 'MEDIUM' });
    expect(
      decideTextVerdict(
        decision({
          layerOne: { blocked: true, reason: 'script' },
          safeguard: null,
        }),
      ),
    ).toMatchObject({
      verdict: 'BLOCK',
      ruleId: 'T_AMBIGUOUS',
      strength: 'NONE',
    });
    expect(
      decideTextVerdict(
        decision({
          source: 'refiner',
          layerOne: { blocked: true, reason: 'age' },
          safeguard: null,
        }),
      ),
    ).toMatchObject({ ruleId: 'T_REFINER', strength: 'MEDIUM' });
  });

  it('omni em sombra nunca decide, só aparece nos resultados', () => {
    const omni: TextClassifierResult = {
      ...safeguardResult({
        classifier: 'omni-moderation',
        violation: true,
        band: 'high',
        score: 0.9,
      }),
      policyVersion: null,
      region: null,
    };
    const verdict = decideTextVerdict(decision({ shadow: [omni] }));
    expect(verdict.verdict).toBe('CLEAN');
    expect(verdict.results.map((r) => r.classifier)).toEqual([
      'safeguard',
      'omni-moderation',
    ]);
  });

  it('o motivo interno nunca leva o texto do pedido', () => {
    const verdict = decideTextVerdict(
      decision({ safeguard: violation('high') }),
    );
    expect(verdict.reason).not.toContain('pedido de teste');
  });
});

describe('textUnavailableAction (regra de falha da camada 2)', () => {
  it('com foto ou modelo sem censura fica na fila; com filtro em texto puro segue', () => {
    expect(
      textUnavailableAction({ model: 'nano-banana', hasUserMedia: true }),
    ).toBe('retry');
    expect(
      textUnavailableAction({ model: 'nano-banana', hasUserMedia: false }),
    ).toBe('proceed');
    expect(
      textUnavailableAction({ model: 'modelo-unlocked', hasUserMedia: false }),
    ).toBe('retry');
    expect(textUnavailableAction({ model: null, hasUserMedia: false })).toBe(
      'proceed',
    );
  });
});

/* ------------------------------------------------------------------ serviço */

type Port = TextClassifierPort & { classify: jest.Mock };

function port(
  name: string,
  impl: (input: TextClassifierInput) => Promise<TextClassifierResult>,
): Port {
  return { name, classify: jest.fn(impl) } as Port;
}

function memoryStore(): TextCacheStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
      return 'OK';
    },
  };
}

function build(
  options: {
    config?: ImageSafetyConfig;
    safeguard?: Port | null;
    shadow?: Port[];
    policy?: () => Promise<SafetyPolicy>;
    store?: TextCacheStore | null;
  } = {},
) {
  const policy = jest.fn(options.policy ?? (async () => fakePolicy()));
  const safeguard =
    options.safeguard === undefined
      ? port('safeguard', async () => safeguardResult())
      : options.safeguard;
  const backends: TextClassifierBackends = {
    safeguard,
    shadow: options.shadow ?? [],
    policy,
  };
  const store = options.store === undefined ? memoryStore() : options.store;
  const service = new TextClassifierService(
    options.config ?? textConfig(),
    backends,
    new TextVerdictCache(store),
  );
  return { service, safeguard, policy, store };
}

const INPUT: TextClassifierInput = {
  prompt: 'pedido de teste',
  negative: 'blurry, beta',
  serverPrompt: null,
};

describe('TextClassifierService', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('modo off = Onda 0: nenhuma chamada, nenhum cache, nunca CLEAN', async () => {
    const config = textConfig({ TEXT_CLASSIFIER_MODE: 'off' });
    const store = { get: jest.fn(), set: jest.fn() };
    const { service, safeguard, policy } = build({ config, store });
    expect(service.enabled).toBe(false);
    const verdict = await service.classify(INPUT, {
      sexualRequest: true,
      source: 'request',
    });
    expect(verdict).toMatchObject({
      verdict: 'UNAVAILABLE',
      ruleId: 'UNAVAILABLE',
    });
    expect(service.shouldAct(verdict)).toBe(false);
    expect(safeguard?.classify).not.toHaveBeenCalled();
    expect(policy).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
  });

  it('modo off: a fábrica não cria cliente nenhum', () => {
    const backends = createTextClassifierBackends(
      textConfig({
        TEXT_CLASSIFIER_MODE: 'off',
        OPENAI_MODERATION_API_KEY: 'chave-de-teste',
      }),
    );
    expect(backends.safeguard).toBeNull();
    expect(backends.shadow).toEqual([]);
    return expect(backends.policy()).rejects.toMatchObject({
      failure: 'not_configured',
    });
  });

  it('ligado: safeguard decide, omni entra só em sombra', () => {
    const backends = createTextClassifierBackends(
      textConfig({ OPENAI_MODERATION_API_KEY: 'chave-de-teste' }),
    );
    expect(backends.safeguard?.name).toBe('safeguard');
    expect(backends.shadow.map((p) => p.name)).toEqual(['omni-moderation']);
  });

  it('negativo invertido: marcador da política em pedido sexual segura (HOLD)', async () => {
    const { service } = build();
    await expect(
      service.classify(INPUT, { sexualRequest: true, source: 'request' }),
    ).resolves.toMatchObject({
      verdict: 'HOLD',
      ruleId: 'T_NEGATIVE',
      strength: 'MEDIUM',
    });
    await expect(
      service.classify(INPUT, { sexualRequest: false, source: 'request' }),
    ).resolves.toMatchObject({ verdict: 'CLEAN' });
  });

  it('withSexualRequest: o negativo é decidido de novo com o pedido sexual final, sem nova chamada', async () => {
    const { service, safeguard, policy } = build();
    const first = await service.classify(INPUT, {
      sexualRequest: false,
      source: 'request',
    });
    expect(first).toMatchObject({ verdict: 'CLEAN' });
    const redecided = service.withSexualRequest(first);
    expect(redecided).toMatchObject({
      verdict: 'HOLD',
      ruleId: 'T_NEGATIVE',
      strength: 'MEDIUM',
      sha256: first.sha256,
    });
    expect(safeguard?.classify).toHaveBeenCalledTimes(1);
    expect(policy).toHaveBeenCalledTimes(1);
    // sem marcador no negativo, ou veredito que não veio do classify: volta igual
    const clean = await service.classify(
      { ...INPUT, negative: 'blurry' },
      { sexualRequest: false, source: 'request' },
    );
    expect(service.withSexualRequest(clean)).toBe(clean);
    const foreign = { ...first };
    expect(service.withSexualRequest(foreign)).toBe(foreign);
  });

  it('withSexualRequest nunca rebaixa um sinal forte do classificador', async () => {
    const { service } = build({
      safeguard: port('safeguard', async () =>
        safeguardResult({
          violation: true,
          band: 'high',
          explicitMinor: true,
        }),
      ),
    });
    const strong = await service.classify(INPUT, {
      sexualRequest: false,
      source: 'request',
    });
    expect(service.withSexualRequest(strong)).toMatchObject({
      verdict: 'BLOCK',
      ruleId: 'T_CLASSIFIER',
      strength: 'STRONG',
    });
  });

  it('cache: 2ª chamada com o mesmo texto canônico não chama o safeguard; o veredito é refeito', async () => {
    const { service, safeguard } = build();
    const first = await service.classify(INPUT, {
      sexualRequest: false,
      source: 'request',
    });
    expect(first.verdict).toBe('CLEAN');
    // mesma forma canônica (caixa e acento), agora em pedido sexual: o resultado vem do cache, a regra muda
    const second = await service.classify(
      { ...INPUT, prompt: 'PEDIDO DE TÉSTE' },
      { sexualRequest: true, source: 'request' },
    );
    expect(safeguard?.classify).toHaveBeenCalledTimes(1);
    expect(second.verdict).toBe('HOLD');
    expect(second.sha256).toBe(first.sha256);
  });

  it('cache guarda só resultado bem-sucedido', async () => {
    const store = memoryStore();
    const failing = port('safeguard', async () => {
      throw new SafetyProviderUnavailableError(
        'safeguard',
        'timeout',
        'sa-east-1',
      );
    });
    const { service } = build({ safeguard: failing, store });
    const verdict = await service.classify(INPUT, {
      sexualRequest: false,
      source: 'request',
    });
    expect(verdict).toMatchObject({
      verdict: 'UNAVAILABLE',
      reason: expect.stringContaining('timeout'),
    });
    expect(store.data.size).toBe(0);
    expect(service.shouldAct(verdict)).toBe(false); // shadow: indisponível do texto não age
    expect(warn.mock.calls[0][0]).not.toContain('pedido de teste');
  });

  it('Redis fora: segue sem cache', async () => {
    const broken: TextCacheStore = {
      get: () => Promise.reject(new Error('fora')),
      set: () => Promise.reject(new Error('fora')),
    };
    const { service, safeguard } = build({ store: broken });
    await expect(
      service.classify(INPUT, { sexualRequest: false, source: 'request' }),
    ).resolves.toMatchObject({ verdict: 'CLEAN' });
    expect(safeguard?.classify).toHaveBeenCalledTimes(1);
  });

  it('política ausente → UNAVAILABLE sem chamar ninguém', async () => {
    const { service, safeguard } = build({
      policy: async () => {
        throw new SafetyProviderUnavailableError('policy', 'not_configured');
      },
    });
    await expect(
      service.classify(INPUT, { sexualRequest: true, source: 'request' }),
    ).resolves.toMatchObject({
      verdict: 'UNAVAILABLE',
      reason: expect.stringContaining('not_configured'),
    });
    expect(safeguard?.classify).not.toHaveBeenCalled();
  });

  it('JSON inválido do safeguard (invalid_response) → UNAVAILABLE', async () => {
    const invalid = port('safeguard', async () => {
      throw new SafetyProviderUnavailableError(
        'safeguard',
        'invalid_response',
        'us-east-1',
      );
    });
    const { service } = build({ safeguard: invalid });
    await expect(
      service.classify(
        { ...INPUT, negative: null },
        { sexualRequest: true, source: 'request' },
      ),
    ).resolves.toMatchObject({
      verdict: 'UNAVAILABLE',
      reason: expect.stringContaining('invalid_response'),
    });
  });

  it('safeguard sem modelo configurado → UNAVAILABLE not_configured', async () => {
    const { service } = build({ safeguard: null });
    await expect(
      service.classify(
        { ...INPUT, negative: null },
        { sexualRequest: false, source: 'request' },
      ),
    ).resolves.toMatchObject({
      verdict: 'UNAVAILABLE',
      reason: expect.stringContaining('not_configured'),
    });
  });

  it('timeout repassado ao safeguard', async () => {
    const { service, safeguard } = build();
    await service.classify(INPUT, {
      sexualRequest: false,
      source: 'request',
      timeoutMs: 1234,
    });
    expect(safeguard?.classify).toHaveBeenCalledWith(
      INPUT,
      expect.objectContaining({ timeoutMs: 1234 }),
    );
  });

  it('sombra que falha não muda o veredito', async () => {
    const omni = port('omni-moderation', async () => {
      throw new SafetyProviderUnavailableError('omni-moderation', 'auth');
    });
    const { service } = build({ shadow: [omni] });
    const verdict = await service.classify(
      { ...INPUT, negative: null },
      { sexualRequest: false, source: 'request' },
    );
    expect(verdict.verdict).toBe('CLEAN');
    expect(verdict.results.map((r) => r.classifier)).toEqual(['safeguard']);
  });

  it('camada 1 acusou: nada vai para fora (nem política, nem cache, nem classificador)', async () => {
    jest
      .spyOn(minorGuard, 'assessText')
      .mockImplementation((text) =>
        text === 'texto que a camada 1 acusa'
          ? { blocked: true, reason: 'term' }
          : { blocked: false },
      );
    const omni = port('omni-moderation', async () =>
      safeguardResult({ classifier: 'omni-moderation' }),
    );
    const store = { get: jest.fn(), set: jest.fn() };
    const { service, safeguard, policy } = build({ shadow: [omni], store });
    const verdict = await service.classify(
      {
        prompt: null,
        negative: null,
        serverPrompt: 'texto que a camada 1 acusa',
      },
      { sexualRequest: true, source: 'refiner' },
    );
    expect(verdict).toMatchObject({
      verdict: 'BLOCK',
      ruleId: 'T_REFINER',
      strength: 'MEDIUM',
    });
    expect(safeguard?.classify).not.toHaveBeenCalled();
    expect(omni.classify).not.toHaveBeenCalled();
    expect(policy).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
  });

  it('pedido de remover criança (prompt ou servidor, nunca o negativo) torna forte a violação alta', async () => {
    const removal = jest
      .spyOn(minorGuard, 'mentionsMinorRemoval')
      .mockImplementation((text) => text === 'pedido com remoção');
    const { service } = build({
      safeguard: port('safeguard', async () => violation('high')),
    });
    await expect(
      service.classify(
        { prompt: 'pedido com remoção', negative: null, serverPrompt: null },
        { sexualRequest: true, source: 'request' },
      ),
    ).resolves.toMatchObject({ ruleId: 'T_CLASSIFIER', strength: 'STRONG' });
    await expect(
      service.classify(
        {
          prompt: 'outro pedido',
          negative: 'pedido com remoção',
          serverPrompt: null,
        },
        { sexualRequest: true, source: 'request' },
      ),
    ).resolves.toMatchObject({ ruleId: 'T_CLASSIFIER', strength: 'MEDIUM' });
    expect(removal).toHaveBeenCalled();
  });

  it('o negativo não passa pela camada 1 (termo no "evitar" é boa prática)', async () => {
    const assess = jest.spyOn(minorGuard, 'assessText');
    const { service } = build();
    await service.classify(INPUT, { sexualRequest: false, source: 'request' });
    const checked = assess.mock.calls.map(([text]) => text);
    expect(checked).toContain('pedido de teste');
    expect(checked).not.toContain('blurry, beta');
  });

  it('sem texto nenhum: CLEAN sem chamar ninguém', async () => {
    const { service, safeguard } = build();
    await expect(
      service.classify(
        { prompt: ' ', negative: null, serverPrompt: null },
        { sexualRequest: true, source: 'request' },
      ),
    ).resolves.toMatchObject({ verdict: 'CLEAN', reason: 'sem texto' });
    expect(safeguard?.classify).not.toHaveBeenCalled();
  });

  it('textSha256: campos separados (mover texto de campo muda o hash) e forma canônica', () => {
    const { service } = build();
    const a = service.textSha256({
      prompt: 'abc',
      negative: null,
      serverPrompt: null,
    });
    expect(
      service.textSha256({ prompt: 'ABC', negative: null, serverPrompt: null }),
    ).toBe(a);
    expect(
      service.textSha256({ prompt: null, negative: 'abc', serverPrompt: null }),
    ).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  describe('shouldAct por modo', () => {
    const cases: Array<[string, string, boolean]> = [
      ['shadow', 'T_REFINER/MEDIUM', true],
      ['shadow', 'T_CLASSIFIER/STRONG', true],
      ['shadow', 'T_CLASSIFIER/MEDIUM', false],
      ['shadow', 'T_NEGATIVE/MEDIUM', false],
      ['shadow', 'T_AMBIGUOUS/NONE', false],
      ['shadow', 'UNAVAILABLE/NONE', false],
      ['enforce', 'T_CLASSIFIER/MEDIUM', true],
      ['enforce', 'T_NEGATIVE/MEDIUM', true],
      ['enforce', 'T_AMBIGUOUS/NONE', true],
      ['enforce', 'UNAVAILABLE/NONE', true],
    ];
    it.each(cases)('%s: %s → %s', (mode, rule, expected) => {
      const [ruleId, strength] = rule.split('/');
      const { service } = build({
        config: textConfig({ TEXT_CLASSIFIER_MODE: mode }),
      });
      expect(
        service.shouldAct({
          ruleId: ruleId as never,
          strength: strength as never,
        }),
      ).toBe(expected);
    });

    it('shadow sem IMAGE_SAFETY_ENFORCE_STRONG: só observa', () => {
      const { service } = build({
        config: textConfig({ IMAGE_SAFETY_ENFORCE_STRONG: 'false' }),
      });
      expect(
        service.shouldAct({ ruleId: 'T_REFINER', strength: 'MEDIUM' }),
      ).toBe(false);
      expect(service.shouldAct({ ruleId: null, strength: 'NONE' })).toBe(false);
    });
  });
});
