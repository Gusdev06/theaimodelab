import { GenerationStatus, GenerationType } from '@prisma/client';
import { lineageByOrigin } from './provenance/own-media';

/**
 * Ângulos de câmera da MESMA foto (Qwen Image Edit Multiple Angles, na WaveSpeed): a foto da modelo de IA da cliente
 * vista de outro lado (8 giros na horizontal × 4 alturas × 3 distâncias = 96 poses), com o mesmo rosto, roupa e luz.
 * É o "giro 360" do hub da modelo no site (12 ângulos num toque) e o pack de referências mais fiel que existe hoje.
 *
 * Regras:
 *  - A foto de entrada NUNCA vem do pedido: a rota recebe o id de uma geração da própria conta, já pronta, e usa a
 *    nossa cópia guardada. Só entra geração de linhagem limpa (feita do zero na plataforma, ou a partir de fotos que
 *    eram gerações limpas da mesma conta: src/generations/provenance/own-media.ts). Foto de pessoa real enviada pela
 *    cliente, troca de rosto, provador e prompt clonado de foto ficam de fora.
 *  - Sem texto livre: o modelo monta o próprio prompt pelo ângulo. O resultado não acrescenta nada que a foto não
 *    tinha; só muda o ponto de vista.
 *  - Cobrança fixa por foto no envio, sem geração grátis. O slug `multiple-angles` é o interruptor do admin e nasce
 *    DESLIGADO no seed: liga depois de um teste com a chave da WaveSpeed.
 */
export const MULTIPLE_ANGLES_SLUG = 'multiple-angles';
export const MULTIPLE_ANGLES_MODEL = 'wavespeed-ai/qwen-image/edit-multiple-angles';

/** US$ 0,025 por foto na WaveSpeed (docs, 04/11/2026). A regra da casa (custo × 3.333) daria 83; fica em 100. */
export const MULTIPLE_ANGLES_CREDITS = 100;

/** Giros aceitos pelo modelo (ele arredonda qualquer valor para estes). */
export const MULTIPLE_ANGLES_HORIZONTAL = [0, 45, 90, 135, 180, 225, 270, 315] as const;
/** Altura da câmera: -30 = de baixo, 0 = na altura dos olhos, 30 e 60 = de cima. */
export const MULTIPLE_ANGLES_VERTICAL = [-30, 0, 30, 60] as const;
/** 0 = close, 1 = plano médio, 2 = aberto. */
export const MULTIPLE_ANGLES_DISTANCE = [0, 1, 2] as const;

export type MultipleAnglesHorizontal = (typeof MULTIPLE_ANGLES_HORIZONTAL)[number];
export type MultipleAnglesVertical = (typeof MULTIPLE_ANGLES_VERTICAL)[number];
export type MultipleAnglesDistance = (typeof MULTIPLE_ANGLES_DISTANCE)[number];

const DISTANCE_TEXT: Record<MultipleAnglesDistance, string> = { 0: 'close-up', 1: 'medium shot', 2: 'wide shot' };

/**
 * Texto guardado na geração (galeria e admin). Começa com "The same": o construtor do site lê assim as fotos derivadas
 * da modelo e não as lista como modelo nova.
 */
export function multipleAnglesPrompt(horizontal: number, vertical: number, distance: number): string {
  const shot = DISTANCE_TEXT[distance as MultipleAnglesDistance] ?? DISTANCE_TEXT[1];
  return `The same photo seen from another camera angle (horizontal ${horizontal}°, vertical ${vertical}°, ${shot}).`;
}

/** Por que a foto escolhida não pode virar ângulos (null = pode). */
export type MultipleAnglesSourceProblem = 'not_found' | 'not_ready' | 'not_image' | 'expired' | 'not_own';

export interface MultipleAnglesSource {
  status: GenerationStatus;
  type: GenerationType;
  isDeleted: boolean;
  expiresAt: Date | null;
  prompt: string | null;
  parameters: unknown;
  inputImageCount: number;
  /** URL da saída pedida (null = a geração não tem essa saída) */
  outputUrl: string | null;
  /** impressão gravada na conclusão (own-media): true/false; null = geração sem impressão (anterior à tabela) */
  cleanLineage: boolean | null;
}

/**
 * Confere a geração de origem. A linhagem gravada vale; sem ela (geração antiga), só a que nasceu de texto puro
 * passa (a regra de origem do own-media).
 */
export function multipleAnglesSourceProblem(source: MultipleAnglesSource | null, now: Date = new Date()): MultipleAnglesSourceProblem | null {
  if (!source || source.isDeleted) return 'not_found';
  if (source.type !== GenerationType.TEXT_TO_IMAGE && source.type !== GenerationType.IMAGE_TO_IMAGE) return 'not_image';
  if (source.status !== GenerationStatus.COMPLETED || !source.outputUrl) return 'not_ready';
  if (!/^https:\/\//i.test(source.outputUrl)) return 'not_ready';
  if (source.expiresAt && source.expiresAt.getTime() <= now.getTime()) return 'expired';
  const clean =
    source.cleanLineage ??
    lineageByOrigin({
      type: source.type,
      inputImageCount: source.inputImageCount,
      prompt: source.prompt,
      parameters: source.parameters,
    }) === 'clean';
  return clean ? null : 'not_own';
}

export const MULTIPLE_ANGLES_SOURCE_MESSAGE: Record<MultipleAnglesSourceProblem, string> = {
  not_found: 'Foto de origem não encontrada nesta conta.',
  not_ready: 'A foto de origem ainda não está pronta.',
  not_image: 'Os ângulos saem só de uma foto (não de vídeo, troca de rosto ou provador).',
  expired: 'A foto de origem já saiu da galeria. Escolha uma foto que ainda esteja lá.',
  not_own: 'Os ângulos saem só de uma foto que a modelo de IA nasceu aqui na plataforma.',
};
