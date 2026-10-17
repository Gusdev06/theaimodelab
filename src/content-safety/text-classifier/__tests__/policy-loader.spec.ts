/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- clientes simulados são async por contrato; matchers do jest devolvem any */
import { Logger } from '@nestjs/common';
import { copyFileSync } from 'fs';
import { SafetyProviderUnavailableError } from '../../image-safety/types';
import {
  clearSafetyPolicyCache,
  createPolicyLoader,
  loadSafetyPolicy,
  parseSafetyPolicy,
} from '../policy-loader';
import { PLACEHOLDER_POLICY_TEXT, writeTempPolicy } from './helpers';

const VALID = {
  version: 'teste-1',
  policy: PLACEHOLDER_POLICY_TEXT,
  negativeMaturityMarkers: ['Marcador-Alfa', 'BETA', 'beta', '  '],
  reasoningEffort: 'low',
};

describe('política privada do classificador', () => {
  let warn: jest.SpyInstance;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    clearSafetyPolicyCache();
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    while (cleanups.length) cleanups.pop()?.();
  });

  function temp(content: unknown): string {
    const file = writeTempPolicy(content);
    cleanups.push(file.cleanup);
    return file.path;
  }

  it('lê e normaliza os marcadores para a forma canônica, sem repetir', async () => {
    const policy = await loadSafetyPolicy(temp(VALID));
    expect(policy.version).toBe('teste-1');
    expect(policy.negativeMaturityMarkers).toEqual(['marcador alfa', 'beta']);
    expect(policy.reasoningEffort).toBe('low');
    expect(policy.reasoningEffortParameter).toBeNull();
  });

  it('lê o arquivo uma vez só (cache em memória)', async () => {
    const path = temp(VALID);
    const first = await loadSafetyPolicy(path);
    const second = await loadSafetyPolicy(path);
    expect(second).toBe(first);
  });

  it('arquivo ausente → indisponível (not_configured), sem logar conteúdo', async () => {
    await expect(
      loadSafetyPolicy(`${temp(VALID)}.nao-existe`),
    ).rejects.toMatchObject({ provider: 'policy', failure: 'not_configured' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('arquivo ilegível'),
    );
  });

  it('JSON inválido ou campo errado → indisponível, o log cita só o campo', async () => {
    const cases: Array<[unknown, string]> = [
      ['{ isto não é json', 'json'],
      [{ ...VALID, version: 'com espaço' }, 'version'],
      [{ ...VALID, policy: 'curta' }, 'policy'],
      [
        { ...VALID, negativeMaturityMarkers: 'beta' },
        'negativeMaturityMarkers',
      ],
      [{ ...VALID, reasoningEffort: 'high' }, 'reasoningEffort'],
      [
        { ...VALID, reasoningEffortParameter: 'tem espaço' },
        'reasoningEffortParameter',
      ],
    ];
    for (const [content, field] of cases) {
      clearSafetyPolicyCache();
      warn.mockClear();
      const error = await loadSafetyPolicy(temp(content)).catch((e) => e);
      expect(error).toBeInstanceOf(SafetyProviderUnavailableError);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(`(${field})`);
      expect(warn.mock.calls[0][0]).not.toContain('POLITICA DE TESTE');
    }
  });

  it('falha fica guardada por pouco tempo e depois o arquivo é relido', async () => {
    let now = Date.parse('2026-10-17T12:00:00Z');
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const file = writeTempPolicy('{ quebrado');
      cleanups.push(file.cleanup);
      await expect(loadSafetyPolicy(file.path)).rejects.toThrow();
      // corrigido no disco: dentro da janela ainda indisponível, sem reler
      const fixed = writeTempPolicy(VALID);
      cleanups.push(fixed.cleanup);
      copyFileSync(fixed.path, file.path);
      warn.mockClear();
      await expect(loadSafetyPolicy(file.path)).rejects.toThrow();
      expect(warn).not.toHaveBeenCalled();
      now += 31_000;
      await expect(loadSafetyPolicy(file.path)).resolves.toMatchObject({
        version: 'teste-1',
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('sem caminho configurado, o leitor sempre recusa', async () => {
    await expect(createPolicyLoader(null)()).rejects.toMatchObject({
      failure: 'not_configured',
    });
  });

  it('parseSafetyPolicy aceita o campo do esforço de raciocínio e o esforço médio', () => {
    const policy = parseSafetyPolicy(
      JSON.stringify({
        ...VALID,
        reasoningEffort: 'medium',
        reasoningEffortParameter: 'campo_de_teste',
      }),
    );
    expect(policy.reasoningEffort).toBe('medium');
    expect(policy.reasoningEffortParameter).toBe('campo_de_teste');
  });
});
