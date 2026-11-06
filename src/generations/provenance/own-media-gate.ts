import { Logger } from '@nestjs/common';
import { OwnMediaRequiredError } from '../errors/content-safety.error';
import { GenerationJobName } from '../queue/generation-queue.constants';
import { isUncensoredFallbackModel } from '../queue/generation-fallback';
import type { OwnMatch } from './own-media';

/**
 * Porta da foto própria (A10 do estudo r2v, 06/11/2026): nos modelos sem filtro, só entra foto que é geração limpa da
 * própria conta (a modelo de IA que ela criou aqui, os quadros dos vídeos dela) ou de uma conta da casa (as capas da
 * biblioteca). O site já esconde o envio de foto nessas telas; esta é a trava de verdade, antes do provedor.
 *
 * UNCENSORED_OWN_MEDIA_MODE:
 *  - off (padrão): nada roda, nada muda;
 *  - log: confere e só registra (log `[OWN_MEDIA_GATE]` + `parameters.ownMediaGate`); o pedido segue igual. Também
 *    decide a linhagem dos vídeos, para os quadros deles valerem depois;
 *  - enforce: nos VÍDEOS sem filtro (LTX/Seedance Spicy, MiniMax H3, Wan do Copiar movimentos), foto de fora = a
 *    geração termina antes do provedor (UNCENSORED_OWN_MEDIA_REQUIRED, com estorno); foto própria = vai a NOSSA cópia
 *    (a saída guardada, ou o quadro tirado do nosso vídeo), nunca os bytes do pedido.
 *
 * Ficam de fora de propósito:
 *  - a IMAGEM sem filtro (Unlocked com foto de referência, troca de rosto Unlocked): só registro, mesmo no enforce.
 *    É o uso mais comum da plataforma com foto enviada e segue a regra do atestado (PR #4); travar lá é outra decisão;
 *  - o vídeo de entrada (movimento e cena do Copiar movimentos, do H3 por referência e da troca das Cenas). Nele a
 *    identidade vem da foto; um vídeo de entrada sem foto nenhuma conta como linhagem suja.
 */

export type OwnMediaGateMode = 'off' | 'log' | 'enforce';

export function ownMediaGateMode(raw: string | undefined | null): OwnMediaGateMode {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'log' || value === 'enforce' ? value : 'off';
}

/** Ids de contas da casa (vírgula): as gerações limpas delas valem como próprias para todo mundo (capas da biblioteca). */
export function trustedOwnerIds(raw: string | undefined | null): string[] {
  return [...new Set((raw ?? '').split(',').map((id) => id.trim()).filter(Boolean))];
}

/** Campos de job com IMAGEM de entrada (os mesmos de own-media.ts). */
const IMAGE_FIELDS = [
  'imageUrl',
  'imageUrls',
  'lastImageUrl',
  'firstFrameUrl',
  'lastFrameUrl',
  'referenceImageUrls',
  'sourceImageUrl',
  'targetImageUrl',
] as const;
/** Campos de job com VÍDEO de entrada. */
const VIDEO_FIELDS = ['videoUrl', 'videoList', 'referenceVideoUrls'] as const;

/** Jobs que sempre vão a um provedor sem filtro (o modelo não vem no job). */
const UNCENSORED_JOBS: Readonly<Record<string, string>> = {
  [GenerationJobName.WAVESPEED_IMAGE_TO_VIDEO]: 'wavespeed-ltx-spicy',
  [GenerationJobName.WAVESPEED_SEEDANCE_IMAGE_TO_VIDEO]: 'wavespeed-seedance-spicy',
  [GenerationJobName.COMFYDEPLOY_IMAGE_TO_VIDEO]: 'comfydeploy-wan',
  [GenerationJobName.MINIMAX_H3_TEXT_TO_VIDEO]: 'wavespeed-minimax-h3',
  [GenerationJobName.MINIMAX_H3_IMAGE_TO_VIDEO]: 'wavespeed-minimax-h3',
  [GenerationJobName.MINIMAX_H3_REFERENCE_TO_VIDEO]: 'wavespeed-minimax-h3',
};
/** Jobs que entregam imagem (a linhagem deles já é gravada na conclusão por recordGeneration). */
const IMAGE_JOBS: ReadonlySet<string> = new Set([
  GenerationJobName.IMAGE,
  GenerationJobName.IMAGE_WITH_FALLBACK,
  GenerationJobName.IMAGE_NANO_BANANA,
  GenerationJobName.VIRTUAL_TRY_ON,
  GenerationJobName.FACE_SWAP,
]);

/** "Clonar prompt" marca o prompt tirado de uma foto (PR #4): descreve uma foto real. */
const CLONED_FROM_PHOTO = /reference_override/i;

export interface GateTarget {
  /** o pedido vai a um modelo/motor sem filtro */
  uncensored: boolean;
  /** modelo/motor (log e erro) */
  model: string;
  /** fotos nos campos do job */
  jobImageUrls: string[];
  /** o job lê as fotos guardadas da geração (generation_input_images) */
  usesStoredImages: boolean;
  hasVideoInput: boolean;
  /** a geração entrega vídeo (a linhagem decide se os quadros dela valem como próprios) */
  producesVideo: boolean;
}

function fieldsOf(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

function listOf(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  return items.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}

function jobModel(fields: Record<string, unknown>): string {
  for (const key of ['resolvedModel', 'modelId', 'model']) {
    const value = fields[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

/** Para onde o job manda as fotos e quais são elas. */
export function gateTargetOf(jobName: string, data: unknown): GateTarget {
  const fields = fieldsOf(data);
  let model = UNCENSORED_JOBS[jobName] ?? '';
  let uncensored = !!model;
  if (jobName === GenerationJobName.MOTION_CONTROL) {
    const engine = typeof fields.engine === 'string' ? fields.engine : 'kling';
    model = `motion-control:${engine}`;
    uncensored = engine !== 'kling';
  } else if (jobName === GenerationJobName.FACE_SWAP) {
    model = fields.nsfw === true ? 'face-swap:unlocked' : 'face-swap';
    uncensored = fields.nsfw === true;
  } else if (!uncensored) {
    model = jobModel(fields);
    uncensored = !!model && isUncensoredFallbackModel(model);
  }
  const jobImageUrls = [...new Set(IMAGE_FIELDS.flatMap((field) => listOf(fields[field])))];
  const hasVideoInput = fields.hasVideoInput === true || VIDEO_FIELDS.some((field) => listOf(fields[field]).length > 0);
  return {
    uncensored,
    model,
    jobImageUrls,
    usesStoredImages: fields.hasInputImages === true,
    hasVideoInput,
    producesVideo: !IMAGE_JOBS.has(jobName),
  };
}

/**
 * Linhagem de um vídeo para os quadros dele: limpo quando todas as fotos são próprias, ou quando não há foto nem vídeo
 * de entrada (só texto). Vídeo de entrada sem foto (a identidade é a pessoa do vídeo) e prompt clonado de foto = sujo.
 */
export function videoLineage(input: {
  imageCount: number;
  allImagesOwn: boolean;
  hasVideoInput: boolean;
  prompt: unknown;
}): 'clean' | 'not_clean' {
  if (typeof input.prompt === 'string' && CLONED_FROM_PHOTO.test(input.prompt)) return 'not_clean';
  if (input.imageCount > 0) return input.allImagesOwn ? 'clean' : 'not_clean';
  return input.hasVideoInput ? 'not_clean' : 'clean';
}

/** Troca as fotos nos campos do job pelas nossas cópias (vídeo de entrada fica). null = sobrou foto sem troca. */
export function substituteJobImages<T>(data: T, replacements: ReadonlyMap<string, string>): T | null {
  const fields = { ...fieldsOf(data) };
  for (const field of IMAGE_FIELDS) {
    const value = fields[field];
    if (value == null) continue;
    if (Array.isArray(value)) {
      const swapped: string[] = [];
      for (const item of value) {
        const replacement = typeof item === 'string' ? replacements.get(item.trim()) : undefined;
        if (!replacement) return null;
        swapped.push(replacement);
      }
      fields[field] = swapped;
    } else if (typeof value === 'string') {
      if (!value.trim()) continue;
      const replacement = replacements.get(value.trim());
      if (!replacement) return null;
      fields[field] = replacement;
    } else {
      return null;
    }
  }
  return fields as T;
}

export interface StoredInputImage {
  id: string;
  url: string | null;
  /** as entradas guardadas incluem o vídeo do Copiar movimentos (`video/…`) */
  mimeType: string | null;
}

function isImageRow(row: StoredInputImage): boolean {
  return !/^(video|audio)\//i.test(row.mimeType ?? '');
}

/** O que a porta grava em `parameters.ownMediaGate` (sem foto nem prompt: só contagens, ids e a decisão). */
export interface OwnMediaGateAudit {
  mode: OwnMediaGateMode;
  model: string;
  uncensored: boolean;
  images: number;
  /** todas as fotos são da conta (no critério do desvio: é o que o enforce deixa passar, pela nossa cópia) */
  own: boolean;
  /** todas bateram no critério estrito (o da linhagem) */
  strict: boolean;
  /** só em vídeo: decide se os quadros dele valem como próprios */
  lineage?: 'clean' | 'not_clean';
  /** enforce: a foto de fora encerrou o pedido */
  blocked?: boolean;
  /** enforce: foi a nossa cópia */
  substituted?: boolean;
  /** a conferência não conseguiu ler alguma foto (rede, armazenamento, banco) */
  unreadable?: boolean;
  matches?: { generationId: string; outputOrder: number; distance: number; frame: boolean }[];
}

/** Resultado da conferência: `transient` = não deu para conferir agora (rede, banco), diferente de "não bate". */
export interface OwnMediaMatchResult {
  matches: OwnMatch[] | null;
  transient: boolean;
}

export interface OwnMediaGateDeps {
  mode: OwnMediaGateMode;
  /**
   * matchOwnClean com quadros de vídeo e as contas da casa. `lineage` = critério estrito (a foto do pedido é a que o
   * provedor recebe); `detour` = critério do desvio (só vale quando quem vai ao provedor é a nossa cópia).
   */
  match: (userId: string, urls: readonly string[], rule: 'lineage' | 'detour') => Promise<OwnMediaMatchResult>;
  storedImages: (generationId: string) => Promise<StoredInputImage[]>;
  replaceStoredImages: (rows: readonly { id: string; url: string }[]) => Promise<void>;
  /** tira o quadro do nosso vídeo e guarda junto das entradas desta geração (some na limpeza); null = não deu */
  copyFrame: (videoUrl: string, frameIndex: number, generationId: string, index: number) => Promise<string | null>;
  saveAudit: (generationId: string, audit: OwnMediaGateAudit) => Promise<void>;
}

/**
 * Falha nossa ao conferir ou preparar a cópia (passageira: rede, armazenamento, banco). Não é bloqueio terminal: o
 * BullMQ tenta de novo. O texto é o que a cliente vê se as tentativas acabarem.
 */
export class OwnMediaCopyError extends Error {
  constructor(readonly detail: string) {
    super('Não deu para preparar a foto da sua modelo agora. Tente de novo em instantes. Seus créditos foram devolvidos.');
    this.name = 'OwnMediaCopyError';
  }
}

export class OwnMediaGate {
  private readonly logger = new Logger(OwnMediaGate.name);

  constructor(private readonly deps: OwnMediaGateDeps) {}

  get mode(): OwnMediaGateMode {
    return this.deps.mode;
  }

  /**
   * Confere o job antes do provedor e devolve o job (igual, ou com as nossas cópias no enforce).
   *
   * - off: devolve o job sem tocar em nada.
   * - log: nunca muda nem derruba o pedido (uma falha da conferência vira aviso no log).
   * - enforce: vale para VÍDEO sem filtro. Foto de fora = OwnMediaRequiredError (bloqueio terminal, com estorno);
   *   conferência ou cópia que falha = OwnMediaCopyError (passageira: o BullMQ tenta de novo). Imagem sem filtro
   *   (Unlocked, troca de rosto Unlocked) é só registrada, mesmo no enforce: travar a foto enviada lá é outra decisão.
   *
   * Linhagem do vídeo (se os quadros dele valem depois como foto própria): só fica limpa quando as fotos bateram no
   * critério ESTRITO, ou quando o provedor recebeu a nossa cópia. Num vídeo com filtro, ou em log, o provedor recebe
   * os bytes do pedido: uma foto só "parecida" com uma geração da conta não pode lavar o vídeo.
   */
  async apply<T>(jobName: string, data: T): Promise<T> {
    if (this.deps.mode === 'off') return data;
    try {
      return await this.check(jobName, data);
    } catch (error) {
      if (this.deps.mode === 'enforce') throw error;
      this.logger.warn(`[OWN_MEDIA_GATE] ${jobName}: conferência falhou (${(error as Error).message}) — pedido segue`);
      return data;
    }
  }

  private async check<T>(jobName: string, data: T): Promise<T> {
    const mode = this.deps.mode;
    const fields = fieldsOf(data);
    const generationId = typeof fields.generationId === 'string' ? fields.generationId : '';
    const userId = typeof fields.userId === 'string' ? fields.userId : '';
    const target = gateTargetOf(jobName, data);
    // imagem com filtro: nada a conferir (a linhagem dela sai na conclusão)
    if (!target.uncensored && !target.producesVideo) return data;
    const enforce = mode === 'enforce' && target.uncensored && target.producesVideo;
    if (!generationId || !userId) {
      // job sem dono não dá para conferir: no enforce não passa
      if (enforce) throw new OwnMediaRequiredError(target.model);
      return data;
    }

    // vídeo: as fotos podem estar só nas entradas guardadas (Veo, Kling…), então lê sempre
    const stored = target.producesVideo || target.usesStoredImages ? await this.deps.storedImages(generationId) : [];
    const storedPhotos = stored.filter(isImageRow);
    const hasVideoInput = target.hasVideoInput || stored.length > storedPhotos.length;
    const missingUrl = storedPhotos.some((row) => !row.url);
    const urls = [...new Set([...target.jobImageUrls, ...storedPhotos.flatMap((row) => (row.url ? [row.url.trim()] : []))])];
    const imageCount = missingUrl ? Math.max(1, urls.length) : urls.length;

    let matches: OwnMatch[] | null = null;
    let strict = false;
    let unreadable = false;
    if (!missingUrl && urls.length > 0) {
      const first = await this.deps.match(userId, urls, 'lineage');
      unreadable = first.transient;
      matches = first.matches && first.matches.length === urls.length ? first.matches : null;
      strict = matches !== null;
      // vídeo sem filtro: o enforce manda a nossa cópia, então vale também o critério do desvio (em log, para o
      // registro dizer o que o enforce faria)
      if (!strict && !unreadable && target.uncensored && target.producesVideo) {
        const loose = await this.deps.match(userId, urls, 'detour');
        unreadable = loose.transient;
        matches = loose.matches && loose.matches.length === urls.length ? loose.matches : null;
      }
    }
    const own = matches !== null;
    // quem vai ao provedor é a nossa cópia?
    const willSubstitute = enforce && own;

    const audit: OwnMediaGateAudit = {
      mode,
      model: target.model,
      uncensored: target.uncensored,
      images: imageCount,
      own,
      strict,
      ...(unreadable ? { unreadable: true } : {}),
      ...(target.producesVideo
        ? {
            lineage: videoLineage({
              imageCount,
              allImagesOwn: strict || willSubstitute,
              hasVideoInput,
              prompt: fields.prompt,
            }),
          }
        : {}),
      ...(own && matches
        ? {
            matches: matches.map((match) => ({
              generationId: match.generationId,
              outputOrder: match.outputOrder,
              distance: match.distance,
              frame: match.frameIndex !== null,
            })),
          }
        : {}),
    };

    if (target.uncensored && imageCount > 0 && !own) {
      this.logger.warn(
        `[OWN_MEDIA_GATE] gen=${generationId} user=${userId} ${jobName} → ${target.model}: ${imageCount} foto(s) ${unreadable ? 'sem conferência (falha de leitura)' : 'que não são da conta'} (${enforce ? (unreadable ? 'nova tentativa' : 'encerrada antes do provedor') : 'só registro'})`,
      );
    }
    if (!enforce || imageCount === 0) {
      await this.deps.saveAudit(generationId, audit);
      return data;
    }
    if (!own) {
      // não deu para LER a foto (rede, armazenamento, banco): passageiro, não é "foto de fora"
      if (unreadable) throw new OwnMediaCopyError(`gen=${generationId}: conferência das fotos falhou`);
      await this.deps.saveAudit(generationId, { ...audit, blocked: true });
      throw new OwnMediaRequiredError(target.model);
    }

    // enforce com tudo próprio: vai a nossa cópia de cada foto
    const replacements = new Map<string, string>();
    for (let index = 0; index < matches!.length; index++) {
      const match = matches![index];
      const copy =
        match.frameIndex === null
          ? match.outputUrl
          : await this.deps.copyFrame(match.outputUrl, match.frameIndex, generationId, index);
      if (!copy) throw new OwnMediaCopyError(`gen=${generationId}: cópia do quadro ${index} falhou`);
      replacements.set(match.inputUrl, copy);
    }
    const swapped = substituteJobImages(data, replacements);
    const storedSwaps = storedPhotos.map((row) => ({ id: row.id, url: replacements.get((row.url as string).trim()) ?? '' }));
    if (!swapped || storedSwaps.some((row) => !row.url)) {
      await this.deps.saveAudit(generationId, { ...audit, blocked: true });
      throw new OwnMediaRequiredError(target.model);
    }
    if (storedSwaps.length > 0) await this.deps.replaceStoredImages(storedSwaps);
    this.logger.log(
      `[OWN_MEDIA_GATE] gen=${generationId} ${jobName} → ${target.model}: ${replacements.size} foto(s) próprias (${audit.matches!
        .map((match) => `${match.generationId}#${match.outputOrder}${match.frame ? ' quadro' : ''} d=${match.distance}`)
        .join(', ')}) — vai a cópia guardada`,
    );
    await this.deps.saveAudit(generationId, { ...audit, substituted: true });
    return swapped;
  }
}
