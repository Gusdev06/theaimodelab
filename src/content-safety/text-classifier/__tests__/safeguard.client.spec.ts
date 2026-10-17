/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- clientes simulados são async por contrato; matchers do jest devolvem any */
import type { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { SafetyProviderUnavailableError } from '../../image-safety/types';
import {
  bedrockFailureOf,
  parseSafeguardOutput,
  SafeguardClient,
  safeguardBandOf,
  type BedrockClientFactory,
} from '../safeguard.client';
import type { SafetyPolicy } from '../policy-loader';
import { fakePolicy, textConfig } from './helpers';

type Reply = (
  command: ConverseCommand,
  signal?: AbortSignal,
) => Promise<unknown>;

/** Resposta simulada da Converse: blocos de raciocínio e de texto. */
function converseReply(
  text: string,
  reasoning = 'raciocinio que repete o pedido',
) {
  return {
    output: {
      message: {
        role: 'assistant',
        content: [
          { reasoningContent: { reasoningText: { text: reasoning } } },
          { text },
        ],
      },
    },
    stopReason: 'end_turn',
  };
}

function awsError(name: string, status?: number) {
  return Object.assign(new Error('mensagem do fornecedor'), {
    name,
    $metadata: { httpStatusCode: status },
  });
}

function fakeFactory(byRegion: Record<string, Reply>) {
  const calls: Array<{ region: string; command: ConverseCommand }> = [];
  const factory: BedrockClientFactory = (region) =>
    ({
      send: (
        command: ConverseCommand,
        options?: { abortSignal?: AbortSignal },
      ) => {
        calls.push({ region, command });
        return byRegion[region](command, options?.abortSignal);
      },
    }) as never;
  return { factory, calls };
}

const INPUT = {
  prompt: 'pedido de teste',
  negative: 'evitar',
  serverPrompt: null,
};
const OK = JSON.stringify({
  violation: 0,
  rule_id: null,
  confidence: 'high',
  sexual: 1,
  explicit_minor: 0,
  rationale: 'texto livre que nunca é guardado',
});

function client(
  byRegion: Record<string, Reply>,
  policy: () => Promise<SafetyPolicy> = async () => fakePolicy(),
  env: Record<string, string> = {},
) {
  const fake = fakeFactory(byRegion);
  return {
    safeguard: new SafeguardClient(textConfig(env), policy, fake.factory),
    calls: fake.calls,
  };
}

describe('parseSafeguardOutput', () => {
  it('lê o JSON da política (0/1 ou booleano), descarta o rationale', () => {
    expect(
      parseSafeguardOutput(
        '{"violation":1,"rule_id":"R2","confidence":"HIGH","sexual":true,"explicit_minor":1,"rationale":"x"}',
      ),
    ).toEqual({
      violation: true,
      ruleId: 'R2',
      confidence: 'high',
      sexual: true,
      explicitMinor: true,
    });
  });

  it('aceita o JSON dentro de bloco ```json', () => {
    expect(parseSafeguardOutput('```json\n' + OK + '\n```').violation).toBe(
      false,
    );
  });

  it('campos opcionais: sexual ausente = null; explicit_minor ausente = false; sem violação a confiança pode faltar', () => {
    expect(parseSafeguardOutput('{"violation":0}')).toEqual({
      violation: false,
      ruleId: null,
      confidence: 'low',
      sexual: null,
      explicitMinor: false,
    });
  });

  it.each([
    ['texto livre', 'não é json'],
    ['lista', '[1]'],
    ['sem violation', '{"confidence":"high"}'],
    ['violation fora do formato', '{"violation":"talvez","confidence":"high"}'],
    ['violação sem confiança', '{"violation":1}'],
    ['confiança desconhecida', '{"violation":1,"confidence":"altíssima"}'],
    [
      'rule_id fora do formato',
      '{"violation":1,"confidence":"high","rule_id":"tem espaço"}',
    ],
    ['flag inválida', '{"violation":0,"sexual":"sim"}'],
    ['grande demais', 'x'.repeat(9_000)],
  ])('recusa %s como invalid_response', (_, text) => {
    let thrown: unknown;
    try {
      parseSafeguardOutput(text);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SafetyProviderUnavailableError);
    expect(thrown).toMatchObject({ failure: 'invalid_response' });
  });

  it('faixa: alta só com confiança alta; baixa e média são ambíguas; sem violação nada', () => {
    const base = { ruleId: null, sexual: null, explicitMinor: false };
    expect(
      safeguardBandOf({ ...base, violation: true, confidence: 'high' }),
    ).toBe('high');
    expect(
      safeguardBandOf({ ...base, violation: true, confidence: 'medium' }),
    ).toBe('medium');
    expect(
      safeguardBandOf({ ...base, violation: true, confidence: 'low' }),
    ).toBe('medium');
    expect(
      safeguardBandOf({ ...base, violation: false, confidence: 'high' }),
    ).toBe('none');
  });
});

describe('SafeguardClient', () => {
  it('manda política no system e cada campo separado; lê só o bloco de texto', async () => {
    const { safeguard, calls } = client({
      'sa-east-1': async () => converseReply(OK),
    });
    const result = await safeguard.classify(INPUT);
    expect(result).toMatchObject({
      classifier: 'safeguard',
      violation: false,
      band: 'none',
      sexual: true,
      explicitMinor: false,
      policyVersion: 'teste-1',
      region: 'sa-east-1',
      score: null,
    });
    expect(JSON.stringify(result)).not.toContain('raciocinio');
    expect(JSON.stringify(result)).not.toContain('nunca é guardado');
    const input = calls[0].command.input;
    expect(input.modelId).toBe('modelo.de-teste-v1');
    expect(input.system).toEqual([{ text: fakePolicy().policy }]);
    expect(JSON.parse(input.messages?.[0].content?.[0].text ?? '')).toEqual({
      prompt: 'pedido de teste',
      negative: 'evitar',
      server_prompt: '',
    });
    expect(input.inferenceConfig).toEqual({ temperature: 0, maxTokens: 1024 });
    expect(input.additionalModelRequestFields).toBeUndefined();
  });

  it('esforço de raciocínio só vai quando a política nomeia o campo', async () => {
    const { safeguard, calls } = client(
      { 'sa-east-1': async () => converseReply(OK) },
      async () =>
        fakePolicy({
          reasoningEffortParameter: 'campo_de_teste',
          reasoningEffort: 'medium',
        }),
    );
    await safeguard.classify(INPUT);
    expect(calls[0].command.input.additionalModelRequestFields).toEqual({
      campo_de_teste: 'medium',
    });
  });

  it('violação com confiança alta e menor explícito', async () => {
    const { safeguard } = client({
      'sa-east-1': async () =>
        converseReply(
          '{"violation":1,"rule_id":"R1","confidence":"high","explicit_minor":1}',
        ),
    });
    await expect(safeguard.classify(INPUT)).resolves.toMatchObject({
      violation: true,
      band: 'high',
      explicitMinor: true,
      policyRuleId: 'R1',
    });
  });

  it.each([
    ['5xx', awsError('InternalServerException', 500), 'server_error'],
    ['limite', awsError('ThrottlingException', 429), 'throttled'],
    ['credencial', awsError('AccessDeniedException', 403), 'auth'],
  ])('%s na principal → 1 nova tentativa na reserva', async (_, error) => {
    const { safeguard, calls } = client({
      'sa-east-1': async () => {
        throw error;
      },
      'us-east-1': async () => converseReply(OK),
    });
    const result = await safeguard.classify(INPUT);
    expect(result.region).toBe('us-east-1');
    expect(calls.map((call) => call.region)).toEqual([
      'sa-east-1',
      'us-east-1',
    ]);
  });

  it('falhou nas duas → SafetyProviderUnavailableError com o motivo e a última região', async () => {
    const { safeguard } = client({
      'sa-east-1': async () => {
        throw awsError('InternalServerException', 500);
      },
      'us-east-1': async () => {
        throw awsError('ThrottlingException', 429);
      },
    });
    const error = await safeguard.classify(INPUT).catch((e) => e);
    expect(error).toBeInstanceOf(SafetyProviderUnavailableError);
    expect(error).toMatchObject({
      provider: 'safeguard',
      failure: 'throttled',
      region: 'us-east-1',
    });
    expect(String(error.message)).not.toContain('mensagem do fornecedor');
  });

  it('timeout: cliente que nunca responde é cortado pelo prazo e o sinal é abortado', async () => {
    const signals: AbortSignal[] = [];
    const never: Reply = (_, signal) => {
      if (signal) signals.push(signal);
      return new Promise(() => undefined);
    };
    const { safeguard } = client({ 'sa-east-1': never, 'us-east-1': never });
    const started = Date.now();
    const error = await safeguard
      .classify(INPUT, { timeoutMs: 120 })
      .catch((e) => e);
    expect(error).toMatchObject({ failure: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].aborted).toBe(true);
  });

  it('timeout na principal, reserva responde dentro do prazo total', async () => {
    const { safeguard } = client({
      'sa-east-1': () => new Promise(() => undefined),
      'us-east-1': async () => converseReply(OK),
    });
    // 1ª tentativa leva o prazo por tentativa (3 s); o total padrão cobre as duas
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    try {
      const pending = safeguard.classify(INPUT);
      await jest.advanceTimersByTimeAsync(3_001);
      await expect(pending).resolves.toMatchObject({ region: 'us-east-1' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('JSON inválido nas duas regiões → invalid_response', async () => {
    const { safeguard } = client({
      'sa-east-1': async () => converseReply('não é json'),
      'us-east-1': async () => converseReply('{"violation":1}'),
    });
    await expect(safeguard.classify(INPUT)).rejects.toMatchObject({
      failure: 'invalid_response',
    });
  });

  it('resposta só com raciocínio (sem bloco de texto) → invalid_response', async () => {
    const { safeguard } = client(
      {
        'sa-east-1': async () => ({
          output: {
            message: {
              content: [{ reasoningContent: { reasoningText: { text: 'x' } } }],
            },
          },
        }),
      },
      undefined,
      { BEDROCK_REGION_FALLBACK: 'none' },
    );
    await expect(safeguard.classify(INPUT)).rejects.toMatchObject({
      failure: 'invalid_response',
    });
  });

  it('sem reserva configurada: só a principal', async () => {
    const { safeguard, calls } = client(
      {
        'sa-east-1': async () => {
          throw awsError('ServiceUnavailableException', 503);
        },
      },
      undefined,
      { BEDROCK_REGION_FALLBACK: 'none' },
    );
    await expect(safeguard.classify(INPUT)).rejects.toMatchObject({
      failure: 'server_error',
      region: 'sa-east-1',
    });
    expect(calls).toHaveLength(1);
  });

  it('política ausente → indisponível sem chamar a Bedrock', async () => {
    const { safeguard, calls } = client(
      { 'sa-east-1': async () => converseReply(OK) },
      async () => {
        throw new SafetyProviderUnavailableError('policy', 'not_configured');
      },
    );
    await expect(safeguard.classify(INPUT)).rejects.toMatchObject({
      provider: 'policy',
      failure: 'not_configured',
    });
    expect(calls).toHaveLength(0);
  });

  it('sem id do modelo → not_configured sem chamar ninguém', async () => {
    const fake = fakeFactory({ 'sa-east-1': async () => converseReply(OK) });
    const config = { ...textConfig(), bedrockSafeguardModelId: null };
    const safeguard = new SafeguardClient(
      config,
      async () => fakePolicy(),
      fake.factory,
    );
    await expect(safeguard.classify(INPUT)).rejects.toMatchObject({
      failure: 'not_configured',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('cancelado por quem chamou: não tenta a reserva', async () => {
    const controller = new AbortController();
    const { safeguard, calls } = client({
      'sa-east-1': () => {
        controller.abort();
        return new Promise(() => undefined);
      },
      'us-east-1': async () => converseReply(OK),
    });
    await expect(
      safeguard.classify(INPUT, { signal: controller.signal }),
    ).rejects.toMatchObject({ failure: 'timeout' });
    expect(calls.map((call) => call.region)).toEqual(['sa-east-1']);
  });
});

describe('bedrockFailureOf', () => {
  it('mapeia o erro da AWS para o motivo do registro', () => {
    expect(bedrockFailureOf(awsError('ValidationException', 400))).toBe(
      'not_configured',
    );
    expect(bedrockFailureOf(awsError('ResourceNotFoundException', 404))).toBe(
      'not_configured',
    );
    expect(bedrockFailureOf(awsError('ModelTimeoutException', 408))).toBe(
      'timeout',
    );
    expect(bedrockFailureOf(awsError('AbortError'))).toBe('timeout');
    expect(bedrockFailureOf(awsError('Qualquer', 429))).toBe('throttled');
    expect(bedrockFailureOf(awsError('Qualquer', 401))).toBe('auth');
    expect(bedrockFailureOf(new Error('rede'))).toBe('server_error');
  });
});
