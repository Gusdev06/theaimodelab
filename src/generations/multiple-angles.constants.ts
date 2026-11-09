import { GenerationStatus, GenerationType } from '@prisma/client';
import { assessBody, type MinorAssessment } from '../content-safety/minor-guard';
import { lineageByOrigin, lineageSourceIdsOf } from './provenance/own-media';

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
 *  - O pedido não tem texto, então o interceptor da trava de menor não vê nada: a rota relê o texto guardado da
 *    origem e de toda a linhagem dela (ângulo de ângulo, foto feita a partir de foto, até o pedido de texto) e recusa
 *    como o interceptor recusaria. Imagem feita a partir de foto sem a trilha das fotos de entrada não dá para reler e
 *    é recusada.
 *  - Cobrança fixa por foto no envio, sem geração grátis. O slug `multiple-angles` é o interruptor do admin e nasce
 *    DESLIGADO (ModelsService.onModuleInit, sem depender do seed): liga depois de um teste com a chave da WaveSpeed.
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

/**
 * Por que a foto escolhida não pode virar ângulos (null = pode). 'policy' não sai de multipleAnglesSourceProblem: é a
 * origem cujo texto a trava não consegue conferir (alfabeto sem lista, texto grande demais) ou cuja linhagem não dá
 * para reler até o pedido de texto (MultipleAnglesLineageGap).
 */
export type MultipleAnglesSourceProblem = 'not_found' | 'not_ready' | 'not_image' | 'expired' | 'not_own' | 'policy';

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
  policy: 'Não conseguimos conferir a origem desta foto. Escolha outra foto da sua modelo.',
};

/* ------------------------------------------------------------------ trava de menor sobre a origem */

/** Rota gravada no registro de abuso (o mesmo formato do interceptor). */
export const MULTIPLE_ANGLES_ROUTE = 'POST /api/v1/generations/multiple-angles';
/**
 * Marca do registro quando a recusa vem do texto RELIDO de uma geração antiga (não de um pedido digitado agora): separa
 * os dois no admin e evita gravar de novo a mesma origem a cada toque.
 */
export const MULTIPLE_ANGLES_SOURCE_MATCH_PREFIX = 'angles-source:';
/** Marca do registro quando quem barrou o texto relido foi o juiz de prompt (modo enforce). */
export const MULTIPLE_ANGLES_JUDGE_MATCH = `${MULTIPLE_ANGLES_SOURCE_MATCH_PREFIX}judge:minor`;
/** Níveis máximos ao subir da origem pedida (ângulo de ângulo, foto feita a partir de foto…). */
export const MULTIPLE_ANGLES_MAX_HOPS = 10;
/** Gerações máximas relidas numa linhagem (a origem incluída). */
export const MULTIPLE_ANGLES_MAX_NODES = 24;

/** Uma geração da linhagem: a origem pedida e cada geração de onde ela saiu, até as que nasceram só de texto. */
export interface MultipleAnglesLineageNode {
  id: string;
  type: GenerationType;
  prompt: string | null;
  negativePrompt: string | null;
  parameters: unknown;
}

/**
 * Por que a linhagem não fecha:
 *  - 'missing': uma geração apontada não existe nesta conta (ou aponta para si mesma);
 *  - 'untraceable': imagem feita a partir de foto sem a trilha das fotos de entrada (impressão anterior à trilha) ou
 *    ângulo sem a foto de origem;
 *  - 'not_image': a trilha aponta para algo que não é foto;
 *  - 'too_deep': passou do limite de níveis ou de gerações.
 */
export type MultipleAnglesLineageGap = 'missing' | 'untraceable' | 'not_image' | 'too_deep';

export interface MultipleAnglesLineage {
  /** a origem pedida primeiro, depois as gerações de onde ela saiu, nível a nível, sem repetir */
  nodes: MultipleAnglesLineageNode[];
  /** a foto que originou a cadeia de ângulos (a própria origem quando ela não é um ângulo) */
  chainRootId: string;
  /** null = a linhagem inteira foi relida */
  gap: MultipleAnglesLineageGap | null;
}

function parametersOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A geração é um ângulo feito por esta rota? */
export function isMultipleAnglesGeneration(parameters: unknown): boolean {
  return parametersOf(parameters).mode === 'multiple_angles';
}

/** Id da geração de onde o ângulo saiu (null = ausente ou inválido). */
export function angleSourceIdOf(parameters: unknown): string | null {
  const value = parametersOf(parameters).sourceGenerationId;
  return typeof value === 'string' && /^[a-z0-9]{20,40}$/i.test(value) ? value : null;
}

/**
 * De onde a geração saiu. Ângulo: a foto de origem (obrigatória) e a trilha. Imagem a partir de foto: a trilha
 * (obrigatória; sem ela as fotos de entrada não dão mais para conferir). Só texto: nada (o pedido com foto sempre vira
 * IMAGE_TO_IMAGE). Outro tipo: não é foto.
 */
export function lineageParentsOf(node: MultipleAnglesLineageNode): string[] | MultipleAnglesLineageGap {
  const trail = lineageSourceIdsOf(node.parameters) ?? [];
  if (isMultipleAnglesGeneration(node.parameters)) {
    const source = angleSourceIdOf(node.parameters);
    return source ? [...new Set([source, ...trail])] : 'untraceable';
  }
  if (node.type === GenerationType.TEXT_TO_IMAGE) return trail;
  if (node.type === GenerationType.IMAGE_TO_IMAGE) return trail.length > 0 ? trail : 'untraceable';
  return 'not_image';
}

/**
 * Sobe da origem pedida por toda a linhagem (nível a nível), até as gerações que nasceram só de texto. `loadMany` busca
 * as gerações na MESMA conta (inclusive apagadas da galeria: o texto continua valendo); a que faltar não existe nela.
 */
export async function resolveMultipleAnglesLineage(
  origin: MultipleAnglesLineageNode,
  loadMany: (generationIds: string[]) => Promise<MultipleAnglesLineageNode[]>,
  limits: { maxHops: number; maxNodes: number } = { maxHops: MULTIPLE_ANGLES_MAX_HOPS, maxNodes: MULTIPLE_ANGLES_MAX_NODES },
): Promise<MultipleAnglesLineage> {
  const nodes: MultipleAnglesLineageNode[] = [origin];
  const seen = new Set([origin.id]);
  let frontier = [origin];
  let hops = 0;
  let gap: MultipleAnglesLineageGap | null = null;

  while (frontier.length > 0 && !gap) {
    const parentIds: string[] = [];
    for (const node of frontier) {
      const parents = lineageParentsOf(node);
      if (typeof parents === 'string') {
        gap = parents;
        break;
      }
      for (const parentId of parents) {
        if (parentId === node.id) {
          gap = 'missing';
          break;
        }
        if (!seen.has(parentId)) {
          seen.add(parentId);
          parentIds.push(parentId);
        }
      }
      if (gap) break;
    }
    if (gap || parentIds.length === 0) break;
    hops++;
    if (hops > limits.maxHops || nodes.length + parentIds.length > limits.maxNodes) {
      gap = 'too_deep';
      break;
    }
    const loaded = new Map((await loadMany(parentIds)).map((node) => [node.id, node]));
    const next: MultipleAnglesLineageNode[] = [];
    for (const parentId of parentIds) {
      const parent = loaded.get(parentId);
      if (!parent) {
        gap = 'missing';
        break;
      }
      next.push(parent);
    }
    nodes.push(...next);
    frontier = next;
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  let chainRoot = origin;
  for (let step = 0; step <= limits.maxHops && isMultipleAnglesGeneration(chainRoot.parameters); step++) {
    const parent = byId.get(angleSourceIdOf(chainRoot.parameters) ?? '');
    if (!parent) break;
    chainRoot = parent;
  }
  return { nodes, chainRootId: chainRoot.id, gap };
}

/**
 * A trava de menor sobre o texto guardado de uma geração, lido como o interceptor leu o pedido original: o prompt e o
 * prompt negativo (o negativo lista o que evitar, "child, teen", e fica fora da leitura de menor, como no pedido).
 */
export function multipleAnglesTextVerdict(node: Pick<MultipleAnglesLineageNode, 'prompt' | 'negativePrompt'>): MinorAssessment {
  return assessBody({ prompt: node.prompt, negative_prompt: node.negativePrompt });
}

export type MultipleAnglesSafety =
  | { kind: 'ok' }
  /** texto com referência a menor: recusa 422 CONTENT_POLICY_MINOR com registro ligado a esta geração */
  | { kind: 'minor'; node: MultipleAnglesLineageNode; match: string }
  /** alfabeto sem lista ou texto grande demais: recusa sem registro de abuso */
  | { kind: 'unreadable' };

/**
 * Confere o texto de cada geração relida da linhagem, das mais antigas (as que a cliente pediu com texto) para a
 * origem. Menor vence: quando alguma tem referência a menor, é ela que vai para o registro, mesmo que outra seja
 * ilegível.
 */
export function multipleAnglesSafety(nodes: readonly MultipleAnglesLineageNode[]): MultipleAnglesSafety {
  if (nodes.length === 0) return { kind: 'unreadable' };
  let unreadable = false;
  for (const node of [...nodes].reverse()) {
    const verdict = multipleAnglesTextVerdict(node);
    if (!verdict.blocked) continue;
    if (verdict.reason === 'size' || verdict.reason === 'script') {
      unreadable = true;
      continue;
    }
    return { kind: 'minor', node, match: `${MULTIPLE_ANGLES_SOURCE_MATCH_PREFIX}${verdict.match ?? verdict.reason ?? 'term'}` };
  }
  return unreadable ? { kind: 'unreadable' } : { kind: 'ok' };
}

/** Textos da linhagem para o juiz de prompt: os pedidos da cliente (o texto fixo dos ângulos fica de fora), sem repetir. */
export function multipleAnglesJudgeTexts(nodes: readonly MultipleAnglesLineageNode[]): string[] {
  const texts = nodes
    .filter((node) => !isMultipleAnglesGeneration(node.parameters))
    .map((node) => node.prompt?.trim() ?? '')
    .filter((text) => text.length > 0);
  return [...new Set(texts)];
}
