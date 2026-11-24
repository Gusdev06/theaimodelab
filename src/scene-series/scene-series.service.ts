import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sharp from 'sharp';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildPublicSeries,
  lockedSceneIds,
  parseCatalog,
  parseSeriesFlag,
  removeSeries,
  resolvedEpisodes,
  SCENE_SERIES_SETTING_KEY,
  serializeCatalog,
  teaserSourceFor,
  upsertSeries,
  validateSeriesInput,
  type EpisodeSource,
  type PublicSeriesResponse,
  type SeriesCatalog,
  type SeriesInput,
} from './scene-series.logic';

/** Catálogo em memória: 1 leitura da app_settings a cada 30 s no máximo (a escrita do admin limpa na hora). */
const CATALOG_TTL_MS = 30_000;
/** Assinatura que renova com atraso no gateway não tranca a série no dia da renovação. */
const RENEWAL_GRACE_MS = 3 * 24 * 3_600_000;
/** Teasers borrados guardados (um por cena trancada; o conjunto é pequeno e fechado pelo catálogo). */
const TEASER_CACHE_MAX = 200;
const TEASER_FETCH_TIMEOUT_MS = 8_000;
const TEASER_MAX_SOURCE_BYTES = 15 * 1024 * 1024;
/** Largura de onde a imagem é reduzida antes do borrão: abaixo disso não dá para reconstruir o quadro. */
const TEASER_PIXELATE_WIDTH = 32;
const TEASER_OUTPUT_WIDTH = 360;

export interface SeriesViewer {
  userId?: string | null;
  role?: string | null;
}

export interface AdminSeriesView {
  enabled: boolean;
  series: Array<
    SeriesCatalog['series'][number] & {
      episodesResolved: Array<{
        number: number;
        sceneId: string;
        title: string | null;
        type: string | null;
        visibleInLibrary: boolean | null;
        locked: boolean;
        missing: boolean;
      }>;
    }
  >;
}

@Injectable()
export class SceneSeriesService {
  private readonly logger = new Logger(SceneSeriesService.name);
  private catalogCache: { at: number; catalog: SeriesCatalog } | null = null;
  private readonly teaserCache = new Map<string, Buffer>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** SCENE_SERIES_ENABLED (on/true/1): desligado = a rota pública devolve vazio e o teaser 404, como se não existisse. */
  isEnabled(): boolean {
    return parseSeriesFlag(this.config.get<string>('SCENE_SERIES_ENABLED'));
  }

  async readCatalog(fresh = false): Promise<SeriesCatalog> {
    const now = Date.now();
    if (
      !fresh &&
      this.catalogCache &&
      now - this.catalogCache.at < CATALOG_TTL_MS
    )
      return this.catalogCache.catalog;
    const row = await this.prisma.appSetting.findUnique({
      where: { key: SCENE_SERIES_SETTING_KEY },
    });
    const catalog = parseCatalog(row?.value);
    this.catalogCache = { at: now, catalog };
    return catalog;
  }

  private async writeCatalog(catalog: SeriesCatalog): Promise<void> {
    const value = serializeCatalog(catalog);
    await this.prisma.appSetting.upsert({
      where: { key: SCENE_SERIES_SETTING_KEY },
      update: { value },
      create: { key: SCENE_SERIES_SETTING_KEY, value },
    });
    this.catalogCache = { at: Date.now(), catalog };
    this.teaserCache.clear();
  }

  /** As cenas do acervo por id, ativas ou não (episódio trancado costuma ficar fora da parede pública). */
  async loadSources(
    ids: readonly string[],
  ): Promise<Map<string, EpisodeSource>> {
    const unique = [...new Set(ids)].filter(Boolean);
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.promptTemplate.findMany({
      where: { id: { in: unique } },
      select: {
        id: true,
        title: true,
        type: true,
        prompt: true,
        imageUrl: true,
        thumbnailUrl: true,
        aiModel: true,
        isActive: true,
        category: {
          select: {
            id: true,
            title: true,
            section: { select: { slug: true, title: true, isActive: true } },
          },
        },
      },
    });
    const out = new Map<string, EpisodeSource>();
    for (const row of rows) {
      out.set(row.id, {
        id: row.id,
        title: row.title,
        type: row.type,
        prompt: row.prompt,
        imageUrl: row.imageUrl,
        thumbnailUrl: row.thumbnailUrl,
        aiModel: row.aiModel,
        visibleInLibrary: row.isActive && row.category.section.isActive,
        sectionSlug: row.category.section.slug,
        sectionTitle: row.category.section.title,
        categoryId: row.category.id,
        categoryTitle: row.category.title,
      });
    }
    return out;
  }

  /** Vê a série inteira: admin ou assinatura ativa (com a folga da renovação). */
  async viewerUnlocked(viewer: SeriesViewer): Promise<boolean> {
    if (!viewer.userId) return false;
    if (viewer.role === 'ADMIN') return true;
    const active = await this.prisma.subscription.findFirst({
      where: {
        userId: viewer.userId,
        status: 'ACTIVE',
        currentPeriodEnd: { gt: new Date(Date.now() - RENEWAL_GRACE_MS) },
      },
      select: { id: true },
    });
    return !!active;
  }

  async listPublic(viewer: SeriesViewer): Promise<PublicSeriesResponse> {
    if (!this.isEnabled())
      return { enabled: false, unlocked: false, series: [] };
    const catalog = await this.readCatalog();
    const active = catalog.series.filter((series) => series.active);
    if (active.length === 0)
      return { enabled: true, unlocked: false, series: [] };
    const [sources, unlocked] = await Promise.all([
      this.loadSources(
        active.flatMap((series) =>
          series.episodes.map((episode) => episode.sceneId),
        ),
      ),
      this.viewerUnlocked(viewer),
    ]);
    return {
      enabled: true,
      unlocked,
      series: buildPublicSeries(catalog, sources, { unlocked }),
    };
  }

  /**
   * 1º quadro do episódio trancado, reduzido a 32 px e ampliado com borrão: dá a cor e a silhueta, nunca a cena.
   * Só existe para episódio trancado de série ativa; o resultado fica em memória (conjunto fechado pelo catálogo).
   */
  async teaser(seriesId: string, episodeNumber: number): Promise<Buffer> {
    if (!this.isEnabled()) throw new NotFoundException();
    const catalog = await this.readCatalog();
    const series = catalog.series.find((item) => item.id === seriesId);
    if (!series) throw new NotFoundException();
    const sources = await this.loadSources(
      series.episodes.map((episode) => episode.sceneId),
    );
    const sourceUrl = teaserSourceFor(
      catalog,
      sources,
      seriesId,
      episodeNumber,
    );
    if (!sourceUrl) throw new NotFoundException();
    const cached = this.teaserCache.get(sourceUrl);
    if (cached) return cached;
    const blurred = await this.blurRemoteImage(sourceUrl);
    if (this.teaserCache.size >= TEASER_CACHE_MAX) {
      for (const oldest of this.teaserCache.keys()) {
        this.teaserCache.delete(oldest);
        break;
      }
    }
    this.teaserCache.set(sourceUrl, blurred);
    return blurred;
  }

  private async blurRemoteImage(url: string): Promise<Buffer> {
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(TEASER_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.warn(
        `teaser: falha ao baixar o quadro (${(err as Error).message})`,
      );
      throw new NotFoundException();
    }
    if (!response.ok) throw new NotFoundException();
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > TEASER_MAX_SOURCE_BYTES) throw new NotFoundException();
    const source = Buffer.from(await response.arrayBuffer());
    if (source.length === 0 || source.length > TEASER_MAX_SOURCE_BYTES)
      throw new NotFoundException();
    try {
      const tiny = await sharp(source, { animated: false })
        .rotate()
        .resize({ width: TEASER_PIXELATE_WIDTH, withoutEnlargement: false })
        .toBuffer();
      return await sharp(tiny)
        .resize({ width: TEASER_OUTPUT_WIDTH, kernel: 'cubic' })
        .blur(8)
        .jpeg({ quality: 62 })
        .toBuffer();
    } catch (err) {
      this.logger.warn(`teaser: imagem ilegível (${(err as Error).message})`);
      throw new NotFoundException();
    }
  }

  // ---------- admin ----------

  async adminList(): Promise<AdminSeriesView> {
    const catalog = await this.readCatalog(true);
    const sources = await this.loadSources(
      catalog.series.flatMap((series) =>
        series.episodes.map((episode) => episode.sceneId),
      ),
    );
    return {
      enabled: this.isEnabled(),
      series: catalog.series.map((series) => {
        const liveIds = new Set(
          resolvedEpisodes(series, sources).map(
            ({ episode }) => episode.sceneId,
          ),
        );
        let liveIndex = 0;
        return {
          ...series,
          episodesResolved: series.episodes.map((episode) => {
            const source = sources.get(episode.sceneId) ?? null;
            const missing = !liveIds.has(episode.sceneId);
            const number = missing ? 0 : (liveIndex += 1);
            return {
              number,
              sceneId: episode.sceneId,
              title: source?.title ?? null,
              type: source?.type ?? null,
              visibleInLibrary: source ? source.visibleInLibrary : null,
              locked: !missing && number > series.freeEpisodes,
              missing,
            };
          }),
        };
      }),
    };
  }

  async adminUpsert(
    id: string,
    input: SeriesInput,
    options: { lockInLibrary?: boolean } = {},
  ): Promise<{
    series: SeriesCatalog['series'][number];
    warnings: string[];
    lockedInLibrary: number;
  }> {
    const sources = await this.loadSources(
      input.episodes.map((episode) => episode.sceneId),
    );
    const { errors, warnings } = validateSeriesInput(id, input, sources);
    if (errors.length > 0)
      throw new BadRequestException({
        message: errors,
        code: 'SCENE_SERIES_INVALID',
      });
    const catalog = await this.readCatalog(true);
    const next = upsertSeries(catalog, id, input, new Date());
    const saved = next.series.find((series) => series.id === id)!;
    let lockedInLibrary = 0;
    if (options.lockInLibrary) {
      // escolha do dono: os episódios trancados saem da parede pública (/api/v1/prompts) e só aparecem pela série
      const result = await this.prisma.promptTemplate.updateMany({
        where: { id: { in: lockedSceneIds(saved) }, isActive: true },
        data: { isActive: false },
      });
      lockedInLibrary = result.count;
    }
    await this.writeCatalog(next);
    return {
      series: saved,
      warnings: options.lockInLibrary ? [] : warnings,
      lockedInLibrary,
    };
  }

  async adminRemove(id: string): Promise<{ removed: boolean }> {
    const catalog = await this.readCatalog(true);
    const { catalog: next, removed } = removeSeries(catalog, id);
    if (!removed) throw new NotFoundException(`Série ${id} não existe`);
    await this.writeCatalog(next);
    return { removed };
  }
}
