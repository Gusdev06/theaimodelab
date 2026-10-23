import {
  GenerationStatus,
  type GenerationType,
  type Prisma,
} from '@prisma/client';
import { RELEASABLE_SAFETY_EVENT_KINDS } from '../content-safety/safety-event-kinds';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  StoredMediaLocation,
  UploadsService,
} from '../uploads/uploads.service';

/**
 * "Saída promovida" (passo 22 da segurança de geração): resultado de geração CONCLUÍDA da própria conta, gravado no
 * bucket público (com a checagem ligada, só chega lá depois do checkOutput) e fora de revisão ou evidência. É a única
 * mídia que o editor de vídeo e a comunidade aceitam: nunca URL livre (SSRF, TKT-050) nem mídia hospedada fora.
 *
 * Geração escondida = status diferente de COMPLETED (IN_REVIEW, FAILED…) ou evento de segurança sem liberação ligado
 * a ela (bloqueio por menor e os de imagem: evidência e revisão). A liberação pelo revisor (releasedAt) devolve a
 * geração à regra comum.
 */

/** Eventos que seguram a geração: o mesmo conjunto que o jurídico ou o revisor libera. */
const HOLDING_EVENT_KINDS = [...RELEASABLE_SAFETY_EVENT_KINDS];
const ID_CHUNK = 1000;
/** Chave de resultado: `generations/<id da geração>/…` (ou a pasta antiga `outputs/<id>/…`). */
const OUTPUT_KEY = /^(?:generations|outputs)\/([A-Za-z0-9_-]{1,64})\//;

export type SafetyVisibilityDb = Pick<
  PrismaService,
  'generation' | 'contentSafetyEvent'
>;

export type PromotedOutputDb = SafetyVisibilityDb &
  Pick<PrismaService, 'generationOutput'>;

type Locator = Pick<UploadsService, 'locateStoredMedia'>;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
}

/**
 * Gerações (dentre as recebidas) que não podem aparecer nem virar mídia nova: fora de COMPLETED ou com evento de
 * segurança sem liberação. Id sem linha de geração não entra (geração apagada segue a regra antiga do post).
 */
export async function hiddenGenerationIds(
  db: SafetyVisibilityDb,
  generationIds: Iterable<string | null | undefined>,
): Promise<Set<string>> {
  const ids = [
    ...new Set(
      [...generationIds].filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    ),
  ];
  const hidden = new Set<string>();
  for (const part of chunk(ids, ID_CHUNK)) {
    const [notCompleted, held] = await Promise.all([
      db.generation.findMany({
        where: {
          id: { in: part },
          status: { not: GenerationStatus.COMPLETED },
        },
        select: { id: true },
      }),
      db.contentSafetyEvent.findMany({
        where: {
          generationId: { in: part },
          kind: { in: HOLDING_EVENT_KINDS },
          releasedAt: null,
        },
        select: { generationId: true },
      }),
    ]);
    for (const row of notCompleted) hidden.add(row.id);
    for (const row of held) if (row.generationId) hidden.add(row.generationId);
  }
  return hidden;
}

/**
 * Gerações que tiram os posts aprovados do feed, lidas pelo lado pequeno (não pela comunidade inteira): as com evento
 * de segurança sem liberação e as em revisão (IN_REVIEW), cruzadas com os posts aprovados do escopo para o filtro só
 * levar as que têm post. O custo cresce com os casos em aberto, não com o número de posts. Outro status fora de
 * COMPLETED (raro num post aprovado) fica para a conferência da página (hiddenGenerationIds nos ids da página). Vale em
 * qualquer modo: os bloqueios por menor da PR #4 também escondem.
 */
export async function heldGenerationIdsWithApprovedPosts(
  db: SafetyVisibilityDb & Pick<PrismaService, 'communityPost'>,
  approvedWhere: Prisma.CommunityPostWhereInput,
): Promise<Set<string>> {
  const [events, inReview] = await Promise.all([
    db.contentSafetyEvent.findMany({
      where: {
        kind: { in: HOLDING_EVENT_KINDS },
        releasedAt: null,
        generationId: { not: null },
      },
      select: { generationId: true },
      distinct: ['generationId'],
    }),
    db.generation.findMany({
      where: { status: GenerationStatus.IN_REVIEW },
      select: { id: true },
    }),
  ]);
  const candidates = [
    ...new Set([
      ...events
        .map((row) => row.generationId)
        .filter((id): id is string => !!id),
      ...inReview.map((row) => row.id),
    ]),
  ];
  const held = new Set<string>();
  for (const part of chunk(candidates, ID_CHUNK)) {
    const rows = await db.communityPost.findMany({
      where: { ...approvedWhere, generationId: { in: part } },
      select: { generationId: true },
      distinct: ['generationId'],
    });
    for (const row of rows) if (row.generationId) held.add(row.generationId);
  }
  return held;
}

/** Área e chave quando a URL é do bucket público; null para URL externa, interna, privada ou inválida. */
export function publicLocationOf(
  uploads: Locator,
  url: string | null | undefined,
): StoredMediaLocation | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  const location = uploads.locateStoredMedia(url);
  return location?.area === 'public' ? location : null;
}

/** Id da geração dona de uma chave de resultado; null fora das pastas de resultado. */
export function generationIdOfOutputKey(key: string): string | null {
  return OUTPUT_KEY.exec(key)?.[1] ?? null;
}

export interface OwnPromotedOutput {
  url: string;
  mimeType: string | null;
  /** miniatura do resultado, só quando também está no bucket público */
  thumbnailUrl: string | null;
  generationId: string;
  location: StoredMediaLocation;
  generation: {
    type: GenerationType;
    modelUsed: string;
    prompt: string | null;
  };
}

/**
 * Resultado promovido da própria conta pela URL exata gravada no banco. Ordem: a URL tem de ser do bucket público e da
 * pasta de uma geração (URL externa, interna, de metadados de nuvem ou privada para aqui, sem consulta nenhuma); depois
 * a linha do resultado com a dona e o status no banco; por fim, revisão ou evidência. Nunca baixa a URL.
 */
export async function findOwnPromotedOutput(
  db: PromotedOutputDb,
  uploads: Locator,
  userId: string,
  url: string,
): Promise<OwnPromotedOutput | null> {
  const location = publicLocationOf(uploads, url);
  if (!location) return null;
  const generationId = generationIdOfOutputKey(location.key);
  if (!generationId) return null;
  const output = await db.generationOutput.findFirst({
    where: {
      generationId,
      url,
      generation: {
        userId,
        isDeleted: false,
        status: GenerationStatus.COMPLETED,
      },
    },
    select: {
      url: true,
      mimeType: true,
      thumbnailUrl: true,
      generationId: true,
      generation: { select: { type: true, modelUsed: true, prompt: true } },
    },
  });
  if (!output) return null;
  const hidden = await hiddenGenerationIds(db, [output.generationId]);
  if (hidden.has(output.generationId)) return null;
  return {
    url: output.url,
    mimeType: output.mimeType,
    thumbnailUrl: publicLocationOf(uploads, output.thumbnailUrl)
      ? output.thumbnailUrl
      : null,
    generationId: output.generationId,
    location,
    generation: output.generation,
  };
}
