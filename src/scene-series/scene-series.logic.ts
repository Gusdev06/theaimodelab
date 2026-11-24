/*
 * Séries com cadeado (candy-series, L23): molde Candy Shorts (clipes verticais da mesma personagem, 2 episódios
 * abertos e paywall no 3º; 119 → 169 séries entre 29/09 e 11/11/2026) e Character.AI Series (8 abertos, 2 pagos).
 *
 * A série é CATÁLOGO, não geração: o dono agrupa cenas que já estão no acervo (prompt_templates) numa fila de
 * 3 a 12 episódios. O catálogo mora numa linha da app_settings (JSON), sem tabela nova. Quem não assina recebe os
 * episódios abertos inteiros e, nos trancados, só número, título, tipo e o 1º quadro já borrado no servidor: a URL
 * da mídia trancada (vídeo, imagem grande, prompt e id da cena) nunca entra no payload.
 *
 * Só funções puras aqui (testadas em __tests__/scene-series.logic.spec.ts).
 */

export const SCENE_SERIES_SETTING_KEY = 'scene_series_catalog';
/** Episódios abertos por padrão (Candy Shorts: 2 grátis, cadeado no 3º). */
export const DEFAULT_FREE_EPISODES = 2;
export const MIN_EPISODES = 3;
export const MAX_EPISODES = 12;
export const MAX_SERIES = 60;
export const SERIES_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,59}$/;

export const SERIES_LOCALES = ['pt-BR', 'es', 'en', 'it'] as const;
export type SeriesLocale = (typeof SERIES_LOCALES)[number];
export type LocalizedText = Partial<Record<SeriesLocale, string>>;

const VIDEO_TYPES = new Set([
  'text_to_video',
  'image_to_video',
  'motion_control',
]);
const VIDEO_FILE = /\.(mp4|webm|mov|m4v)(\?|#|$)/i;

/**
 * Temática família/step fica fora da série (spec L23) e a palavra "teen" não entra em nada que o dono escreve.
 * "daddy" e "universitária" são termos liberados do nicho adulto e por isso não estão aqui.
 */
const FORBIDDEN_THEME =
  /\bstep[\s-]?(mom|mother|moms|sis|sister|sisters|bro|brother|dad|father|daughter|son|family|aunt|uncle|cousin)\b|\bstep(mom|sis|bro|dad|daughter|son)s?\b|\bmadrast\w*|\bpadrast\w*|\bentead\w*|\bmeia[\s-]?irm\w*|\bhermanastr\w*|\bhijastr\w*|\bincest\w*|\bfam[ií]lia\b|\bfamily\b|\bteens?\b/i;

export interface StoredEpisode {
  sceneId: string;
  title?: string;
  titleI18n?: LocalizedText;
  /** imagem já borrada enviada pelo dono; sem ela o servidor borra o 1º quadro da cena */
  teaserUrl?: string;
}

export interface StoredSeries {
  id: string;
  title: string;
  titleI18n?: LocalizedText;
  /** nome da modelo de exemplo que faz todos os episódios */
  modelName?: string;
  coverUrl?: string;
  freeEpisodes: number;
  active: boolean;
  sortOrder: number;
  episodes: StoredEpisode[];
  updatedAt: string;
}

export interface SeriesCatalog {
  version: 1;
  series: StoredSeries[];
}

/** A cena do acervo por trás de um episódio (o que o Prisma devolve, já achatado). */
export interface EpisodeSource {
  id: string;
  title: string;
  type: string;
  prompt: string;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  aiModel: string | null;
  /** a cena e a seção dela estão ativas = aparece na parede pública (/api/v1/prompts) */
  visibleInLibrary: boolean;
  sectionSlug: string;
  sectionTitle: string;
  categoryId: string;
  categoryTitle: string;
}

export interface PublicOpenEpisode {
  number: number;
  locked: false;
  title: string;
  titleI18n?: LocalizedText;
  kind: 'video' | 'photo';
  scene: {
    id: string;
    title: string;
    type: string;
    prompt: string;
    imageUrl?: string;
    thumbnailUrl?: string;
    aiModel?: string;
    sectionSlug: string;
    sectionTitle: string;
    categoryId: string;
    categoryTitle: string;
  };
}

/** Episódio trancado: nada que leve à mídia (nem id da cena, nem prompt, nem URL do vídeo ou da imagem grande). */
export interface PublicLockedEpisode {
  number: number;
  locked: true;
  title: string;
  titleI18n?: LocalizedText;
  kind: 'video' | 'photo';
  /** 1º quadro borrado no servidor (ou a imagem borrada do dono); null = card escuro com o cadeado */
  teaserUrl: string | null;
}

export type PublicEpisode = PublicOpenEpisode | PublicLockedEpisode;

export interface PublicSeries {
  id: string;
  title: string;
  titleI18n?: LocalizedText;
  modelName?: string;
  coverUrl: string | null;
  freeEpisodes: number;
  episodeCount: number;
  lockedCount: number;
  episodes: PublicEpisode[];
}

export interface PublicSeriesResponse {
  enabled: boolean;
  /** quem pediu já vê tudo (assinante ativo ou admin) */
  unlocked: boolean;
  series: PublicSeries[];
}

/** Liga com on/true/1/yes; qualquer outra coisa (inclusive ausente) = desligado. */
export function parseSeriesFlag(raw: string | undefined | null): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'on' || value === 'true' || value === '1' || value === 'yes';
}

export function emptyCatalog(): SeriesCatalog {
  return { version: 1, series: [] };
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function cleanI18n(value: unknown, max: number): LocalizedText | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const out: LocalizedText = {};
  for (const locale of SERIES_LOCALES) {
    const text = cleanText((value as Record<string, unknown>)[locale], max);
    if (text) out[locale] = text;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function cleanHttpUrl(value: unknown): string | undefined {
  const text = cleanText(value, 2000);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? text
      : undefined;
  } catch {
    return undefined;
  }
}

function clampFree(value: unknown, episodeCount: number): number {
  const parsed =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.trunc(value)
      : DEFAULT_FREE_EPISODES;
  return Math.min(Math.max(1, parsed), Math.max(1, episodeCount - 1));
}

/**
 * Lê o JSON da app_settings sem nunca derrubar a rota: JSON quebrado = catálogo vazio; série ou episódio com
 * forma errada é descartado (o resto segue no ar).
 */
export function parseCatalog(raw: string | undefined | null): SeriesCatalog {
  if (!raw) return emptyCatalog();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyCatalog();
  }
  const list =
    data && typeof data === 'object'
      ? (data as { series?: unknown }).series
      : undefined;
  if (!Array.isArray(list)) return emptyCatalog();
  const series: StoredSeries[] = [];
  const seen = new Set<string>();
  for (const item of list.slice(0, MAX_SERIES)) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const id = cleanText(entry.id, 60);
    const title = cleanText(entry.title, 120);
    if (!id || !SERIES_ID_PATTERN.test(id) || !title || seen.has(id)) continue;
    const episodes: StoredEpisode[] = [];
    if (Array.isArray(entry.episodes)) {
      for (const raw of entry.episodes.slice(0, MAX_EPISODES)) {
        if (!raw || typeof raw !== 'object') continue;
        const episode = raw as Record<string, unknown>;
        const sceneId = cleanText(episode.sceneId, 64);
        if (!sceneId) continue;
        episodes.push({
          sceneId,
          title: cleanText(episode.title, 120),
          titleI18n: cleanI18n(episode.titleI18n, 120),
          teaserUrl: cleanHttpUrl(episode.teaserUrl),
        });
      }
    }
    if (episodes.length === 0) continue;
    seen.add(id);
    series.push({
      id,
      title,
      titleI18n: cleanI18n(entry.titleI18n, 120),
      modelName: cleanText(entry.modelName, 60),
      coverUrl: cleanHttpUrl(entry.coverUrl),
      freeEpisodes: clampFree(entry.freeEpisodes, episodes.length),
      active: entry.active !== false,
      sortOrder:
        typeof entry.sortOrder === 'number' && Number.isFinite(entry.sortOrder)
          ? Math.trunc(entry.sortOrder)
          : 0,
      episodes,
      updatedAt: cleanText(entry.updatedAt, 40) ?? new Date(0).toISOString(),
    });
  }
  return { version: 1, series };
}

export function serializeCatalog(catalog: SeriesCatalog): string {
  return JSON.stringify({ version: 1, series: catalog.series });
}

/** Ordem da vitrine: sortOrder crescente; empate = a mais nova primeiro. */
export function orderSeries(series: readonly StoredSeries[]): StoredSeries[] {
  return [...series].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder || b.updatedAt.localeCompare(a.updatedAt),
  );
}

/** O texto que puxou a trava de tema (família/step/teen), ou null. */
export function findForbiddenTheme(
  texts: ReadonlyArray<string | undefined | null>,
): string | null {
  for (const text of texts) {
    if (!text) continue;
    const match = FORBIDDEN_THEME.exec(text);
    if (match) return match[0];
  }
  return null;
}

export function episodeKind(type: string): 'video' | 'photo' {
  return VIDEO_TYPES.has(type) ? 'video' : 'photo';
}

export function isVideoUrl(url: string | null | undefined): boolean {
  return !!url && VIDEO_FILE.test(url);
}

/** Imagem parada da cena (o 1º quadro que a API gera para as capas em vídeo, ou a própria foto). */
export function posterImageOf(
  source: Pick<EpisodeSource, 'imageUrl' | 'thumbnailUrl'>,
): string | null {
  if (source.thumbnailUrl && !isVideoUrl(source.thumbnailUrl))
    return source.thumbnailUrl;
  if (source.imageUrl && !isVideoUrl(source.imageUrl)) return source.imageUrl;
  return null;
}

/** Episódio na posição `index` (0 = ep. 1) fica trancado para quem não assina? */
export function isEpisodeLocked(
  index: number,
  freeEpisodes: number,
  unlocked: boolean,
): boolean {
  return !unlocked && index >= freeEpisodes;
}

/** Versão do catálogo no link do teaser: trocou a série, o navegador baixa a imagem nova. */
export function teaserVersion(series: Pick<StoredSeries, 'updatedAt'>): string {
  const time = Date.parse(series.updatedAt);
  return Number.isFinite(time) ? String(time) : '0';
}

export type TeaserPathBuilder = (
  seriesId: string,
  episodeNumber: number,
  version: string,
) => string;

export const defaultTeaserPath: TeaserPathBuilder = (
  seriesId,
  episodeNumber,
  version,
) =>
  `/api/v1/scene-series/${encodeURIComponent(seriesId)}/episodes/${episodeNumber}/teaser?v=${encodeURIComponent(version)}`;

/** Episódios que existem no acervo, na ordem do dono (cena apagada sai da fila e os números seguem corridos). */
export function resolvedEpisodes(
  series: Pick<StoredSeries, 'episodes'>,
  sources: ReadonlyMap<string, EpisodeSource>,
): Array<{ episode: StoredEpisode; source: EpisodeSource }> {
  const out: Array<{ episode: StoredEpisode; source: EpisodeSource }> = [];
  for (const episode of series.episodes) {
    const source = sources.get(episode.sceneId);
    if (source) out.push({ episode, source });
  }
  return out;
}

/**
 * O payload público. Série inativa ou com menos de 2 episódios vivos não aparece; com a série inteira aberta
 * para quem não assina (freeEpisodes ≥ episódios) o cadeado ainda assim fica no último.
 */
export function buildPublicSeries(
  catalog: SeriesCatalog,
  sources: ReadonlyMap<string, EpisodeSource>,
  viewer: { unlocked: boolean },
  teaserPath: TeaserPathBuilder = defaultTeaserPath,
): PublicSeries[] {
  const out: PublicSeries[] = [];
  for (const series of orderSeries(catalog.series)) {
    if (!series.active) continue;
    const live = resolvedEpisodes(series, sources);
    if (live.length < 2) continue;
    const free = Math.min(series.freeEpisodes, live.length - 1);
    const version = teaserVersion(series);
    const episodes: PublicEpisode[] = live.map(({ episode, source }, index) => {
      const number = index + 1;
      const title = episode.title ?? source.title;
      const kind = episodeKind(source.type);
      if (isEpisodeLocked(index, free, viewer.unlocked)) {
        const teaser =
          episode.teaserUrl ??
          (posterImageOf(source)
            ? teaserPath(series.id, number, version)
            : null);
        return {
          number,
          locked: true,
          title,
          ...(episode.titleI18n ? { titleI18n: episode.titleI18n } : {}),
          kind,
          teaserUrl: teaser,
        };
      }
      return {
        number,
        locked: false,
        title,
        ...(episode.titleI18n ? { titleI18n: episode.titleI18n } : {}),
        kind,
        scene: {
          id: source.id,
          title: source.title,
          type: source.type,
          prompt: source.prompt,
          ...(source.imageUrl ? { imageUrl: source.imageUrl } : {}),
          ...(source.thumbnailUrl ? { thumbnailUrl: source.thumbnailUrl } : {}),
          ...(source.aiModel ? { aiModel: source.aiModel } : {}),
          sectionSlug: source.sectionSlug,
          sectionTitle: source.sectionTitle,
          categoryId: source.categoryId,
          categoryTitle: source.categoryTitle,
        },
      };
    });
    const first = live[0].source;
    out.push({
      id: series.id,
      title: series.title,
      ...(series.titleI18n ? { titleI18n: series.titleI18n } : {}),
      ...(series.modelName ? { modelName: series.modelName } : {}),
      coverUrl:
        series.coverUrl ??
        posterImageOf(first) ??
        first.thumbnailUrl ??
        first.imageUrl ??
        null,
      freeEpisodes: free,
      episodeCount: episodes.length,
      lockedCount: episodes.filter((episode) => episode.locked).length,
      episodes,
    });
  }
  return out;
}

/** Imagem que o teaser borra: a do dono (já borrada, não passa por aqui) ou o 1º quadro da cena. */
export function teaserSourceFor(
  catalog: SeriesCatalog,
  sources: ReadonlyMap<string, EpisodeSource>,
  seriesId: string,
  episodeNumber: number,
): string | null {
  const series = catalog.series.find(
    (item) => item.id === seriesId && item.active,
  );
  if (!series) return null;
  const live = resolvedEpisodes(series, sources);
  const index = episodeNumber - 1;
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= live.length ||
    live.length < 2
  )
    return null;
  const free = Math.min(series.freeEpisodes, live.length - 1);
  // só episódio trancado tem teaser (o aberto já vem com a mídia inteira)
  if (index < free) return null;
  return posterImageOf(live[index].source);
}

export interface SeriesInput {
  title: string;
  titleI18n?: LocalizedText;
  modelName?: string;
  coverUrl?: string;
  freeEpisodes?: number;
  active?: boolean;
  sortOrder?: number;
  episodes: StoredEpisode[];
}

/**
 * Validação do admin. Erros barram a gravação (forma, quantidade, cena inexistente, tema família/step/teen);
 * avisos não barram (episódio trancado que continua visível na parede pública: a mídia dele vaza por lá).
 */
export function validateSeriesInput(
  id: string,
  input: SeriesInput,
  sources: ReadonlyMap<string, EpisodeSource>,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!SERIES_ID_PATTERN.test(id))
    errors.push('id: use letras minúsculas, números e hífen (2 a 60).');
  if (!input.title?.trim()) errors.push('title: obrigatório.');
  const count = input.episodes?.length ?? 0;
  if (count < MIN_EPISODES || count > MAX_EPISODES) {
    errors.push(
      `episodes: a série precisa de ${MIN_EPISODES} a ${MAX_EPISODES} episódios (veio ${count}).`,
    );
  }
  const free = input.freeEpisodes ?? DEFAULT_FREE_EPISODES;
  if (!Number.isInteger(free) || free < 1 || (count > 0 && free > count - 1)) {
    errors.push(
      `freeEpisodes: de 1 a ${Math.max(1, count - 1)} (pelo menos 1 episódio fica com cadeado).`,
    );
  }
  const seen = new Set<string>();
  (input.episodes ?? []).forEach((episode, index) => {
    if (seen.has(episode.sceneId))
      errors.push(`episodes[${index}]: cena repetida (${episode.sceneId}).`);
    seen.add(episode.sceneId);
    const source = sources.get(episode.sceneId);
    if (!source) {
      errors.push(
        `episodes[${index}]: cena ${episode.sceneId} não existe no acervo.`,
      );
      return;
    }
    if (index >= free && source.visibleInLibrary) {
      warnings.push(
        `Episódio ${index + 1} (${source.title}) está ativo na parede pública: a mídia dele aparece fora do cadeado. Desative a cena no acervo ou mande lockInLibrary=true.`,
      );
    }
  });
  const texts: Array<string | undefined> = [
    input.title,
    input.modelName,
    ...Object.values(input.titleI18n ?? {}),
  ];
  for (const episode of input.episodes ?? []) {
    texts.push(episode.title, ...Object.values(episode.titleI18n ?? {}));
    const source = sources.get(episode.sceneId);
    if (source) texts.push(source.title, source.prompt);
  }
  const theme = findForbiddenTheme(texts);
  if (theme)
    errors.push(
      `tema: "${theme}" não entra em série (família/step/teen fora).`,
    );
  return { errors, warnings };
}

/** Grava (cria ou troca) uma série no catálogo, mantendo as outras como estavam. */
export function upsertSeries(
  catalog: SeriesCatalog,
  id: string,
  input: SeriesInput,
  now: Date,
): SeriesCatalog {
  const episodes = input.episodes.slice(0, MAX_EPISODES).map((episode) => ({
    sceneId: episode.sceneId.trim(),
    ...(cleanText(episode.title, 120)
      ? { title: cleanText(episode.title, 120) }
      : {}),
    ...(cleanI18n(episode.titleI18n, 120)
      ? { titleI18n: cleanI18n(episode.titleI18n, 120) }
      : {}),
    ...(cleanHttpUrl(episode.teaserUrl)
      ? { teaserUrl: cleanHttpUrl(episode.teaserUrl) }
      : {}),
  }));
  const next: StoredSeries = {
    id,
    title: input.title.trim().slice(0, 120),
    ...(cleanI18n(input.titleI18n, 120)
      ? { titleI18n: cleanI18n(input.titleI18n, 120) }
      : {}),
    ...(cleanText(input.modelName, 60)
      ? { modelName: cleanText(input.modelName, 60) }
      : {}),
    ...(cleanHttpUrl(input.coverUrl)
      ? { coverUrl: cleanHttpUrl(input.coverUrl) }
      : {}),
    freeEpisodes: clampFree(input.freeEpisodes, episodes.length),
    active: input.active !== false,
    sortOrder: Number.isFinite(input.sortOrder)
      ? Math.trunc(input.sortOrder as number)
      : 0,
    episodes,
    updatedAt: now.toISOString(),
  };
  const others = catalog.series.filter((series) => series.id !== id);
  return { version: 1, series: [...others, next].slice(-MAX_SERIES) };
}

export function removeSeries(
  catalog: SeriesCatalog,
  id: string,
): { catalog: SeriesCatalog; removed: boolean } {
  const series = catalog.series.filter((item) => item.id !== id);
  return {
    catalog: { version: 1, series },
    removed: series.length !== catalog.series.length,
  };
}

/** Cenas dos episódios trancados (as que o lockInLibrary tira da parede pública). */
export function lockedSceneIds(
  series: Pick<StoredSeries, 'episodes' | 'freeEpisodes'>,
): string[] {
  return series.episodes
    .slice(series.freeEpisodes)
    .map((episode) => episode.sceneId);
}
