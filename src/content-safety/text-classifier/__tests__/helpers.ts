import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  loadImageSafetyConfig,
  type ImageSafetyConfig,
} from '../../image-safety/image-safety.config';
import type { TextClassifierResult } from '../../image-safety/types';
import type { SafetyPolicy } from '../policy-loader';

/** Pasta da "aplicação" nos testes: a política temporária fica fora dela. */
export const TEST_APP_ROOT = resolve(__dirname, 'app-de-teste');

/** Política de mentira: só placeholders (a de verdade mora fora do repositório). */
export const PLACEHOLDER_POLICY_TEXT =
  'POLITICA DE TESTE: texto de exemplo sem regra real. '.repeat(4);

export function fakePolicy(
  overrides: Partial<SafetyPolicy> = {},
): SafetyPolicy {
  return {
    version: 'teste-1',
    policy: PLACEHOLDER_POLICY_TEXT,
    negativeMaturityMarkers: ['marcador alfa', 'beta'],
    reasoningEffort: 'low',
    reasoningEffortParameter: null,
    ...overrides,
  };
}

/** Escreve um JSON de política num diretório temporário próprio; devolve o caminho e a limpeza. */
export function writeTempPolicy(content: unknown): {
  path: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'taml-politica-'));
  const path = join(dir, 'politica.json');
  writeFileSync(
    path,
    typeof content === 'string' ? content : JSON.stringify(content),
    'utf8',
  );
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function textConfig(
  env: Record<string, string> = {},
): ImageSafetyConfig {
  const policyPath = resolve(tmpdir(), 'politica-fora-do-app.json');
  const { config } = loadImageSafetyConfig(
    (key) =>
      ({
        TEXT_CLASSIFIER_MODE: 'shadow',
        SAFETY_POLICY_SOURCE: policyPath,
        BEDROCK_SAFEGUARD_MODEL_ID: 'modelo.de-teste-v1',
        ...env,
      })[key],
    TEST_APP_ROOT,
  );
  return config;
}

export function safeguardResult(
  overrides: Partial<TextClassifierResult> = {},
): TextClassifierResult {
  return {
    classifier: 'safeguard',
    violation: false,
    band: 'none',
    policyRuleId: null,
    score: null,
    sexual: false,
    explicitMinor: false,
    policyVersion: 'teste-1',
    region: 'sa-east-1',
    latencyMs: 12,
    ...overrides,
  };
}
