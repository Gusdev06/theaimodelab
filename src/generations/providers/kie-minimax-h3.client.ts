import { Logger } from '@nestjs/common';
import {
  ContentSafetyError,
  isMinorSafetyBlock,
} from '../errors/content-safety.error';
import {
  classifyGenerationFailure,
  GenerationFailureCode,
  ProviderFailureError,
  rawFailureText,
} from '../errors/failure-reason';
import { isMinorRefusal } from '../errors/minor-refusal';

/**
 * MiniMax H3 na kie (mesma conta e chave do NANO_BANANA_*): o mesmo modelo da WaveSpeed pela metade do preço
 * (US$ 0,04/s em 768P). Serve de primário (MINIMAX_H3_PROVIDER=kie) ou de desvio (MINIMAX_H3_KIE_FALLBACK).
 *
 *   POST {base}/api/v1/jobs/createTask            -> { code, msg, data: { taskId } }
 *   GET  {base}/api/v1/jobs/recordInfo?taskId=…   -> { data: { state, resultJson, failCode, failMsg } }
 *
 * Só image-to-video e text-to-video: o reference-to-video cita <Picture 1> no prompt (formato da WaveSpeed) e fica lá.
 */

export const KIE_MINIMAX_H3_I2V_MODEL = 'minimax-h3/image-to-video';
export const KIE_MINIMAX_H3_T2V_MODEL = 'minimax-h3/text-to-video';

/** A kie aceita 4–15 s inteiros e cobra por segundo. */
const KIE_DURATION_MIN = 4;
const KIE_DURATION_MAX = 15;
/** Nossos 480p e 768p viram o 768P da kie (o 2K não é vendido). */
const KIE_RESOLUTION = '768P';
const KIE_T2V_DEFAULT_ASPECT = '16:9';
const KIE_T2V_ASPECTS: ReadonlySet<string> = new Set([
  '21:9',
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
]);
/** Moderação da kie (mesmo código do Seedream). */
const KIE_MODERATION_FAIL_CODES: ReadonlySet<string> = new Set(['430']);

const KIE_POLL_INTERVAL_MS = 5_000;
const KIE_POLL_MAX_ATTEMPTS = 108; // ~9 min, a mesma janela da WaveSpeed
/** Consultas seguidas que falham (rede, HTTP, corpo sem dado) antes de desistir; cada resposta boa zera a conta. */
const KIE_POLL_TRANSIENT_MAX = 6;

export type MinimaxH3Engine = 'wavespeed' | 'kie';
export type MinimaxH3FallbackMode = 'off' | 'tecnico' | 'tecnico+recusa';
/** Onde o primário falhou: antes de a tarefa existir (`start`) ou depois de criada (`final`). */
export type MinimaxH3FailureStage = 'start' | 'final';

export interface KieMinimaxH3FailureMessages {
  unavailable: string;
  unexpected: string;
  missingOutput: string;
  failed: string;
  tooSlow: string;
}

interface KieCreateTaskResponse {
  code?: number;
  msg?: string;
  data?: { taskId?: string } | null;
}

interface KieRecordInfoResponse {
  code?: number;
  msg?: string;
  data?: {
    taskId?: string;
    state?: 'waiting' | 'queuing' | 'generating' | 'success' | 'fail';
    resultJson?: string;
    failCode?: string | number | null;
    failMsg?: string | null;
  } | null;
}

function normalizeFlag(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/** MINIMAX_H3_PROVIDER: 'kie' ou o padrão 'wavespeed' (valor desconhecido = padrão). */
export function parseMinimaxH3Engine(raw: unknown): MinimaxH3Engine {
  return normalizeFlag(raw) === 'kie' ? 'kie' : 'wavespeed';
}

/** MINIMAX_H3_KIE_FALLBACK: 'tecnico', 'tecnico+recusa' ou o padrão 'off' (valor desconhecido = padrão). */
export function parseMinimaxH3FallbackMode(
  raw: unknown,
): MinimaxH3FallbackMode {
  const flag = normalizeFlag(raw);
  if (flag === 'tecnico' || flag === 'tecnico+recusa') return flag;
  return 'off';
}

function errorText(error: unknown): string {
  if (error instanceof Error) return rawFailureText(error);
  return typeof error === 'string' ? error : '';
}

/** O provedor recusou o conteúdo (moderação, filtro, entrada recusada), em vez de falhar por motivo técnico? */
export function isMinimaxH3ContentRefusal(error: unknown): boolean {
  if (error instanceof ContentSafetyError) return true;
  const text = errorText(error);
  if (!text) return false;
  if (ContentSafetyError.fromErrorMessage(text)) return true;
  const code = classifyGenerationFailure(text);
  return (
    code === GenerationFailureCode.CONTENT_SAFETY_BLOCKED ||
    code === GenerationFailureCode.INPUT_IMAGE_REJECTED ||
    code === GenerationFailureCode.CONTENT_POLICY_MINOR
  );
}

/**
 * Falha na criação da tarefa em que o provedor PODE ter aceitado o pedido: tempo esgotado, conexão caída depois do
 * envio, resposta 2xx ilegível ou sem id. Não desvia em modo nenhum, porque a tarefa pode existir e ser cobrada.
 * Só o runMinimaxH3 vê esta classe: quem chama recebe o `original`.
 */
export class MinimaxH3UncertainStartError extends Error {
  constructor(readonly original: Error) {
    super(original.message);
    this.name = 'MinimaxH3UncertainStartError';
  }
}

/** O erro que sobe para quem chama: o `original` do início incerto, ou o próprio erro. */
export function unwrapMinimaxH3Failure(error: unknown): unknown {
  return error instanceof MinimaxH3UncertainStartError ? error.original : error;
}

/** Códigos de rede de ANTES do envio (DNS, conexão recusada): o provedor nunca recebeu o pedido. */
const PRE_SEND_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function networkCodeOf(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const { code } = value as { code?: unknown };
  return typeof code === 'string' ? code : '';
}

/** O fetch falhou antes de o pedido sair (o undici põe o código no `cause` do "fetch failed")? */
export function isPreSendNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { cause } = error as { cause?: unknown };
  return (
    PRE_SEND_NETWORK_CODES.has(networkCodeOf(error)) ||
    PRE_SEND_NETWORK_CODES.has(networkCodeOf(cause))
  );
}

/**
 * Erro do POST de criação na WaveSpeed: HTTP não-ok (ProviderFailureError) e rede antes do envio são falhas seguras
 * de início; o resto (timeout, conexão caída no meio, JSON ilegível, resposta sem id) pode ter criado a tarefa.
 */
export function asMinimaxH3StartFailure(error: unknown): unknown {
  if (error instanceof ProviderFailureError || error instanceof ContentSafetyError)
    return error;
  if (!(error instanceof Error) || isPreSendNetworkError(error)) return error;
  return new MinimaxH3UncertainStartError(error);
}

/**
 * Falha final sem motivo dito pelo provedor: demora, consulta fora do ar, saída que não veio, 'failed' sem texto,
 * cancelled/timeout sem erro. Pode até ser menor que o provedor não escreveu, e a tarefa pode ainda terminar e cobrar.
 */
export function isMinimaxH3FailureWithoutReason(
  error: unknown,
  messages: KieMinimaxH3FailureMessages,
): boolean {
  if (!(error instanceof Error)) return true;
  if (error instanceof ProviderFailureError) {
    if (error.message !== messages.failed) return true;
    const reason = error.providerDetail
      .replace(/^status=\S+\s*/, '')
      .replace(/\s*\(\d+\)$/, '')
      .trim();
    return !reason || /^unknown error$/i.test(reason);
  }
  return Object.values(messages).includes(error.message);
}

/**
 * A falha do primário vai para o outro provedor?
 *  - `off`: nunca;
 *  - recusa por menor: nunca, em qualquer modo (o pedido não ganha um segundo provedor);
 *  - `tecnico`: só falha técnica ANTES de a tarefa existir. Depois de criada (moderação, 'failed', demora) não
 *    desvia: evita cobrança dupla e segunda opinião sobre conteúdo recusado;
 *  - `tecnico+recusa`: qualquer outra falha no início; no fim, só a que traz o motivo do provedor (sem motivo pode
 *    ser menor não dito, e a tarefa pode ainda terminar e cobrar).
 */
export function shouldDivertMinimaxH3(
  mode: MinimaxH3FallbackMode,
  stage: MinimaxH3FailureStage,
  error: unknown,
  messages: KieMinimaxH3FailureMessages,
): boolean {
  if (mode === 'off') return false;
  if (isMinorSafetyBlock(error) || isMinorRefusal(error)) return false;
  if (mode === 'tecnico+recusa')
    return stage === 'start' || !isMinimaxH3FailureWithoutReason(error, messages);
  return stage === 'start' && !isMinimaxH3ContentRefusal(error);
}

export function kieMinimaxH3Duration(durationSeconds: number): number {
  const rounded = Math.round(durationSeconds);
  if (!Number.isFinite(rounded)) return KIE_DURATION_MIN;
  return Math.min(KIE_DURATION_MAX, Math.max(KIE_DURATION_MIN, rounded));
}

export function kieMinimaxH3AspectRatio(
  aspectRatio: string | undefined,
): string {
  return aspectRatio && KIE_T2V_ASPECTS.has(aspectRatio)
    ? aspectRatio
    : KIE_T2V_DEFAULT_ASPECT;
}

/** image-to-video: sem aspect_ratio (segue a imagem). */
export function buildKieMinimaxH3ImageToVideoInput(params: {
  prompt: string;
  imageUrl: string;
  lastImageUrl?: string;
  durationSeconds: number;
}): Record<string, unknown> {
  const input: Record<string, unknown> = {
    prompt: params.prompt,
    first_frame_url: params.imageUrl,
    duration: kieMinimaxH3Duration(params.durationSeconds),
    resolution: KIE_RESOLUTION,
  };
  if (params.lastImageUrl) input.last_frame_url = params.lastImageUrl;
  return input;
}

export function buildKieMinimaxH3TextToVideoInput(params: {
  prompt: string;
  durationSeconds: number;
  aspectRatio?: string;
}): Record<string, unknown> {
  return {
    prompt: params.prompt,
    duration: kieMinimaxH3Duration(params.durationSeconds),
    aspect_ratio: kieMinimaxH3AspectRatio(params.aspectRatio),
    resolution: KIE_RESOLUTION,
  };
}

function isKieModeration(failCode: string, failMsg: string): boolean {
  return (
    KIE_MODERATION_FAIL_CODES.has(failCode) ||
    isMinimaxH3ContentRefusal(failMsg)
  );
}

/**
 * Moderação da kie sobe como ContentSafetyError, com o texto do provedor e o código: um 430 de texto vago ("Generation
 * failed") ou vazio ainda é lido como bloqueio pelo processor, pela classificação e pelo desvio.
 */
function kieModerationError(text: string, code: string): ContentSafetyError {
  const base = text.trim() || 'content moderation';
  const message = code && !base.endsWith(`(${code})`) ? `${base} (${code})` : base;
  return new ContentSafetyError(message, code || undefined);
}

/** Cliente do MiniMax H3 na kie: cria a tarefa e espera a URL do vídeo (a re-hospedagem fica com o provider). */
export class KieMinimaxH3Client {
  private readonly logger = new Logger(KieMinimaxH3Client.name);

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly messages: KieMinimaxH3FailureMessages,
  ) {}

  /**
   * Cria a tarefa e devolve o taskId. Recusa da kie e rede antes do envio saem como falha segura de início; o que pode
   * ter criado a tarefa (timeout, conexão caída no meio, 2xx ilegível ou sem taskId) sai como MinimaxH3UncertainStartError.
   */
  async createTask(
    model: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchWithTimeout(
        `${this.baseUrl}/api/v1/jobs/createTask`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ model, input }),
        },
        60_000,
      );
    } catch (error) {
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      this.logger.error(`kie ${model} createTask network error: ${detail}`);
      const failure = new ProviderFailureError(
        this.messages.unavailable,
        `network ${detail.slice(0, 200)}`,
      );
      throw isPreSendNetworkError(error)
        ? failure
        : new MinimaxH3UncertainStartError(failure);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(
        `kie ${model} createTask failed status=${response.status} body=${body.slice(0, 300)}`,
      );
      const status = String(response.status);
      if (isKieModeration(status, body))
        throw kieModerationError(body.slice(0, 500), status);
      throw new ProviderFailureError(
        this.messages.unavailable,
        `${response.status} ${body.slice(0, 300)}`,
      );
    }

    let payload: KieCreateTaskResponse;
    try {
      payload = (await response.json()) as KieCreateTaskResponse;
    } catch {
      throw new MinimaxH3UncertainStartError(
        new ProviderFailureError(
          this.messages.unexpected,
          'kie createTask: resposta sem JSON',
        ),
      );
    }
    const taskId = payload.data?.taskId;
    if (payload.code === 200 && taskId) return taskId;

    // A kie responde 200 no HTTP e manda o erro no corpo (402 sem saldo, 422 parâmetro, 430 moderação…).
    const msg = payload.msg ?? '';
    const code = String(payload.code ?? '');
    this.logger.error(
      `kie ${model} createTask refused code=${code} msg=${msg.slice(0, 300)}`,
    );
    if (isKieModeration(code, msg)) throw kieModerationError(msg, code);
    const failure = new ProviderFailureError(
      payload.code === 200
        ? this.messages.unexpected
        : this.messages.unavailable,
      `code ${code} ${msg.slice(0, 300)}`.trim(),
    );
    // code 200 sem taskId: a kie aceitou o pedido, a tarefa pode existir.
    throw payload.code === 200
      ? new MinimaxH3UncertainStartError(failure)
      : failure;
  }

  /** Espera a tarefa terminar e devolve a URL do vídeo na kie. */
  async waitForResult(taskId: string): Promise<string> {
    let transientStreak = 0;

    for (let attempt = 0; attempt < KIE_POLL_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await this.wait(KIE_POLL_INTERVAL_MS);

      let payload: KieRecordInfoResponse | null = null;
      let transientDetail = '';
      try {
        const response = await this.fetchWithTimeout(
          `${this.baseUrl}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
          { headers: this.headers() },
          30_000,
        );
        if (response.ok) {
          payload = (await response.json()) as KieRecordInfoResponse;
        } else {
          const body = await response.text().catch(() => '');
          transientDetail = `${response.status} ${body.slice(0, 200)}`;
        }
      } catch (error) {
        transientDetail = `network ${
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error)
        }`.slice(0, 200);
      }

      const data = payload?.data;
      if (!data) {
        transientStreak++;
        const detail =
          transientDetail || `sem dado: ${payload?.msg ?? ''}`.trim();
        if (transientStreak >= KIE_POLL_TRANSIENT_MAX) {
          this.logger.error(
            `kie recordInfo unreachable taskId=${taskId} after ${transientStreak} tries: ${detail}`,
          );
          throw new ProviderFailureError(this.messages.unavailable, detail);
        }
        this.logger.warn(
          `kie recordInfo taskId=${taskId} (${transientStreak}/${KIE_POLL_TRANSIENT_MAX}): ${detail}`,
        );
        continue;
      }
      transientStreak = 0;

      if (data.state === 'success')
        return this.resultUrlOf(taskId, data.resultJson);

      if (data.state === 'fail') {
        const failMsg = data.failMsg ?? payload?.msg ?? '';
        const failCode = data.failCode == null ? '' : String(data.failCode);
        // 430 sem texto ainda precisa ser lido como moderação pela classificação do motivo.
        const failText =
          failMsg ||
          (KIE_MODERATION_FAIL_CODES.has(failCode)
            ? 'content moderation'
            : 'unknown error');
        const fullMessage = `${failText}${failCode ? ` (${failCode})` : ''}`;
        this.logger.error(`kie task failed taskId=${taskId}: ${fullMessage}`);
        // Moderação sai com o texto do provedor, como o 'failed' da WaveSpeed, mas como ContentSafetyError: um 430 de
        // texto vago ("Generation failed") também conta como bloqueio, como no Seedream.
        if (isKieModeration(failCode, failMsg))
          throw kieModerationError(fullMessage, failCode);
        throw new ProviderFailureError(this.messages.failed, fullMessage);
      }

      this.logger.debug(
        `kie task ${taskId} ${data.state ?? 'sem estado'} (attempt ${attempt + 1}/${KIE_POLL_MAX_ATTEMPTS})`,
      );
    }

    throw new Error(this.messages.tooSlow);
  }

  private resultUrlOf(taskId: string, resultJson: string | undefined): string {
    if (!resultJson) throw new Error(this.messages.missingOutput);
    let urls: unknown;
    try {
      urls = (JSON.parse(resultJson) as { resultUrls?: unknown }).resultUrls;
    } catch (error) {
      this.logger.error(
        `kie resultJson inválido taskId=${taskId}: ${(error as Error).message}`,
      );
      throw new ProviderFailureError(
        this.messages.missingOutput,
        `resultJson inválido: ${resultJson.slice(0, 200)}`,
      );
    }
    const first: unknown = Array.isArray(urls)
      ? (urls as unknown[])[0]
      : undefined;
    if (typeof first !== 'string' || !first) {
      throw new Error(this.messages.missingOutput);
    }
    return first;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }
}
