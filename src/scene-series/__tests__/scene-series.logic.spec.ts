import {
  buildPublicSeries,
  findForbiddenTheme,
  lockedSceneIds,
  parseCatalog,
  parseSeriesFlag,
  removeSeries,
  serializeCatalog,
  teaserSourceFor,
  upsertSeries,
  validateSeriesInput,
  type EpisodeSource,
  type PublicLockedEpisode,
  type PublicOpenEpisode,
  type SeriesCatalog,
} from '../scene-series.logic';

function source(id: string, over: Partial<EpisodeSource> = {}): EpisodeSource {
  return {
    id,
    title: `Cena ${id}`,
    type: 'image_to_video',
    prompt: `she smiles at the camera ${id}`,
    imageUrl: `https://cdn.test/${id}.mp4`,
    thumbnailUrl: `https://cdn.test/${id}.jpg`,
    aiModel: 'wan',
    visibleInLibrary: false,
    sectionSlug: '18-cenas',
    sectionTitle: '18+ Cenas',
    categoryId: 'cat-1',
    categoryTitle: 'Piscina',
    ...over,
  };
}

function sourcesOf(...items: EpisodeSource[]): Map<string, EpisodeSource> {
  return new Map(items.map((item) => [item.id, item]));
}

const NOW = new Date('2026-11-24T12:00:00.000Z');

function catalogWith(
  ids: string[],
  over: Partial<Parameters<typeof upsertSeries>[2]> = {},
): SeriesCatalog {
  return upsertSeries(
    { version: 1, series: [] },
    'vizinha-piscina',
    {
      title: 'A vizinha da piscina',
      modelName: 'Mia',
      episodes: ids.map((sceneId) => ({ sceneId })),
      ...over,
    },
    NOW,
  );
}

describe('parseSeriesFlag', () => {
  it('desligado por padrão e com qualquer valor que não seja on/true/1/yes', () => {
    expect(parseSeriesFlag(undefined)).toBe(false);
    expect(parseSeriesFlag('')).toBe(false);
    expect(parseSeriesFlag('off')).toBe(false);
    expect(parseSeriesFlag('0')).toBe(false);
    expect(parseSeriesFlag('ON')).toBe(true);
    expect(parseSeriesFlag(' true ')).toBe(true);
    expect(parseSeriesFlag('1')).toBe(true);
  });
});

describe('parseCatalog', () => {
  it('JSON quebrado ou ausente = catálogo vazio (a rota nunca cai)', () => {
    expect(parseCatalog(undefined).series).toEqual([]);
    expect(parseCatalog('{nope').series).toEqual([]);
    expect(parseCatalog('{"series": 3}').series).toEqual([]);
  });

  it('descarta série com id inválido, sem título ou sem episódio, e mantém o resto', () => {
    const raw = JSON.stringify({
      series: [
        { id: 'Bad Id', title: 'x', episodes: [{ sceneId: 'a' }] },
        { id: 'sem-titulo', episodes: [{ sceneId: 'a' }] },
        { id: 'vazia', title: 'Vazia', episodes: [] },
        {
          id: 'boa',
          title: 'Boa',
          episodes: [{ sceneId: 'a' }, { sceneId: 'b' }, { sceneId: 'c' }],
          freeEpisodes: 9,
        },
      ],
    });
    const catalog = parseCatalog(raw);
    expect(catalog.series.map((series) => series.id)).toEqual(['boa']);
    // freeEpisodes nunca abre a série inteira: pelo menos 1 fica com cadeado
    expect(catalog.series[0].freeEpisodes).toBe(2);
  });

  it('ida e volta pelo JSON da app_settings preserva a série', () => {
    const catalog = catalogWith(['a', 'b', 'c']);
    expect(parseCatalog(serializeCatalog(catalog))).toEqual(catalog);
  });
});

describe('buildPublicSeries', () => {
  const sources = sourcesOf(source('a'), source('b'), source('c'), source('d'));

  it('quem não assina: ep. 1 e 2 inteiros, do 3 em diante só título e 1º quadro borrado, sem URL de mídia', () => {
    const [series] = buildPublicSeries(
      catalogWith(['a', 'b', 'c', 'd']),
      sources,
      { unlocked: false },
    );
    expect(series.episodeCount).toBe(4);
    expect(series.lockedCount).toBe(2);
    const [ep1, ep2, ep3, ep4] = series.episodes;
    expect(ep1.locked).toBe(false);
    expect((ep1 as PublicOpenEpisode).scene.imageUrl).toBe(
      'https://cdn.test/a.mp4',
    );
    expect(ep2.locked).toBe(false);
    expect(ep3.locked).toBe(true);
    expect((ep3 as PublicLockedEpisode).teaserUrl).toBe(
      `/api/v1/scene-series/vizinha-piscina/episodes/3/teaser?v=${NOW.getTime()}`,
    );
    expect(ep4.number).toBe(4);

    // nada dos episódios trancados vaza no payload: nem a URL, nem o id da cena, nem o prompt
    const payload = JSON.stringify(series);
    for (const id of ['c', 'd']) {
      expect(payload).not.toContain(`https://cdn.test/${id}.mp4`);
      expect(payload).not.toContain(`https://cdn.test/${id}.jpg`);
      expect(payload).not.toContain(`camera ${id}`);
      expect(payload).not.toContain(`"id":"${id}"`);
    }
  });

  it('assinante (ou admin) vê todos os episódios abertos', () => {
    const [series] = buildPublicSeries(
      catalogWith(['a', 'b', 'c', 'd']),
      sources,
      { unlocked: true },
    );
    expect(series.lockedCount).toBe(0);
    expect(series.episodes.every((episode) => !episode.locked)).toBe(true);
  });

  it('respeita os episódios abertos escolhidos pelo dono', () => {
    const [series] = buildPublicSeries(
      catalogWith(['a', 'b', 'c', 'd'], { freeEpisodes: 1 }),
      sources,
      { unlocked: false },
    );
    expect(series.episodes.map((episode) => episode.locked)).toEqual([
      false,
      true,
      true,
      true,
    ]);
  });

  it('cena apagada sai da fila e os números seguem corridos; série com menos de 2 vivos some', () => {
    const live = sourcesOf(source('a'), source('c'), source('d'));
    const [series] = buildPublicSeries(
      catalogWith(['a', 'b', 'c', 'd']),
      live,
      { unlocked: false },
    );
    expect(series.episodes.map((episode) => episode.number)).toEqual([1, 2, 3]);
    expect(series.episodes.map((episode) => episode.locked)).toEqual([
      false,
      false,
      true,
    ]);
    expect(
      buildPublicSeries(catalogWith(['a', 'b', 'c']), sourcesOf(source('a')), {
        unlocked: false,
      }),
    ).toEqual([]);
  });

  it('série inativa não aparece', () => {
    expect(
      buildPublicSeries(
        catalogWith(['a', 'b', 'c'], { active: false }),
        sources,
        { unlocked: false },
      ),
    ).toEqual([]);
  });

  it('teaser enviado pelo dono vence; sem imagem parada, o card trancado fica sem teaser', () => {
    const catalog = upsertSeries(
      { version: 1, series: [] },
      's1',
      {
        title: 'S1',
        episodes: [
          { sceneId: 'a' },
          { sceneId: 'b' },
          { sceneId: 'c', teaserUrl: 'https://cdn.test/blur-c.jpg' },
          { sceneId: 'v' },
        ],
      },
      NOW,
    );
    const withVideoOnly = sourcesOf(
      source('a'),
      source('b'),
      source('c'),
      source('v', { thumbnailUrl: 'https://cdn.test/v-card.mp4' }),
    );
    const [series] = buildPublicSeries(catalog, withVideoOnly, {
      unlocked: false,
    });
    expect((series.episodes[2] as PublicLockedEpisode).teaserUrl).toBe(
      'https://cdn.test/blur-c.jpg',
    );
    expect((series.episodes[3] as PublicLockedEpisode).teaserUrl).toBeNull();
    expect(JSON.stringify(series)).not.toContain('v-card.mp4');
  });
});

describe('teaserSourceFor', () => {
  const sources = sourcesOf(source('a'), source('b'), source('c'));
  const catalog = catalogWith(['a', 'b', 'c']);

  it('só episódio trancado de série ativa tem teaser', () => {
    expect(teaserSourceFor(catalog, sources, 'vizinha-piscina', 3)).toBe(
      'https://cdn.test/c.jpg',
    );
    expect(teaserSourceFor(catalog, sources, 'vizinha-piscina', 1)).toBeNull();
    expect(teaserSourceFor(catalog, sources, 'vizinha-piscina', 4)).toBeNull();
    expect(teaserSourceFor(catalog, sources, 'outra', 3)).toBeNull();
  });
});

describe('validateSeriesInput', () => {
  const sources = sourcesOf(
    source('a'),
    source('b'),
    source('c', { visibleInLibrary: true }),
    source('d'),
  );

  it('aceita 3 a 12 cenas existentes e avisa quando o episódio trancado ainda aparece na parede pública', () => {
    const { errors, warnings } = validateSeriesInput(
      'vizinha-piscina',
      {
        title: 'A vizinha',
        episodes: [{ sceneId: 'a' }, { sceneId: 'b' }, { sceneId: 'c' }],
      },
      sources,
    );
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Episódio 3');
  });

  it('barra quantidade errada, cena inexistente, repetida e freeEpisodes que abriria tudo', () => {
    const { errors } = validateSeriesInput(
      'x-1',
      {
        title: 'T',
        freeEpisodes: 2,
        episodes: [{ sceneId: 'a' }, { sceneId: 'a' }],
      },
      sources,
    );
    expect(errors.join(' ')).toContain('3 a 12');
    expect(errors.join(' ')).toContain('cena repetida');
    expect(errors.join(' ')).toContain('freeEpisodes');
    const missing = validateSeriesInput(
      'x-1',
      {
        title: 'T',
        episodes: [{ sceneId: 'a' }, { sceneId: 'b' }, { sceneId: 'zz' }],
      },
      sources,
    );
    expect(missing.errors.join(' ')).toContain('zz');
  });

  it('barra tema família/step e a palavra teen (título do dono ou texto da cena); daddy e universitária passam', () => {
    const step = validateSeriesInput(
      'x-1',
      {
        title: 'Stepsister na piscina',
        episodes: [{ sceneId: 'a' }, { sceneId: 'b' }, { sceneId: 'd' }],
      },
      sources,
    );
    expect(step.errors.join(' ')).toContain('tema');
    const inPrompt = validateSeriesInput(
      'x-1',
      {
        title: 'Noite',
        episodes: [{ sceneId: 'a' }, { sceneId: 'b' }, { sceneId: 'm' }],
      },
      sourcesOf(
        source('a'),
        source('b'),
        source('m', { prompt: 'her stepmom walks in' }),
      ),
    );
    expect(inPrompt.errors.join(' ')).toContain('tema');
    expect(findForbiddenTheme(['teen party'])).toBe('teen');
    expect(findForbiddenTheme(['A madrasta chegou'])).toBe('madrasta');
    expect(
      findForbiddenTheme([
        'Daddy chegou cedo',
        'A universitária da biblioteca',
        'eighteen candles',
      ]),
    ).toBeNull();
  });
});

describe('upsertSeries / removeSeries / lockedSceneIds', () => {
  it('troca a série pelo id sem mexer nas outras', () => {
    let catalog = catalogWith(['a', 'b', 'c']);
    catalog = upsertSeries(
      catalog,
      'outra',
      {
        title: 'Outra',
        episodes: [{ sceneId: 'x' }, { sceneId: 'y' }, { sceneId: 'z' }],
      },
      NOW,
    );
    catalog = upsertSeries(
      catalog,
      'vizinha-piscina',
      {
        title: 'Nova',
        episodes: [
          { sceneId: 'a' },
          { sceneId: 'b' },
          { sceneId: 'c' },
          { sceneId: 'd' },
        ],
      },
      NOW,
    );
    expect(catalog.series.map((series) => series.id).sort()).toEqual([
      'outra',
      'vizinha-piscina',
    ]);
    expect(
      catalog.series.find((series) => series.id === 'vizinha-piscina')!.title,
    ).toBe('Nova');
    const { catalog: after, removed } = removeSeries(catalog, 'outra');
    expect(removed).toBe(true);
    expect(after.series.map((series) => series.id)).toEqual([
      'vizinha-piscina',
    ]);
    expect(removeSeries(after, 'nao-existe').removed).toBe(false);
  });

  it('lista as cenas trancadas (do freeEpisodes em diante)', () => {
    const [series] = catalogWith(['a', 'b', 'c', 'd']).series;
    expect(lockedSceneIds(series)).toEqual(['c', 'd']);
  });
});
