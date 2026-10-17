import { Logger } from '@nestjs/common';
import { readFile, stat } from 'fs/promises';
import { SafetyProviderUnavailableError } from '../image-safety/types';
import { maturityTokens } from './negative';

/**
 * Política privada do classificador de texto (camada 2). Mora num arquivo JSON FORA do repositório (o repositório da
 * API é público: a política ao lado do código vira manual de como burlar). O caminho chega já validado pela config
 * (SAFETY_POLICY_SOURCE: absoluto e fora da pasta da aplicação); aqui só se lê e confere o conteúdo.
 *
 * Formato: { "version", "policy", "negativeMaturityMarkers": [...], "reasoningEffort": "low" | "medium",
 * "reasoningEffortParameter"?: nome do campo extra da Bedrock que leva o esforço de raciocínio }.
 * Nunca logar o conteúdo: só o nome do campo inválido.
 */
export interface SafetyPolicy {
  /** entra na chave do cache e no registro de cada checagem */
  version: string;
  /** texto da política (system prompt do safeguard) */
  policy: string;
  /** marcadores de maturidade do negativo, já na forma canônica (palavras separadas por espaço) */
  negativeMaturityMarkers: readonly string[];
  reasoningEffort: 'low' | 'medium';
  /**
   * campo de `additionalModelRequestFields` que leva o esforço de raciocínio; null = não envia (o nome exato do
   * parâmetro na Bedrock fica na política privada até ser conferido, para um nome errado não derrubar toda chamada)
   */
  reasoningEffortParameter: string | null;
}

/** Arquivo maior que isto não é política (400 a 600 tokens + marcadores cabem com folga). */
export const POLICY_MAX_BYTES = 256 * 1024;
const POLICY_MIN_CHARS = 100;
const POLICY_MAX_CHARS = 20_000;
const MARKERS_MAX = 500;
const MARKER_MAX_CHARS = 64;
const VERSION_FORMAT = /^[A-Za-z0-9._-]{1,64}$/;
const PARAMETER_FORMAT = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** Falha de leitura fica guardada por pouco tempo: evita ler o disco e logar a cada job, sem prender a correção. */
const FAILURE_CACHE_MS = 30_000;

const logger = new Logger('SafetyPolicy');

const loaded = new Map<string, Promise<SafetyPolicy>>();
const failedAt = new Map<string, number>();

function notConfigured(): SafetyProviderUnavailableError {
  return new SafetyProviderUnavailableError('policy', 'not_configured');
}

class PolicyFieldError extends Error {
  constructor(readonly field: string) {
    super(`campo ${field}`);
  }
}

/** Confere o JSON da política. Lança PolicyFieldError com o nome do campo (nunca o valor). */
export function parseSafetyPolicy(raw: string): SafetyPolicy {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new PolicyFieldError('json');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new PolicyFieldError('json');
  }
  const record = data as Record<string, unknown>;

  const version = record.version;
  if (typeof version !== 'string' || !VERSION_FORMAT.test(version)) {
    throw new PolicyFieldError('version');
  }

  const policy =
    typeof record.policy === 'string' ? record.policy.trim() : null;
  if (
    !policy ||
    policy.length < POLICY_MIN_CHARS ||
    policy.length > POLICY_MAX_CHARS
  ) {
    throw new PolicyFieldError('policy');
  }

  const rawMarkers = record.negativeMaturityMarkers ?? [];
  if (!Array.isArray(rawMarkers) || rawMarkers.length > MARKERS_MAX) {
    throw new PolicyFieldError('negativeMaturityMarkers');
  }
  const markers = new Set<string>();
  for (const marker of rawMarkers) {
    if (typeof marker !== 'string' || marker.length > MARKER_MAX_CHARS) {
      throw new PolicyFieldError('negativeMaturityMarkers');
    }
    const tokens = maturityTokens(marker);
    if (tokens.length) markers.add(tokens.join(' '));
  }

  const effort = record.reasoningEffort ?? 'low';
  if (effort !== 'low' && effort !== 'medium') {
    throw new PolicyFieldError('reasoningEffort');
  }

  const parameter = record.reasoningEffortParameter ?? null;
  if (
    parameter !== null &&
    (typeof parameter !== 'string' || !PARAMETER_FORMAT.test(parameter))
  ) {
    throw new PolicyFieldError('reasoningEffortParameter');
  }

  return Object.freeze({
    version,
    policy,
    negativeMaturityMarkers: Object.freeze([...markers]),
    reasoningEffort: effort,
    reasoningEffortParameter: parameter,
  });
}

async function readPolicy(path: string): Promise<SafetyPolicy> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > POLICY_MAX_BYTES) {
      throw new PolicyFieldError('arquivo');
    }
    return parseSafetyPolicy(await readFile(path, 'utf8'));
  } catch (error) {
    const field =
      error instanceof PolicyFieldError ? error.field : 'arquivo ilegível';
    logger.warn(
      `política do classificador de texto inválida (${field}); classificador indisponível`,
    );
    throw notConfigured();
  }
}

/**
 * Lê a política uma vez (cache em memória por caminho). Inválida ou ausente → SafetyProviderUnavailableError
 * ('policy', 'not_configured'); a falha fica guardada por 30 s e depois o arquivo é lido de novo.
 */
export async function loadSafetyPolicy(path: string): Promise<SafetyPolicy> {
  const cached = loaded.get(path);
  if (cached) return cached;
  const failure = failedAt.get(path);
  if (failure !== undefined && Date.now() - failure < FAILURE_CACHE_MS) {
    throw notConfigured();
  }
  const pending = readPolicy(path);
  loaded.set(path, pending);
  try {
    const policy = await pending;
    failedAt.delete(path);
    return policy;
  } catch (error) {
    loaded.delete(path);
    failedAt.set(path, Date.now());
    throw error;
  }
}

/** Leitor da política para os clientes; sem caminho configurado, sempre indisponível. */
export function createPolicyLoader(
  path: string | null,
): () => Promise<SafetyPolicy> {
  if (!path) return () => Promise.reject(notConfigured());
  return () => loadSafetyPolicy(path);
}

/** Só para testes: esquece as políticas lidas e as falhas guardadas. */
export function clearSafetyPolicyCache(): void {
  loaded.clear();
  failedAt.clear();
}
