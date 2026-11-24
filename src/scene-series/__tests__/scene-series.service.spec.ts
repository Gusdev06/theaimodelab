import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import * as sharp from 'sharp';
import type { PrismaService } from '../../prisma/prisma.service';
import { SceneSeriesService } from '../scene-series.service';
import {
  SCENE_SERIES_SETTING_KEY,
  serializeCatalog,
  upsertSeries,
} from '../scene-series.logic';

type Row = {
  id: string;
  title: string;
  type: string;
  prompt: string;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  aiModel: string | null;
  isActive: boolean;
  category: {
    id: string;
    title: string;
    section: { slug: string; title: string; isActive: boolean };
  };
};

function row(id: string, isActive = false): Row {
  return {
    id,
    title: `Cena ${id}`,
    type: 'image_to_video',
    prompt: `she looks back ${id}`,
    imageUrl: `https://cdn.test/${id}.mp4`,
    thumbnailUrl: `https://cdn.test/${id}.jpg`,
    aiModel: null,
    isActive,
    category: {
      id: 'cat',
      title: 'Piscina',
      section: { slug: '18-cenas', title: '18+ Cenas', isActive: true },
    },
  };
}

function setup(
  opts: {
    flag?: string;
    catalog?: string;
    rows?: Row[];
    subscriber?: boolean;
  } = {},
) {
  const settings = new Map<string, string>();
  if (opts.catalog) settings.set(SCENE_SERIES_SETTING_KEY, opts.catalog);
  const rows = opts.rows ?? [];
  const prisma = {
    appSetting: {
      findUnique: jest.fn(({ where }: { where: { key: string } }) =>
        Promise.resolve(
          settings.has(where.key)
            ? { key: where.key, value: settings.get(where.key)! }
            : null,
        ),
      ),
      upsert: jest.fn(
        ({
          where,
          create,
        }: {
          where: { key: string };
          create: { value: string };
        }) => {
          settings.set(where.key, create.value);
          return Promise.resolve({ key: where.key, value: create.value });
        },
      ),
    },
    promptTemplate: {
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(rows.filter((item) => where.id.in.includes(item.id))),
      ),
      updateMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve({
          count: rows.filter(
            (item) => where.id.in.includes(item.id) && item.isActive,
          ).length,
        }),
      ),
    },
    subscription: {
      findFirst: jest.fn(() =>
        Promise.resolve(opts.subscriber ? { id: 'sub' } : null),
      ),
    },
  };
  const config = {
    get: jest.fn((key: string) =>
      key === 'SCENE_SERIES_ENABLED' ? opts.flag : undefined,
    ),
  };
  const service = new SceneSeriesService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
  );
  return { service, prisma, settings };
}

const CATALOG = serializeCatalog(
  upsertSeries(
    { version: 1, series: [] },
    'vizinha',
    {
      title: 'A vizinha',
      episodes: ['a', 'b', 'c', 'd'].map((sceneId) => ({ sceneId })),
    },
    new Date('2026-11-24T00:00:00Z'),
  ),
);
const ROWS = ['a', 'b', 'c', 'd'].map((id) => row(id));

describe('SceneSeriesService · flag desligada (comportamento de hoje)', () => {
  it('a rota pública devolve vazio sem tocar no banco', async () => {
    const { service, prisma } = setup({ catalog: CATALOG, rows: ROWS });
    await expect(service.listPublic({ userId: 'u1' })).resolves.toEqual({
      enabled: false,
      unlocked: false,
      series: [],
    });
    expect(prisma.appSetting.findUnique).not.toHaveBeenCalled();
    expect(prisma.promptTemplate.findMany).not.toHaveBeenCalled();
  });

  it('o teaser responde 404', async () => {
    const { service } = setup({ flag: 'off', catalog: CATALOG, rows: ROWS });
    await expect(service.teaser('vizinha', 3)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('SceneSeriesService · flag ligada', () => {
  it('visitante: 2 episódios abertos e o resto trancado sem mídia', async () => {
    const { service, prisma } = setup({
      flag: 'on',
      catalog: CATALOG,
      rows: ROWS,
    });
    const response = await service.listPublic({});
    expect(response.enabled).toBe(true);
    expect(response.unlocked).toBe(false);
    expect(
      response.series[0].episodes.map((episode) => episode.locked),
    ).toEqual([false, false, true, true]);
    expect(JSON.stringify(response)).not.toContain('https://cdn.test/c.mp4');
    expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
  });

  it('assinante ativo vê a série inteira; admin também, sem consultar assinatura', async () => {
    const subscriber = setup({
      flag: 'on',
      catalog: CATALOG,
      rows: ROWS,
      subscriber: true,
    });
    const asSubscriber = await subscriber.service.listPublic({
      userId: 'u1',
      role: 'USER',
    });
    expect(asSubscriber.unlocked).toBe(true);
    expect(asSubscriber.series[0].lockedCount).toBe(0);

    const admin = setup({ flag: 'on', catalog: CATALOG, rows: ROWS });
    const asAdmin = await admin.service.listPublic({
      userId: 'adm',
      role: 'ADMIN',
    });
    expect(asAdmin.unlocked).toBe(true);
    expect(admin.prisma.subscription.findFirst).not.toHaveBeenCalled();
  });

  it('conta sem assinatura continua trancada', async () => {
    const { service } = setup({
      flag: 'on',
      catalog: CATALOG,
      rows: ROWS,
      subscriber: false,
    });
    const response = await service.listPublic({ userId: 'u2', role: 'USER' });
    expect(response.unlocked).toBe(false);
    expect(response.series[0].lockedCount).toBe(2);
  });

  it('teaser: baixa o 1º quadro e devolve JPEG borrado; episódio aberto = 404', async () => {
    const { service } = setup({ flag: 'on', catalog: CATALOG, rows: ROWS });
    const png = await sharp({
      create: {
        width: 90,
        height: 160,
        channels: 3,
        background: { r: 200, g: 60, b: 90 },
      },
    })
      .png()
      .toBuffer();
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(new Uint8Array(png), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    try {
      const image = await service.teaser('vizinha', 3);
      const meta = await sharp(image).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBe(360);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://cdn.test/c.jpg',
        expect.anything(),
      );
      // 2ª vez sai do cache
      await service.teaser('vizinha', 3);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await expect(service.teaser('vizinha', 1)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('SceneSeriesService · admin', () => {
  it('grava a série na app_settings e devolve o aviso de episódio trancado visível na parede', async () => {
    const rows = [row('a', true), row('b', true), row('c', true)];
    const { service, settings } = setup({ rows });
    const result = await service.adminUpsert('nova', {
      title: 'Nova',
      episodes: [{ sceneId: 'a' }, { sceneId: 'b' }, { sceneId: 'c' }],
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.lockedInLibrary).toBe(0);
    expect(
      (
        JSON.parse(settings.get(SCENE_SERIES_SETTING_KEY)!) as {
          series: Array<{ id: string }>;
        }
      ).series[0].id,
    ).toBe('nova');
  });

  it('lockInLibrary tira da parede pública só os episódios trancados', async () => {
    const rows = [
      row('a', true),
      row('b', true),
      row('c', true),
      row('d', true),
    ];
    const { service, prisma } = setup({ rows });
    const result = await service.adminUpsert(
      'nova',
      {
        title: 'Nova',
        episodes: ['a', 'b', 'c', 'd'].map((sceneId) => ({ sceneId })),
      },
      { lockInLibrary: true },
    );
    expect(prisma.promptTemplate.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['c', 'd'] }, isActive: true },
      data: { isActive: false },
    });
    expect(result.lockedInLibrary).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  it('erro de validação vira 400 e não grava nada', async () => {
    const { service, prisma } = setup({ rows: [row('a')] });
    await expect(
      service.adminUpsert('nova', {
        title: 'Nova',
        episodes: [{ sceneId: 'a' }, { sceneId: 'x' }, { sceneId: 'y' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.appSetting.upsert).not.toHaveBeenCalled();
  });

  it('apagar série inexistente = 404', async () => {
    const { service } = setup({ catalog: CATALOG });
    await expect(service.adminRemove('nao-existe')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.adminRemove('vizinha')).resolves.toEqual({
      removed: true,
    });
  });
});
