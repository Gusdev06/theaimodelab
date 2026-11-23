import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import * as sharp from 'sharp';
import { UploadsService } from '../../uploads/uploads.service';
import { GenerationResult } from './theaimodelab.provider';
import {
  ContentSafetyError,
  isMinorSafetyBlock,
} from '../errors/content-safety.error';
import { isMinorRefusal } from '../errors/minor-refusal';
import {
  ultraRealismEnabled,
  ultraRealismFor,
} from '../../content-safety/ultra-realism';
import { ProviderFailureError } from '../errors/failure-reason';
import { adultSafePrompt } from '../../content-safety/adult-anchor';
import {
  QUALITY_EDIT_PROMPT,
  isQualityOnlyEditRequest,
  qualityEditLockEnabled,
} from '../quality-edit';

// Seedream V5.0 Pro na KIE (api.kie.ai). Sem imagem de referência usamos o
// modelo text-to-image; com imagem(ns), o modelo image-to-image (edição).
// Reutiliza a mesma conta/credenciais da KIE (NANO_BANANA_*), como o
// SeedreamLiteProvider — não há env própria.
const KIE_MODEL_T2I = 'seedream/5-pro-text-to-image';
const KIE_MODEL_I2I = 'seedream/5-pro-image-to-image';

// Motor do Unlocked (13/11/2026): o Seedream 5 Lite, na mesma conta da KIE, custa bem menos que o Pro. Fica atrás de
// UNLOCKED_ENGINE=lite, com canário por usuário (UNLOCKED_ENGINE_CANARY_PCT, padrão 100 quando o motor é lite) e o
// Pro como reserva automática se o Lite falhar ou recusar (recusa por menor nunca é refeita). Sem a env = Pro, igual
// a antes. Só vale para quem pede (`engineSwapEligible`): Unlocked direto e desvio de segurança; troca de rosto e
// Undress seguem no Pro.
const KIE_LITE_T2I = 'seedream/5-lite-text-to-image';
const KIE_LITE_I2I = 'seedream/5-lite-image-to-image';
// Seedream 5.5 no Unlocked SÓ TEXTO (UNLOCKED_ENGINE_T2I=s55): US$ 0,0315 em 2K contra US$ 0,07 do Pro; bancada de
// 13/11: 32/32 entregues, 0 recusa, 26 s de mediana. Só sem foto: na edição a kie cobra cada imagem de entrada à parte.
const KIE_S55_T2I = 'seedream/5-5-text-to-image';
// Seedream 5.5 na EDIÇÃO COM FOTO (UNLOCKED_ENGINE_I2I_S55_PCT, 19/11/2026). Custo real por tarefa na kie
// (creditsConsumed): 5.5 = 6,3 créditos + ~1,44 por foto de entrada (1 foto 7,74; 4 fotos 12,06); Pro = 14 fixo.
// Até 5 fotos o 5.5 sai mais barato; com 6 ou mais fica no Pro (prejuízo zero). Bancada de 19/11: 33/33, 0 recusa,
// mediana 21 s contra ~40 s do Pro. Artificial Analysis (edição): 5.5 Elo 1160 × Pro 1132.
const KIE_S55_I2I = 'seedream/5-5-image-to-image';
export const S55_EDIT_MAX_IMAGES = 5;
export type UnlockedEngine = 'pro' | 'lite' | 's55';

/**
 * Desvio de segurança que pode rodar no motor alternativo do Unlocked: só o das imagens (processImage*,
 * processNanoBanana). Troca de rosto e provador ficam no Pro, e o desvio do próprio Seedream Lite também (mandar de
 * volta ao Lite que acabou de recusar é chamada perdida).
 */
export function isUnlockedEngineSwapContext(context: string): boolean {
  return (
    /^process(Image|NanoBanana)/.test(context) &&
    !context.endsWith(':seedream-5-lite')
  );
}

// Reserva do Unlocked na PRÓPRIA kie (TKT-310, 16/11/2026). Falha técnica (início recusado, erro, tempo esgotado,
// download) no motor principal refaz UMA vez em outro motor Seedream da kie: Pro → 5.5 no só-texto / Lite na edição;
// Lite ou 5.5 → Pro. Recusa de conteúdo (menor inclusive) segue terminal. Substitui o plano B na WaveSpeed (TKT-216),
// que levava edição explícita a um provedor que proíbe explícito (TKT-265); a env UNLOCKED_WAVESPEED_FALLBACK deixou
// de ser lida. Em 7 dias até 16/11: 23 Unlocked morreram no cron (~28 min) sem alternativa e 12 por erro técnico.
//
// Prazo de relógio por tentativa: as duas cabem antes do cron de travadas (imagem = 20 min de processamento, varre a
// cada 15). Pro concluído em 7 dias: p99 139 s, máximo 244 s; Lite p99 76 s; 5.5 p99 30 s.
const PRIMARY_DEADLINE_MS: Record<UnlockedEngine, number> = {
  pro: 5 * 60_000,
  // o Lite e o 5.5 respondem em ~40 s: espera curta (~3 min) para o Pro ainda caber no prazo do cron
  lite: 3 * 60_000,
  s55: 3 * 60_000,
};
const RESERVE_DEADLINE_MS: Record<UnlockedEngine, number> = {
  pro: 8 * 60_000,
  lite: 4 * 60_000,
  s55: 4 * 60_000,
};

// KIE Seedream Pro: `quality` basic → 1K, high → 2K (não há 4K).
const QUALITY_MAP: Record<string, 'basic' | 'high'> = {
  RES_1K: 'basic',
  RES_2K: 'high',
  RES_4K: 'high', // legado -> tier máximo disponível
};

// Códigos de fail retornados pela KIE que indicam moderação de conteúdo.
const SEEDREAM_SAFETY_FAIL_CODES = new Set(['430']);

// Proporções suportadas pela KIE Seedream Pro. O valor numérico é usado para
// casar com a proporção da imagem de entrada quando o request não especifica
// aspect (antigo `match_input_image` da WaveSpeed).
const SUPPORTED_ASPECTS: { label: string; ratio: number }[] = [
  { label: '1:1', ratio: 1 },
  { label: '4:3', ratio: 4 / 3 },
  { label: '3:4', ratio: 3 / 4 },
  { label: '16:9', ratio: 16 / 9 },
  { label: '9:16', ratio: 9 / 16 },
  { label: '3:2', ratio: 3 / 2 },
  { label: '2:3', ratio: 2 / 3 },
  { label: '21:9', ratio: 21 / 9 },
];
const SUPPORTED_ASPECT_LABELS = new Set(SUPPORTED_ASPECTS.map((a) => a.label));

const SAFETY_INSTRUCTION =
  'The subject is fully clothed in complete, opaque everyday attire that covers the chest, torso, ' +
  'hips, and groin. Clothing fits naturally and is not see-through. Swimwear, lingerie, and ' +
  'fashion-forward outfits are allowed when the prompt asks for them, as long as the chest, nipples, ' +
  'groin, and buttocks remain fully covered by opaque fabric.';

// Limite defensivo de tamanho do prompt (KIE Seedream Pro aceita até 5000 chars).
const MAX_PROMPT_LENGTH = 5000;

/** Recusa de conteúdo (menor inclusive): terminal, nunca vai à reserva. */
function isContentRefusal(error: unknown): boolean {
  return (
    error instanceof ContentSafetyError ||
    isMinorSafetyBlock(error) ||
    isMinorRefusal(error)
  );
}

function applySafetyWrapper(prompt: string): string {
  const separator = '\n\n';
  // Orçamento disponível para o prompt do usuário, descontando o wrapper de segurança
  // (que é fixo e não pode ser cortado, sob pena de perder a instrução de segurança).
  const reserved = separator.length + SAFETY_INSTRUCTION.length;
  const maxUserPrompt = MAX_PROMPT_LENGTH - reserved;

  const trimmed = prompt.trim().slice(0, Math.max(0, maxUserPrompt));
  return `${trimmed}${separator}${SAFETY_INSTRUCTION}`;
}

// User-facing error messages (never expose provider name or technical detail)
const USER_ERRORS = {
  configMissing:
    'Serviço de geração indisponível no momento. Tente novamente em instantes.',
  startFailed:
    'Não foi possível iniciar a geração. Tente novamente em instantes.',
  generationFailed: 'Não foi possível gerar a imagem. Tente novamente.',
  statusCheckFailed: 'Falha ao verificar o status da geração. Tente novamente.',
  noOutput:
    'A geração foi concluída, mas não retornou imagens. Tente novamente.',
  timeout: 'A geração demorou mais que o esperado. Tente novamente.',
  downloadFailed: 'Falha ao baixar a imagem gerada. Tente novamente.',
  noImages: 'Nenhuma imagem foi gerada. Tente novamente.',
};

export interface SeedreamImageInput {
  id: string;
  prompt: string;
  resolution: string;
  aspectRatio?: string;
  imageUrls?: string[];
  /**
   * Pula o wrapper de segurança (que força roupa no personagem). Usado no fluxo
   * de undress, onde o prompt explícito precisa passar intacto.
   */
  skipSafetyWrapper?: boolean;
  /** Tag salva em `modelUsed` (default `sem-censura`; undress usa `deepdeep`). */
  modelUsedTag?: string;
  /** Pode rodar no motor alternativo do Unlocked (UNLOCKED_ENGINE). Só Unlocked direto e desvio de segurança. */
  engineSwapEligible?: boolean;
  /** Chave do canário (o id do usuário): a mesma pessoa cai sempre no mesmo motor. Sem ela, usa o id da geração. */
  canaryKey?: string;
}

/** Resultado do Seedream com o motor que de fato gerou (para o custo por motor no cockpit). */
export interface SeedreamGenerationResult extends GenerationResult {
  engine: UnlockedEngine;
}

interface CreateTaskResponse {
  code: number;
  msg: string;
  data: { taskId: string } | null;
}

interface RecordInfoResponse {
  code: number;
  msg: string;
  data: {
    taskId: string;
    model: string;
    state: 'waiting' | 'queuing' | 'generating' | 'success' | 'fail';
    param?: string;
    resultJson?: string;
    failCode?: string;
    failMsg?: string;
    costTime?: number;
    completeTime?: number;
    createTime?: number;
    updateTime?: number;
  } | null;
}

interface ResultJsonPayload {
  resultUrls?: string[];
}

@Injectable()
export class SeedreamProvider {
  private readonly logger = new Logger(SeedreamProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly unlockedEngine: UnlockedEngine;
  private readonly unlockedCanaryPct: number;
  private readonly unlockedScope: 'all' | 'i2i';
  private readonly unlockedTextEngine: 'default' | 's55';
  private readonly unlockedEditS55Pct: number;
  private readonly ultraRealism: boolean;
  private readonly qualityEditLock: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly uploadsService: UploadsService,
  ) {
    this.baseUrl = this.configService.get<string>(
      'NANO_BANANA_BASE_URL',
      'https://api.kie.ai',
    );
    this.apiKey = (
      this.configService.get<string>('NANO_BANANA_API_KEY', '') ?? ''
    ).trim();
    const engineFlag = String(
      this.configService.get<string>('UNLOCKED_ENGINE', '') ?? '',
    )
      .trim()
      .toLowerCase();
    this.unlockedEngine = engineFlag === 'lite' ? 'lite' : 'pro';
    const pctRaw = String(
      this.configService.get<string>('UNLOCKED_ENGINE_CANARY_PCT', '') ?? '',
    ).trim();
    // Sem valor (ou inválido) = 0%: o canário precisa ser dito por extenso (env em branco no painel nunca vira "todos").
    const pct = /^\d{1,3}$/.test(pctRaw) ? Number(pctRaw) : 0;
    this.unlockedCanaryPct = Math.min(100, pct);
    // Escopo: 'i2i' = só edição com foto (no voto cego do dono, 13/11, o Lite empatou com o Pro na edição e perdeu
    // no só-texto). Padrão 'all', o comportamento do PR #43.
    const scopeFlag = String(
      this.configService.get<string>('UNLOCKED_ENGINE_SCOPE', '') ?? '',
    )
      .trim()
      .toLowerCase();
    this.unlockedScope = scopeFlag === 'i2i' ? 'i2i' : 'all';
    const textFlag = String(
      this.configService.get<string>('UNLOCKED_ENGINE_T2I', '') ?? '',
    )
      .trim()
      .toLowerCase();
    this.unlockedTextEngine = textFlag === 's55' ? 's55' : 'default';
    // Canário próprio da edição no 5.5: vazio ou inválido = 0% (precisa ser dito por extenso, como o do Lite).
    const editS55Raw = String(
      this.configService.get<string>('UNLOCKED_ENGINE_I2I_S55_PCT', '') ?? '',
    ).trim();
    this.unlockedEditS55Pct = /^\d{1,3}$/.test(editS55Raw)
      ? Math.min(100, Number(editS55Raw))
      : 0;
    this.ultraRealism = ultraRealismEnabled(
      this.configService.get<string>('ULTRA_REALISM_PROMPTS', ''),
    );
    this.qualityEditLock = qualityEditLockEnabled(
      this.configService.get<string>('UNLOCKED_QUALITY_EDIT_LOCK', ''),
    );
    if (this.unlockedEditS55Pct > 0) {
      this.logger.log(
        `[UNLOCKED_ENGINE] edição com foto no 5.5: ${this.unlockedEditS55Pct}% (até ${S55_EDIT_MAX_IMAGES} fotos; acima disso, Pro)`,
      );
    }
    if (this.unlockedEngine === 'lite' || this.unlockedTextEngine === 's55') {
      this.logger.log(
        `[UNLOCKED_ENGINE] edição=${this.unlockedEngine === 'lite' ? 'lite' : 'pro'} só-texto=${this.unlockedTextEngine === 's55' ? 's55' : this.unlockedEngine === 'lite' && this.unlockedScope === 'all' ? 'lite' : 'pro'} canário=${this.unlockedCanaryPct}% escopo=${this.unlockedScope}${this.unlockedCanaryPct === 0 ? ' (UNLOCKED_ENGINE_CANARY_PCT vazio ou inválido: ninguém no Lite)' : ''}`,
      );
    }
    if (!this.apiKey) {
      this.logger.warn(
        'NANO_BANANA_API_KEY (KIE) is not set. Image generation will fail with a 401 from the provider.',
      );
    }
  }

  async generateImage(
    input: SeedreamImageInput,
  ): Promise<SeedreamGenerationResult> {
    if (!this.apiKey) {
      this.logger.error('NANO_BANANA_API_KEY (KIE) is not configured.');
      throw new Error(USER_ERRORS.configMissing);
    }

    const engine = this.pickEngine(input);
    let primaryError: unknown;
    try {
      return await this.generateOnKie(
        input,
        engine,
        PRIMARY_DEADLINE_MS[engine],
      );
    } catch (error) {
      // Recusa de CONTEÚDO é terminal em qualquer motor: a reserva não vira "segunda opinião" (com o nsfw_checker
      // desligado, o que sobra de moderação é o duro: menor, CSAM, pessoa real). Só a falha técnica (saldo, rede, 5xx,
      // tempo, upload) refaz na reserva.
      if (isContentRefusal(error)) throw error;
      primaryError = error;
    }

    const reserve = this.reserveEngine(engine, input);
    this.logger.warn(
      `[UNLOCKED_RESERVA] gen=${input.id} o motor ${engine} não entregou (${(primaryError as Error).message}); reserva na kie: ${reserve}`,
    );
    try {
      return await this.generateOnKie(
        input,
        reserve,
        RESERVE_DEADLINE_MS[reserve],
      );
    } catch (reserveError) {
      // A recusa da reserva (menor inclusive) é o motivo que vale; a falha técnica dela não esconde a do principal.
      if (isContentRefusal(reserveError)) throw reserveError;
      this.logger.error(
        `[UNLOCKED_RESERVA] gen=${input.id} a reserva ${reserve} também falhou: ${(reserveError as Error).message}`,
      );
      throw primaryError;
    }
  }

  /**
   * Motor da reserva: Lite ou 5.5 caem no Pro; o Pro cai no 5.5 no só-texto (o mais barato, 0 recusa na bancada de
   * 13/11) e no Lite na edição com foto (o 5.5 cobra cada imagem de entrada à parte).
   */
  reserveEngine(
    primary: UnlockedEngine,
    input: Pick<SeedreamImageInput, 'imageUrls'>,
  ): UnlockedEngine {
    if (primary !== 'pro') return 'pro';
    return input.imageUrls?.length ? 'lite' : 's55';
  }

  /**
   * Motor desta geração. Pro, salvo quando UNLOCKED_ENGINE=lite, a chamada aceita troca de motor e a pessoa (canaryKey)
   * cai dentro do canário. O sorteio é estável: o mesmo usuário vê sempre o mesmo motor.
   */
  pickEngine(input: SeedreamImageInput): UnlockedEngine {
    if (!input.engineSwapEligible) return 'pro';
    const hasImages = !!input.imageUrls?.length;
    if (
      hasImages &&
      this.unlockedEditS55Pct > 0 &&
      (input.imageUrls?.length ?? 0) <= S55_EDIT_MAX_IMAGES &&
      this.inCanary(input, 'unlocked-edit-s55', this.unlockedEditS55Pct)
    )
      return 's55';
    let candidate: UnlockedEngine = 'pro';
    if (!hasImages && this.unlockedTextEngine === 's55') candidate = 's55';
    else if (
      this.unlockedEngine === 'lite' &&
      (this.unlockedScope === 'all' || hasImages)
    )
      candidate = 'lite';
    if (candidate === 'pro') return 'pro';
    if (this.unlockedCanaryPct >= 100) return candidate;
    if (this.unlockedCanaryPct <= 0) return 'pro';
    return this.inCanary(input, 'unlocked-engine', this.unlockedCanaryPct)
      ? candidate
      : 'pro';
  }

  /** Sorteio estável por pessoa (canaryKey): o mesmo usuário cai sempre do mesmo lado. */
  private inCanary(
    input: SeedreamImageInput,
    salt: string,
    pct: number,
  ): boolean {
    if (pct >= 100) return true;
    if (pct <= 0) return false;
    const digest = createHash('sha256')
      .update(`${salt}:${input.canaryKey || input.id}`)
      .digest();
    return digest.readUInt32BE(0) % 100 < pct;
  }

  private async generateOnKie(
    input: SeedreamImageInput,
    engine: UnlockedEngine,
    deadlineMs: number,
  ): Promise<SeedreamGenerationResult> {
    const deadline = Date.now() + deadlineMs;
    const hasImages = !!input.imageUrls?.length;
    // Pro: basic = 1K, high = 2K. Lite: basic = 2K (high = 3K): o Lite sempre em 2K, a resolução do Unlocked.
    const quality =
      engine === 'lite' ? 'basic' : (QUALITY_MAP[input.resolution] ?? 'high');
    const model =
      engine === 's55'
        ? hasImages
          ? KIE_S55_I2I
          : KIE_S55_T2I
        : engine === 'lite'
          ? hasImages
            ? KIE_LITE_I2I
            : KIE_LITE_T2I
          : hasImages
            ? KIE_MODEL_I2I
            : KIE_MODEL_T2I;
    // o 5.5 usa `size` (1K/1.5K/2K) no lugar de `quality`; o Unlocked sai sempre em 2K nele
    const sizing = engine === 's55' ? { size: '2K' } : { quality };

    // Prompt: o modelo sem censura (skipSafetyWrapper: Unlocked, despir, desvio de segurança) recebe o pedido com a
    // âncora de adulto (toda pessoa gerada é adulta; gíria de juventude vira "mulher adulta"); o resto ganha o wrapper
    // que mantém o personagem vestido.
    // Ultra-realismo (ULTRA_REALISM_PROMPTS, dono 13/11) só no motor sem censura e só em pedido não estilizado. O bloco
    // vai no fim e o teto corta o texto da cliente, nunca o bloco nem a âncora de adulto.
    // Pedido só de qualidade numa foto ("Upscale", "dar nitidez", TKT-373): vira edição que preserva a pessoa, a pose e
    // o quadro, sem o bloco de ultra-realismo (que manda refazer a pele) e na proporção da própria foto (o seletor da
    // tela esticava a imagem). UNLOCKED_QUALITY_EDIT_LOCK=off volta ao texto cru.
    const qualityEdit =
      this.qualityEditLock &&
      hasImages &&
      !!input.skipSafetyWrapper &&
      isQualityOnlyEditRequest(input.prompt);
    const promptForModel = qualityEdit ? QUALITY_EDIT_PROMPT : input.prompt;
    const realism =
      input.skipSafetyWrapper && !qualityEdit
        ? ultraRealismFor(this.ultraRealism, input.prompt)
        : '';
    const finalPrompt = input.skipSafetyWrapper
      ? realism
        ? `${adultSafePrompt(promptForModel, MAX_PROMPT_LENGTH - realism.length - 2)}\n\n${realism}`
        : adultSafePrompt(promptForModel, MAX_PROMPT_LENGTH)
      : applySafetyWrapper(input.prompt);

    // KIE exige aspect_ratio fixo (não tem `match_input_image`). Quando o request
    // não define (ou é pedido só de qualidade), derivamos da proporção da 1ª imagem de entrada.
    // Na edição de qualidade, a proporção da foto; se a leitura falhar, a que a cliente escolheu (nunca 1:1 às cegas).
    const aspectRatio =
      (qualityEdit ? await this.aspectFromInputImage(input) : null) ??
      (await this.resolveAspectRatio(input));

    if (qualityEdit) {
      this.logger.log(
        `[UNLOCKED_NITIDEZ] gen=${input.id} pedido só de qualidade ("${input.prompt.slice(0, 60)}"): edição que preserva rosto e quadro, aspect da foto=${aspectRatio} (pedido=${input.aspectRatio ?? '-'})`,
      );
    }
    this.logger.log(
      `[SEEDREAM_PRO] engine=${engine} mode=${hasImages ? 'image-to-image' : 'text-to-image'} quality=${quality} aspectRatio=${aspectRatio} images=${input.imageUrls?.length ?? 0} skipSafety=${!!input.skipSafetyWrapper} prompt="${input.prompt.slice(0, 120)}"`,
    );

    const body = {
      model,
      input: {
        prompt: finalPrompt,
        aspect_ratio: aspectRatio,
        ...sizing,
        // JPEG em todos os motores: sem isso o Lite devolve PNG de ~5 MB (testado em 13/11: com jpeg, ~400 KB)
        output_format: 'jpeg',
        // Este é o provider "sem-censura" (undress / face-swap unlocked /
        // fallback de segurança) — nunca bloqueamos no checker da KIE.
        nsfw_checker: false,
        ...(hasImages ? { image_urls: input.imageUrls } : {}),
      },
    };

    // o texto do provedor vai junto no erro de início (ProviderFailureError) para a trava de menor ler antes da reserva
    const taskId = await this.submitTask(body);
    this.logger.log(
      `[SEEDREAM_PRO] engine=${engine} task submitted: ${taskId}`,
    );

    const resultUrls = await this.pollTaskStatus(taskId, deadline);
    this.logger.log(
      `[SEEDREAM_PRO] Task ${taskId} completed — resultUrls=${resultUrls.length}`,
    );

    const outputUrls: string[] = [];
    for (let i = 0; i < resultUrls.length; i++) {
      const url = await this.downloadAndUpload(resultUrls[i], input.id, i);
      outputUrls.push(url);
    }

    if (!outputUrls.length) {
      throw new Error(USER_ERRORS.noImages);
    }

    this.logger.log(`${outputUrls.length} image(s) uploaded to S3`);
    return {
      outputUrls,
      modelUsed: input.modelUsedTag ?? 'sem-censura',
      engine,
    };
  }

  /**
   * Resolve o `aspect_ratio` para um dos valores suportados pela KIE. Se o
   * request especifica uma proporção válida, usa direto; caso contrário (vazio
   * ou `match_input_image`), casa com a proporção da 1ª imagem de entrada.
   */
  private async resolveAspectRatio(input: SeedreamImageInput): Promise<string> {
    const requested = input.aspectRatio?.trim();

    if (requested && requested !== 'match_input_image') {
      if (SUPPORTED_ASPECT_LABELS.has(requested)) return requested;
      const parsed = this.parseRatio(requested);
      if (parsed) return this.nearestAspect(parsed);
      return '1:1';
    }

    // Sem aspect explícito: deriva da imagem de entrada (preserva o comportamento
    // `match_input_image` da WaveSpeed, essencial no undress/face-swap).
    return (await this.aspectFromInputImage(input)) ?? '1:1';
  }

  /** Proporção suportada mais próxima da 1ª foto de entrada; null sem foto ou se a leitura falhar. */
  private async aspectFromInputImage(
    input: Pick<SeedreamImageInput, 'imageUrls'>,
  ): Promise<string | null> {
    const firstUrl = input.imageUrls?.[0];
    if (!firstUrl) return null;
    try {
      const ratio = await this.readImageAspect(firstUrl);
      return ratio ? this.nearestAspect(ratio) : null;
    } catch (error) {
      this.logger.warn(
        `[SEEDREAM_PRO] Could not read input image dimensions: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async readImageAspect(url: string): Promise<number | null> {
    const response = await this.fetchWithTimeout(url, {}, 30_000);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) return null;
    return meta.width / meta.height;
  }

  private nearestAspect(ratio: number): string {
    let best = SUPPORTED_ASPECTS[0];
    let bestDiff = Infinity;
    for (const aspect of SUPPORTED_ASPECTS) {
      // Diferença em escala logarítmica → mais perceptualmente correta.
      const diff = Math.abs(Math.log(aspect.ratio) - Math.log(ratio));
      if (diff < bestDiff) {
        bestDiff = diff;
        best = aspect;
      }
    }
    return best.label;
  }

  private parseRatio(value: string): number | null {
    const match = value.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!match) return null;
    const w = parseFloat(match[1]);
    const h = parseFloat(match[2]);
    if (!w || !h) return null;
    return w / h;
  }

  private async submitTask(body: Record<string, unknown>): Promise<string> {
    const url = `${this.baseUrl}/api/v1/jobs/createTask`;

    // Retry once em erros transientes (429/5xx).
    const maxAttempts = 2;
    const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
    let lastErrorText = '';
    let lastStatus = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
        },
        60_000,
      );

      if (response.ok) {
        const data = (await response.json()) as CreateTaskResponse;
        if (data.code === 200 && data.data?.taskId) {
          return data.data.taskId;
        }
        // Moderação de conteúdo devolvida no corpo -> ContentSafetyError.
        const safetyError = ContentSafetyError.fromErrorMessage(data.msg);
        if (safetyError) throw safetyError;
        this.logger.error(
          `[SEEDREAM_PRO] createTask failed: ${data.msg} (code ${data.code})`,
        );
        throw this.startError(`${data.msg} (code ${data.code})`);
      }

      lastStatus = response.status;
      lastErrorText = await response.text();

      const safetyError = ContentSafetyError.fromErrorMessage(lastErrorText);
      if (safetyError) throw safetyError;

      if (attempt < maxAttempts && transientStatuses.has(response.status)) {
        this.logger.warn(
          `[SEEDREAM_PRO_RETRY] createTask attempt=${attempt}/${maxAttempts} status=${response.status} body=${lastErrorText.slice(0, 200)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue;
      }
      break;
    }

    this.logger.error(
      `[SEEDREAM_PRO] createTask failed status=${lastStatus} body=${lastErrorText}`,
    );
    throw this.startError(
      `status=${lastStatus} ${lastErrorText.slice(0, 500)}`,
    );
  }

  /**
   * Erro de início com o texto do provedor (ProviderFailureError.providerDetail): a trava de menor o lê antes de
   * decidir ir à reserva. A mensagem para a cliente segue a genérica.
   */
  private startError(providerDetail: string) {
    return new ProviderFailureError(USER_ERRORS.startFailed, providerDetail);
  }

  /** Espera a tarefa até o prazo de relógio (`deadline`, epoch ms): passou dele = tempo esgotado, vai à reserva. */
  private async pollTaskStatus(
    taskId: string,
    deadline: number,
    intervalMs = 4_000,
  ): Promise<string[]> {
    const maxNetworkRetries = 5;
    let networkFailures = 0;

    for (let attempt = 0; Date.now() < deadline; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        if (Date.now() >= deadline) break;
      }

      const url = `${this.baseUrl}/api/v1/jobs/recordInfo?taskId=${taskId}`;
      let response: Response;
      try {
        response = await this.fetchWithTimeout(
          url,
          { headers: this.headers() },
          30_000,
        );
        networkFailures = 0;
      } catch (error) {
        networkFailures++;
        this.logger.warn(
          `[SEEDREAM_PRO POLL] Fetch failed (${networkFailures}/${maxNetworkRetries}): ${(error as Error).message}`,
        );
        if (networkFailures >= maxNetworkRetries) {
          throw new Error(USER_ERRORS.statusCheckFailed);
        }
        continue;
      }

      if (!response.ok) {
        networkFailures++;
        const errorText = await response.text();
        this.logger.warn(
          `[SEEDREAM_PRO POLL] HTTP error ${response.status} (${networkFailures}/${maxNetworkRetries}): ${errorText}`,
        );
        if (networkFailures >= maxNetworkRetries) {
          const safetyError = ContentSafetyError.fromErrorMessage(errorText);
          if (safetyError) throw safetyError;
          throw new Error(USER_ERRORS.statusCheckFailed);
        }
        continue;
      }

      networkFailures = 0;
      const data = (await response.json()) as RecordInfoResponse;

      if (!data.data) {
        this.logger.debug(
          `[SEEDREAM_PRO POLL] No data in response (attempt ${attempt + 1})`,
        );
        continue;
      }

      const { state } = data.data;

      if (
        state === 'waiting' ||
        state === 'queuing' ||
        state === 'generating'
      ) {
        this.logger.debug(
          `[SEEDREAM_PRO POLL] state=${state} (attempt ${attempt + 1})`,
        );
        continue;
      }

      if (state === 'fail') {
        const failMsg = data.data.failMsg ?? data.msg ?? 'unknown error';
        const failCode = data.data.failCode ?? '';
        const fullMessage = `${failMsg}${failCode ? ` (${failCode})` : ''}`;

        if (
          SEEDREAM_SAFETY_FAIL_CODES.has(failCode) ||
          ContentSafetyError.fromErrorMessage(failMsg)
        ) {
          throw new ContentSafetyError(fullMessage, failCode || undefined);
        }

        this.logger.error(`[SEEDREAM_PRO] Prediction failed: ${fullMessage}`);
        // texto amigável pro usuário, motivo técnico preservado pra classificação
        throw new ProviderFailureError(
          USER_ERRORS.generationFailed,
          fullMessage,
        );
      }

      if (state === 'success') {
        if (!data.data.resultJson) {
          throw new Error(USER_ERRORS.noOutput);
        }

        let payload: ResultJsonPayload;
        try {
          payload = JSON.parse(data.data.resultJson) as ResultJsonPayload;
        } catch (err) {
          this.logger.error(
            `[SEEDREAM_PRO] Failed to parse resultJson: ${(err as Error).message}`,
          );
          throw new Error(USER_ERRORS.generationFailed);
        }

        const urls = payload.resultUrls ?? [];
        if (!urls.length) {
          throw new Error(USER_ERRORS.noOutput);
        }
        return urls;
      }
    }

    throw new Error(USER_ERRORS.timeout);
  }

  private async downloadAndUpload(
    sourceUrl: string,
    generationId: string,
    index: number,
  ): Promise<string> {
    const maxRetries = 3;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          this.logger.warn(
            `[SEEDREAM_PRO] Retrying downloadAndUpload (${attempt + 1}/${maxRetries}) for ${generationId}`,
          );
        }

        const response = await this.fetchWithTimeout(sourceUrl, {}, 60_000);
        if (!response.ok) {
          this.logger.error(
            `[SEEDREAM_PRO] Download failed (${response.status}): ${sourceUrl}`,
          );
          throw new Error(USER_ERRORS.downloadFailed);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const contentType =
          response.headers.get('content-type') ?? 'image/jpeg';
        const ext = contentType.includes('png') ? 'png' : 'jpg';

        return await this.uploadsService.uploadBuffer(
          buffer,
          `generations/${generationId}`,
          `output_${index}.${ext}`,
          contentType,
        );
      } catch (error) {
        lastError = error as Error;
      }
    }

    throw lastError!;
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
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }
}
