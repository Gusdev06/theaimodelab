/* eslint-disable @typescript-eslint/require-await -- clientes simulados são async por contrato; matchers do jest devolvem any */
import OpenAI from 'openai';
import {
  createOmniModerationClient,
  OMNI_MODEL,
  omniBandOf,
  omniFailureOf,
  OmniModerationClient,
} from '../omni-moderation.client';

/** Resposta simulada do moderations.create: só os scores que importam. */
function moderation(scores: number[]) {
  return {
    id: 'modr-teste',
    model: OMNI_MODEL,
    results: scores.map((score) => ({
      flagged: false,
      categories: {},
      category_scores: { 'sexual/minors': score, sexual: 0.9 },
    })),
  };
}

function fakeApi(
  handler: (body: unknown, options: unknown) => Promise<unknown>,
) {
  const create = jest.fn(handler);
  return { api: { moderations: { create } } as never, create };
}

const INPUT = {
  prompt: 'pedido de teste',
  negative: 'evitar isto',
  serverPrompt: 'montado no servidor',
};

describe('OmniModerationClient (sombra)', () => {
  it('manda prompt e prompt do servidor (nunca o negativo) e lê só sexual/minors', async () => {
    const { api, create } = fakeApi(async () => moderation([0.02, 0.2]));
    const omni = new OmniModerationClient('chave-de-teste', () => api);
    const result = await omni.classify(INPUT);
    expect(create).toHaveBeenCalledWith(
      { model: OMNI_MODEL, input: ['pedido de teste', 'montado no servidor'] },
      expect.objectContaining({ maxRetries: 0 }),
    );
    expect(result).toMatchObject({
      classifier: 'omni-moderation',
      score: 0.2,
      band: 'medium',
      violation: true,
      sexual: null,
      explicitMinor: false,
      policyRuleId: null,
    });
  });

  it('faixas pelos limiares (0,15 e 0,5)', () => {
    expect(omniBandOf(0.149)).toBe('none');
    expect(omniBandOf(0.15)).toBe('medium');
    expect(omniBandOf(0.499)).toBe('medium');
    expect(omniBandOf(0.5)).toBe('high');
  });

  it('sem texto: não chama a OpenAI', async () => {
    const { api, create } = fakeApi(async () => moderation([]));
    const omni = new OmniModerationClient('chave-de-teste', () => api);
    await expect(
      omni.classify({
        prompt: '  ',
        negative: 'só negativo',
        serverPrompt: null,
      }),
    ).resolves.toMatchObject({ band: 'none', violation: false, score: 0 });
    expect(create).not.toHaveBeenCalled();
  });

  it('resposta fora do formato → invalid_response', async () => {
    for (const reply of [
      moderation([1.5]),
      { results: [] },
      { results: [{ category_scores: {} }] },
    ]) {
      const { api } = fakeApi(async () => reply);
      const omni = new OmniModerationClient('chave-de-teste', () => api);
      await expect(
        omni.classify({ prompt: 'x', negative: null, serverPrompt: null }),
      ).rejects.toMatchObject({
        provider: 'omni-moderation',
        failure: 'invalid_response',
      });
    }
  });

  it('timeout: prazo corta o cliente que não responde', async () => {
    const { api } = fakeApi(() => new Promise(() => undefined));
    const omni = new OmniModerationClient('chave-de-teste', () => api);
    await expect(omni.classify(INPUT, { timeoutMs: 50 })).rejects.toMatchObject(
      { failure: 'timeout' },
    );
  });

  it('erros do SDK viram o motivo do registro', () => {
    const headers = new Headers();
    expect(omniFailureOf(OpenAI.APIError.generate(429, {}, 'x', headers))).toBe(
      'throttled',
    );
    expect(omniFailureOf(OpenAI.APIError.generate(401, {}, 'x', headers))).toBe(
      'auth',
    );
    expect(omniFailureOf(OpenAI.APIError.generate(500, {}, 'x', headers))).toBe(
      'server_error',
    );
    expect(omniFailureOf(new OpenAI.APIConnectionTimeoutError())).toBe(
      'timeout',
    );
  });

  it('sem chave: nenhum cliente', () => {
    expect(
      createOmniModerationClient({ omniModerationApiKey: null }),
    ).toBeNull();
    expect(
      createOmniModerationClient({ omniModerationApiKey: 'chave-de-teste' }),
    ).toBeInstanceOf(OmniModerationClient);
  });
});
