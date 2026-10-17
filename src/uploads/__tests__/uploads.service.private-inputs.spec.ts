import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import {
  DEFAULT_INPUT_URL_TTL_SECONDS,
  PRIVATE_INPUT_CACHE_CONTROL,
  StorageDeleteError,
  UploadsService,
} from '../uploads.service';

/**
 * Cache curto da mídia pública e entradas privadas (S3_INPUT_PRIVATE_BUCKET): bucket certo, Cache-Control certo, URL
 * assinada com a validade certa, limpeza nos dois buckets e o comportamento antigo quando a env não existe.
 */
describe('UploadsService · cache curto e entradas privadas', () => {
  const PUBLIC_BUCKET = 'ai-generations';
  const PRIVATE_BUCKET = 'taml-inputs-private';
  const CDN = 'https://cdn.exemplo.com/storage/v1/object/public/ai-generations';

  const env = (overrides: Record<string, string | undefined> = {}) => ({
    get: jest.fn((key: string, fallback?: string) => {
      const values: Record<string, string | undefined> = {
        S3_ENDPOINT: 'https://s3.exemplo.com',
        S3_REGION: 'us-east-1',
        S3_ACCESS_KEY: 'chave-de-teste',
        S3_SECRET_KEY: 'segredo-de-teste',
        S3_BUCKET_NAME: PUBLIC_BUCKET,
        S3_PUBLIC_URL: CDN,
        ...overrides,
      };
      return key in values ? (values[key] ?? fallback) : fallback;
    }),
  });
  const service = (overrides: Record<string, string | undefined> = {}) =>
    new UploadsService(env(overrides) as never);
  const withPrivate = (overrides: Record<string, string | undefined> = {}) =>
    service({ S3_INPUT_PRIVATE_BUCKET: PRIVATE_BUCKET, ...overrides });

  let send: jest.SpyInstance;
  let warn: jest.SpyInstance;

  const commands = () =>
    send.mock.calls.map(([command]) => ({
      kind: command.constructor.name as string,
      input: command.input as Record<string, unknown>,
    }));
  const puts = () => commands().filter((c) => c.kind === PutObjectCommand.name);
  const warnings = (fragment: string) =>
    warn.mock.calls.filter(([message]) => String(message).includes(fragment));

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    send = jest
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({} as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Cache-Control da mídia pública', () => {
    it('padrão: 1 dia, sem immutable, em uploadBuffer e uploadBufferPublic', async () => {
      const uploads = service();
      await uploads.uploadBuffer(
        Buffer.from('a'),
        'generations/g1',
        'out.png',
        'image/png',
      );
      await uploads.uploadBufferPublic(
        Buffer.from('b'),
        'outputs/g1',
        'out.png',
        'image/png',
      );

      expect(puts().map((p) => p.input.CacheControl)).toEqual([
        'public, max-age=86400',
        'public, max-age=86400',
      ]);
      expect(puts().every((p) => p.input.Bucket === PUBLIC_BUCKET)).toBe(true);
    });

    it('uploadFromUrl também grava o cache curto', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(Buffer.from('png'), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      );
      const url = await service().uploadFromUrl(
        'https://provedor.exemplo/x.png',
        'generations/g1',
        'o.png',
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(url.startsWith(`${CDN}/generations/g1/`)).toBe(true);
      expect(puts()[0].input.CacheControl).toBe('public, max-age=86400');
    });

    it('MEDIA_CACHE_MAX_AGE válido vale', async () => {
      await service({ MEDIA_CACHE_MAX_AGE: '3600' }).uploadBuffer(
        Buffer.from('a'),
        'generations/g1',
        'o.png',
        'image/png',
      );
      expect(puts()[0].input.CacheControl).toBe('public, max-age=3600');
    });

    it.each(['abc', '-5', '1.5', '999999999999'])(
      'MEDIA_CACHE_MAX_AGE inválido (%s) usa o padrão e avisa',
      async (raw) => {
        const uploads = service({ MEDIA_CACHE_MAX_AGE: raw });
        await uploads.uploadBuffer(
          Buffer.from('a'),
          'generations/g1',
          'o.png',
          'image/png',
        );
        expect(puts()[0].input.CacheControl).toBe('public, max-age=86400');
        expect(warnings('MEDIA_CACHE_MAX_AGE')).toHaveLength(1);
      },
    );
  });

  describe('entradas com S3_INPUT_PRIVATE_BUCKET', () => {
    it('grava no bucket privado com private, no-store e devolve URL assinada de 7200 s', async () => {
      const uploads = withPrivate();
      const stored = await uploads.uploadGenerationInput(
        Buffer.from('foto'),
        'gen_abc123',
        'input.jpeg',
        'image/jpeg',
      );

      expect(stored.isPrivate).toBe(true);
      expect(stored.key).toMatch(
        /^inputs\/gen_abc123\/[0-9a-f-]{36}\/input\.jpeg$/,
      );
      expect(puts()).toHaveLength(1);
      expect(puts()[0].input).toMatchObject({
        Bucket: PRIVATE_BUCKET,
        Key: stored.key,
        CacheControl: PRIVATE_INPUT_CACHE_CONTROL,
        ContentType: 'image/jpeg',
      });

      const signed = new URL(stored.url);
      expect(signed.pathname).toBe(`/${PRIVATE_BUCKET}/${stored.key}`);
      expect(signed.searchParams.get('X-Amz-Expires')).toBe(
        String(DEFAULT_INPUT_URL_TTL_SECONDS),
      );
      expect(signed.searchParams.get('X-Amz-Signature')).toBeTruthy();
      expect(stored.url.startsWith(CDN)).toBe(false);
      expect(uploads.privateInputsEnabled).toBe(true);
      expect(warnings('S3_INPUT_PRIVATE_BUCKET')).toHaveLength(0);
    });

    it('SAFETY_INPUT_URL_TTL configura a validade da assinatura', async () => {
      const stored = await withPrivate({
        SAFETY_INPUT_URL_TTL: '5400',
      }).uploadGenerationInput(
        Buffer.from('foto'),
        'gen_abc123',
        'input.png',
        'image/png',
      );
      expect(new URL(stored.url).searchParams.get('X-Amz-Expires')).toBe(
        '5400',
      );
    });

    // abaixo de 1 h a URL venceria dentro de uma tentativa de vídeo (até 45 min + busca assíncrona do provedor)
    it.each(['10', '1800', 'abc', '700000'])(
      'SAFETY_INPUT_URL_TTL inválido (%s) usa 7200 e avisa',
      async (raw) => {
        const uploads = withPrivate({ SAFETY_INPUT_URL_TTL: raw });
        const stored = await uploads.uploadGenerationInput(
          Buffer.from('foto'),
          'gen_abc123',
          'input.png',
          'image/png',
        );
        expect(new URL(stored.url).searchParams.get('X-Amz-Expires')).toBe(
          '7200',
        );
        expect(uploads.inputUrlTtl).toBe(7200);
        expect(warnings('SAFETY_INPUT_URL_TTL')).toHaveLength(1);
      },
    );

    it('getInputReadUrl reassina uma entrada guardada (evidência) e recusa chave fora de inputs/', async () => {
      const uploads = withPrivate();
      const fresh = new URL(
        await uploads.getInputReadUrl('inputs/gen_abc123/u/input.png', 120),
      );
      expect(fresh.pathname).toBe(
        `/${PRIVATE_BUCKET}/inputs/gen_abc123/u/input.png`,
      );
      expect(fresh.searchParams.get('X-Amz-Expires')).toBe('120');

      await expect(
        uploads.getInputReadUrl('outputs/gen_abc123/u/o.png'),
      ).rejects.toThrow(/fora da pasta de entradas/);
      await expect(
        uploads.getInputReadUrl('inputs/../outputs/x.png'),
      ).rejects.toThrow();
    });

    it('inputKeyFromUrl recupera a chave da URL assinada, da pública e ignora o que não é entrada', async () => {
      const uploads = withPrivate();
      const stored = await uploads.uploadGenerationInput(
        Buffer.from('foto'),
        'gen_abc123',
        'input.png',
        'image/png',
      );
      expect(uploads.inputKeyFromUrl(stored.url)).toBe(stored.key);
      expect(uploads.inputKeyFromUrl(`${CDN}/inputs/gen_old/u/input.png`)).toBe(
        'inputs/gen_old/u/input.png',
      );
      expect(
        uploads.inputKeyFromUrl(`${CDN}/outputs/gen_old/u/o.png`),
      ).toBeNull();
      expect(uploads.inputKeyFromUrl('não é url')).toBeNull();
      expect(uploads.inputKeyFromUrl(null)).toBeNull();
    });

    describe('refreshInputReadUrl (reassinar a cada envio ao provedor)', () => {
      const stale = (url: string) =>
        `${url.split('?')[0]}?X-Amz-Date=20200101T000000Z&X-Amz-Expires=3600&X-Amz-Signature=velha`;

      it('entrada do bucket privado da própria geração: URL nova, mesma chave, validade cheia', async () => {
        const uploads = withPrivate();
        const stored = await uploads.uploadGenerationInput(
          Buffer.from('foto'),
          'gen_abc123',
          'input.png',
          'image/png',
        );

        const refreshed = new URL(
          await uploads.refreshInputReadUrl(stale(stored.url), 'gen_abc123'),
        );

        expect(refreshed.pathname).toBe(`/${PRIVATE_BUCKET}/${stored.key}`);
        expect(refreshed.searchParams.get('X-Amz-Expires')).toBe(
          String(DEFAULT_INPUT_URL_TTL_SECONDS),
        );
        expect(refreshed.searchParams.get('X-Amz-Signature')).not.toBe('velha');
        expect(refreshed.searchParams.get('X-Amz-Date')).not.toBe(
          '20200101T000000Z',
        );
      });

      it('o que não é entrada privada desta geração volta igual (nunca assina outra pasta)', async () => {
        const uploads = withPrivate();
        const otherGeneration = stale(
          `https://s3.exemplo.com/${PRIVATE_BUCKET}/inputs/gen_outra/u/input.png`,
        );
        const cases = [
          // entrada de antes do bucket privado: continua no público (assinar no privado daria 404)
          `${CDN}/inputs/gen_abc123/u/input.png`,
          otherGeneration,
          stale(
            `https://s3.exemplo.com/${PRIVATE_BUCKET}/outputs/gen_abc123/u/o.png`,
          ),
          stale(
            `https://s3.exemplo.com/${PRIVATE_BUCKET}/inputs/gen_abc123/../gen_outra/x.png`,
          ),
          'https://provedor.exemplo/arquivo.png',
          'não é url',
          '',
        ];
        for (const url of cases) {
          expect(await uploads.refreshInputReadUrl(url, 'gen_abc123')).toBe(
            url,
          );
        }
        // id de geração que mudaria a pasta
        expect(await uploads.refreshInputReadUrl(otherGeneration, '')).toBe(
          otherGeneration,
        );
      });

      it('sem bucket privado: nada a reassinar, a URL volta igual', async () => {
        const uploads = service();
        const url = `${CDN}/inputs/gen_abc123/u/input.png`;
        expect(await uploads.refreshInputReadUrl(url, 'gen_abc123')).toBe(url);
      });

      it('modo simulado com bucket privado: URL simulada com a validade', async () => {
        const uploads = withPrivate({
          S3_ENDPOINT: undefined,
          S3_PUBLIC_URL: '',
        });
        const stored = await uploads.uploadGenerationInput(
          Buffer.from('foto'),
          'gen_abc123',
          'input.png',
          'image/png',
        );
        expect(
          await uploads.refreshInputReadUrl(stale(stored.url), 'gen_abc123'),
        ).toBe(stored.url);
      });
    });

    it('recusa id de geração ou nome de arquivo que mudaria a pasta', async () => {
      const uploads = withPrivate();
      await expect(
        uploads.uploadGenerationInput(
          Buffer.from('x'),
          '../outputs',
          'a.png',
          'image/png',
        ),
      ).rejects.toThrow(/Id de geração inválido/);
      await expect(
        uploads.uploadGenerationInput(
          Buffer.from('x'),
          'gen_abc123',
          '../a.png',
          'image/png',
        ),
      ).rejects.toThrow(/Nome de arquivo/);
      expect(send).not.toHaveBeenCalled();
    });

    it('bucket privado igual ao público é ignorado (seria servido pela URL pública)', async () => {
      const uploads = withPrivate({ S3_INPUT_PRIVATE_BUCKET: PUBLIC_BUCKET });
      const stored = await uploads.uploadGenerationInput(
        Buffer.from('foto'),
        'gen_abc123',
        'input.png',
        'image/png',
      );
      expect(stored.isPrivate).toBe(false);
      expect(puts()[0].input.Bucket).toBe(PUBLIC_BUCKET);
      expect(warnings('próprio bucket público')).toHaveLength(1);
    });
  });

  describe('entradas sem S3_INPUT_PRIVATE_BUCKET (comportamento atual)', () => {
    it('grava no bucket público com o cache curto e devolve a URL pública', async () => {
      const uploads = service();
      const stored = await uploads.uploadGenerationInput(
        Buffer.from('foto'),
        'gen_abc123',
        'input.png',
        'image/png',
      );
      expect(stored.isPrivate).toBe(false);
      expect(stored.url).toBe(`${CDN}/${stored.key}`);
      expect(puts()[0].input).toMatchObject({
        Bucket: PUBLIC_BUCKET,
        CacheControl: 'public, max-age=86400',
      });
      expect(uploads.privateInputsEnabled).toBe(false);
      expect(await uploads.getInputReadUrl(stored.key)).toBe(
        `${CDN}/${stored.key}`,
      );
    });

    it('avisa UMA vez no boot, não a cada upload', async () => {
      const uploads = service();
      expect(warnings('S3_INPUT_PRIVATE_BUCKET')).toHaveLength(1);
      await uploads.uploadGenerationInput(
        Buffer.from('1'),
        'gen_abc123',
        'a.png',
        'image/png',
      );
      await uploads.uploadGenerationInput(
        Buffer.from('2'),
        'gen_abc123',
        'b.png',
        'image/png',
      );
      expect(warnings('S3_INPUT_PRIVATE_BUCKET')).toHaveLength(1);
    });
  });

  describe('modo simulado (sem S3_ENDPOINT)', () => {
    it('com bucket privado: URL simulada do privado com a validade, sem tocar no S3', async () => {
      const uploads = withPrivate({
        S3_ENDPOINT: undefined,
        S3_PUBLIC_URL: '',
      });
      const stored = await uploads.uploadGenerationInput(
        Buffer.from('foto'),
        'gen_abc123',
        'input.png',
        'image/png',
      );
      expect(stored.url).toBe(
        `https://mock-s3.local/${PRIVATE_BUCKET}/${stored.key}?X-Amz-Expires=7200`,
      );
      expect(uploads.inputKeyFromUrl(stored.url)).toBe(stored.key);
      expect(send).not.toHaveBeenCalled();
    });

    it('sem bucket privado: URL simulada do público, como antes, e sem o aviso de bucket privado', async () => {
      const uploads = service({ S3_ENDPOINT: undefined, S3_PUBLIC_URL: '' });
      const stored = await uploads.uploadGenerationInput(
        Buffer.from('foto'),
        'gen_abc123',
        'input.png',
        'image/png',
      );
      expect(stored.url).toBe(
        `https://mock-s3.local/${PUBLIC_BUCKET}/${stored.key}`,
      );
      expect(warnings('S3_INPUT_PRIVATE_BUCKET')).toHaveLength(0);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('limpeza (deleteByPrefix / deleteByPrefixStrict)', () => {
    const page = (keys: string[]) => ({
      Contents: keys.map((Key) => ({ Key })),
      IsTruncated: false,
    });
    const byBucket = () =>
      commands().map((c) => `${c.kind}:${String(c.input.Bucket)}`);

    it('inputs/<id>/ apaga no público (legado) e no privado', async () => {
      send.mockImplementation(
        async (command: { input: { Bucket: string } }) => {
          if (command instanceof ListObjectsV2Command) {
            return command.input.Bucket === PRIVATE_BUCKET
              ? page(['inputs/gen_abc123/u/a.png', 'inputs/gen_abc123/u/b.png'])
              : page(['inputs/gen_abc123/v/old.png']);
          }
          return {};
        },
      );

      const total = await withPrivate().deleteByPrefix('inputs/gen_abc123/');

      expect(total).toBe(3);
      expect(byBucket()).toEqual([
        `ListObjectsV2Command:${PUBLIC_BUCKET}`,
        `DeleteObjectsCommand:${PUBLIC_BUCKET}`,
        `ListObjectsV2Command:${PRIVATE_BUCKET}`,
        `DeleteObjectsCommand:${PRIVATE_BUCKET}`,
      ]);
      const privateDelete = commands().find(
        (c) =>
          c.kind === DeleteObjectsCommand.name &&
          c.input.Bucket === PRIVATE_BUCKET,
      );
      expect(privateDelete?.input.Delete).toEqual({
        Objects: [
          { Key: 'inputs/gen_abc123/u/a.png' },
          { Key: 'inputs/gen_abc123/u/b.png' },
        ],
      });
    });

    it('outras pastas não tocam no bucket privado', async () => {
      send.mockResolvedValue(page([]) as never);
      await withPrivate().deleteByPrefix('outputs/gen_abc123/');
      expect(byBucket()).toEqual([`ListObjectsV2Command:${PUBLIC_BUCKET}`]);
    });

    it('sem a env, inputs/ só existe no público', async () => {
      send.mockResolvedValue(page([]) as never);
      await service().deleteByPrefix('inputs/gen_abc123/');
      expect(byBucket()).toEqual([`ListObjectsV2Command:${PUBLIC_BUCKET}`]);
    });

    it('falha no público ainda limpa o privado e o erro sobe no fim', async () => {
      send.mockImplementation(
        async (command: { input: { Bucket: string } }) => {
          if (command.input.Bucket === PUBLIC_BUCKET)
            throw new Error('fora do ar');
          if (command instanceof ListObjectsV2Command)
            return page(['inputs/gen_abc123/u/a.png']);
          return {};
        },
      );

      await expect(
        withPrivate().deleteByPrefix('inputs/gen_abc123/'),
      ).rejects.toThrow('fora do ar');
      expect(byBucket()).toContain(`DeleteObjectsCommand:${PRIVATE_BUCKET}`);
    });

    it('estrito (exclusão LGPD): soma os dois buckets', async () => {
      send.mockImplementation(
        async (command: {
          input: {
            Bucket: string;
            Delete?: { Objects: Array<{ Key: string }> };
          };
        }) => {
          if (command instanceof ListObjectsV2Command) {
            return command.input.Bucket === PRIVATE_BUCKET
              ? page(['inputs/gen_abc123/u/a.png'])
              : page(['inputs/gen_abc123/v/old.png']);
          }
          return { Deleted: command.input.Delete?.Objects ?? [] };
        },
      );

      expect(
        await withPrivate().deleteByPrefixStrict('inputs/gen_abc123/'),
      ).toBe(2);
      expect(byBucket()).toEqual([
        `ListObjectsV2Command:${PUBLIC_BUCKET}`,
        `DeleteObjectsCommand:${PUBLIC_BUCKET}`,
        `ListObjectsV2Command:${PRIVATE_BUCKET}`,
        `DeleteObjectsCommand:${PRIVATE_BUCKET}`,
      ]);
    });

    it('estrito: chave recusada no privado deixa a pasta não confirmada, com o total do que saiu', async () => {
      send.mockImplementation(
        async (command: {
          input: {
            Bucket: string;
            Delete?: { Objects: Array<{ Key: string }> };
          };
        }) => {
          if (command instanceof ListObjectsV2Command) {
            return command.input.Bucket === PRIVATE_BUCKET
              ? page(['inputs/gen_abc123/u/a.png'])
              : page(['inputs/gen_abc123/v/old.png']);
          }
          if (command.input.Bucket === PRIVATE_BUCKET) {
            return {
              Errors: [
                { Key: 'inputs/gen_abc123/u/a.png', Code: 'AccessDenied' },
              ],
            };
          }
          return { Deleted: command.input.Delete?.Objects ?? [] };
        },
      );

      let failure: unknown;
      try {
        await withPrivate().deleteByPrefixStrict('inputs/gen_abc123/');
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(StorageDeleteError);
      const error = failure as StorageDeleteError;
      expect(error.deleted).toBe(1);
      expect(error.failedKeys).toEqual(['inputs/gen_abc123/u/a.png']);
      expect(error.prefix).toBe('inputs/gen_abc123/');
    });
  });
});
