import { BadRequestException } from '@nestjs/common';
import { Resolution } from '@prisma/client';

/**
 * Motores do POST /generations/motion-control.
 *
 * - `kling` (padrão, como sempre foi): Kling 2.6 Motion Control na kie. A pessoa da FOTO faz o movimento do vídeo,
 *   no cenário do vídeo (`character_orientation: video`). Provedor com filtro: cena adulta é recusada.
 * - `wan-replace`: Wan 2.2 Animate na WaveSpeed, modo `replace`. A pessoa do VÍDEO é trocada pela da foto e todo o
 *   resto fica (movimento, cenário, câmera, luz). É a "troca de pessoa" que o Genspicy vende.
 * - `wan-animate`: Wan 2.2 Animate, modo `animate`. A foto ganha o movimento e as expressões do vídeo (o cenário é o
 *   da foto).
 *
 * O Wan cobra por segundo do vídeo de entrada (mínimo de 3 s) e não tem geração grátis.
 */
export type MotionControlEngine = 'kling' | 'wan-replace' | 'wan-animate';
export const MOTION_CONTROL_ENGINES: readonly MotionControlEngine[] = ['kling', 'wan-replace', 'wan-animate'];

/** Interruptor do admin (/admin/modelos) e o que o site lê em GET /models/videos para mostrar a opção. */
export const WAN_ANIMATE_SLUG = 'wan-animate';
/** Variante de cobrança (calculateGenerationCost) e o que o site manda em POST /credits/estimate. */
export const WAN_ANIMATE_MODEL_VARIANT = 'WAN_ANIMATE';
export const WAN_ANIMATE_MODEL = 'wavespeed-ai/wan-2.2/animate';

/**
 * Créditos por segundo: custo da WaveSpeed (US$ 0,04/s em 480p, US$ 0,08/s em 720p, conferido em 30/10/2026) × 3.333
 * (regra de preço da plataforma), arredondado para cima no múltiplo de 5.
 */
export const WAN_ANIMATE_CREDITS_PER_SECOND: Readonly<Partial<Record<Resolution, number>>> = {
  [Resolution.RES_480P]: 135,
  [Resolution.RES_720P]: 270,
};
/** A WaveSpeed cobra no mínimo 3 s e arredonda o vídeo de entrada para o segundo inteiro de cima. */
export const WAN_ANIMATE_MIN_BILLED_SECONDS = 3;
/** O texto do Wan é uma orientação curta ("mesma roupa, sem mudar o fundo"); o resto vem da foto e do vídeo. */
export const WAN_ANIMATE_PROMPT_MAX_LENGTH = 600;

export function isWanEngine(engine: MotionControlEngine): boolean {
  return engine === 'wan-replace' || engine === 'wan-animate';
}

export interface MotionControlRequest {
  engine: MotionControlEngine;
  /** modo do Wan; null no Kling */
  mode: 'replace' | 'animate' | null;
  /** como vai ao provedor */
  resolution: '480p' | '720p' | '1080p';
  dbResolution: Resolution;
  /** só o Wan usa texto; no Kling o campo é ignorado, como antes */
  prompt: string | null;
}

/**
 * Lê motor, resolução e texto do pedido. O Kling continua aceitando só 720p/1080p e o Wan só 480p/720p: a combinação
 * errada é recusada antes de qualquer cobrança.
 */
export function resolveMotionControlRequest(dto: { engine?: string; resolution?: string; prompt?: string }): MotionControlRequest {
  const engine = (dto.engine ?? 'kling') as MotionControlEngine;
  if (!MOTION_CONTROL_ENGINES.includes(engine)) {
    throw new BadRequestException(`Motor desconhecido: ${dto.engine}.`);
  }
  if (!isWanEngine(engine)) {
    const resolution = dto.resolution ?? '720p';
    if (resolution !== '720p' && resolution !== '1080p') {
      throw new BadRequestException('O Motion Control (Kling) gera em 720p ou 1080p.');
    }
    return {
      engine,
      mode: null,
      resolution,
      dbResolution: resolution === '1080p' ? Resolution.RES_1080P : Resolution.RES_720P,
      prompt: null,
    };
  }
  const resolution = dto.resolution ?? '720p';
  if (resolution !== '480p' && resolution !== '720p') {
    throw new BadRequestException('A troca de pessoa (Wan 2.2 Animate) gera em 480p ou 720p.');
  }
  const prompt = dto.prompt?.replace(/\s+/g, ' ').trim().slice(0, WAN_ANIMATE_PROMPT_MAX_LENGTH) || null;
  return {
    engine,
    mode: engine === 'wan-replace' ? 'replace' : 'animate',
    resolution,
    dbResolution: resolution === '480p' ? Resolution.RES_480P : Resolution.RES_720P,
    prompt,
  };
}

/** Preço do Wan 2.2 Animate: segundos do vídeo de entrada (inteiros, mínimo 3) × créditos por segundo da resolução. */
export function wanAnimateCredits(resolution: Resolution, durationSeconds: number): number {
  const perSecond = WAN_ANIMATE_CREDITS_PER_SECOND[resolution] ?? WAN_ANIMATE_CREDITS_PER_SECOND[Resolution.RES_720P]!;
  const billed = Math.max(WAN_ANIMATE_MIN_BILLED_SECONDS, Math.ceil(Number.isFinite(durationSeconds) ? durationSeconds : 0));
  return billed * perSecond;
}
