import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { loadImageSafetyConfig } from '../../content-safety/image-safety/image-safety.config';
import {
  PRIVATE_INPUT_CACHE_CONTROL,
  StorageReadError,
  UploadsService,
} from '../uploads.service';

/**
 * Quarentena dos resultados (camada 5): com a checagem ligada e S3_QUARANTINE_BUCKET, o resultado dos provedores
 * nasce privado; o público só nasce por promoteFromQuarantine; a evidência nunca vai para o público. Com o modo off
 * (ou sem o bucket), tudo como antes. S3 simulado.
 */
describe('UploadsService · quarentena e evidência', () => {
  const PUBLIC = 'ai-generations';
  const PRIVATE = 'taml-inputs-private';
  const QUARANTINE = 'taml-quarantine';
  const EVIDENCE = 'taml-evidence';
  const CDN = 'https://cdn.exemplo.com/storage/v1/object/public/ai-generations';

  const env = (overrides: Record<string, string | undefined> = {}) => {
    const values: Record<string, string | undefined> = {
      S3_ENDPOINT: 'https://s3.exemplo.com',
      S3_REGION: 'us-east-1',
      S3_ACCESS_KEY: 'chave-de-teste',
      S3_SECRET_KEY: 'segredo-de-teste',
      S3_BUCKET_NAME: PUBLIC,
      S3_PUBLIC_URL: CDN,
      S3_INPUT_PRIVATE_BUCKET: PRIVATE,
      ...overrides,
    };
    return {
      get: jest.fn((key: string, fallback?: string) =>
        key in values ? (values[key] ?? fallback) : fallback,
      ),
      values,
    };
  };

  const service = (
    safetyEnv: Record<string, string> = {},
    overrides: Record<string, string | undefined> = {},
  ) => {
    const config = env(overrides);
    const { config: safety } = loadImageSafetyConfig((key) =>
      key === 'S3_BUCKET_NAME' ? PUBLIC : safetyEnv[key],
    );
    return new UploadsService(config as never, safety);
  };
  const quarantined = (extra: Record<string, string> = {}) =>
    service({
      IMAGE_SAFETY_MODE: 'shadow',
      S3_QUARANTINE_BUCKET: QUARANTINE,
      S3_EVIDENCE_BUCKET: EVIDENCE,
      ...extra,
    });

  let send: jest.SpyInstance;
  const commands = () =>
    send.mock.calls.map(([command]) => ({
      kind: command.constructor.name as string,
      input: command.input as Record<string, unknown>,
    }));
  const puts = () => commands().filter((c) => c.kind === PutObjectCommand.name);
  const deletes = () =>
    commands().filter((c) => c.kind === DeleteObjectCommand.name);

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    send = jest
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation(async (command) => {
        if (command instanceof GetObjectCommand) {
          return {
            ContentLength: 4,
            ContentType: 'image/png',
            Body: {
              transformToByteArray: async () => new Uint8Array([1, 2, 3, 4]),
            },
          } as never;
        }
        return {} as never;
      });
  });
  afterEach(() => jest.restoreAllMocks());

  describe('uploadBuffer', () => {
    it('modo off com o bucket configurado: resultado público como antes', async () => {
      const uploads = service({ S3_QUARANTINE_BUCKET: QUARANTINE });
      const url = await uploads.uploadBuffer(
        Buffer.from('a'),
        'generations/g1',
        'output_0.png',
        'image/png',
      );
      expect(url.startsWith(`${CDN}/generations/g1/`)).toBe(true);
      expect(puts()[0].input).toMatchObject({
        Bucket: PUBLIC,
        CacheControl: 'public, max-age=86400',
      });
      expect(uploads.quarantineEnabled).toBe(false);
    });

    it('modo ligado sem S3_QUARANTINE_BUCKET: público como antes', async () => {
      const uploads = service({ IMAGE_SAFETY_MODE: 'shadow' });
      await uploads.uploadBuffer(
        Buffer.from('a'),
        'generations/g1',
        'output_0.png',
        'image/png',
      );
      expect(puts()[0].input.Bucket).toBe(PUBLIC);
    });

    it('ligado e com bucket: resultado de geração nasce privado na quarentena e volta URL assinada curta', async () => {
      const uploads = quarantined();
      const url = await uploads.uploadBuffer(
        Buffer.from('a'),
        'generations/g1',
        'output_0.png',
        'image/png',
      );
      expect(puts()[0].input).toMatchObject({
        Bucket: QUARANTINE,
        CacheControl: PRIVATE_INPUT_CACHE_CONTROL,
      });
      expect(url).toContain(`/${QUARANTINE}/generations/g1/`);
      expect(url).toContain('X-Amz-Expires=1800');
      expect(url.startsWith(CDN)).toBe(false);
    });

    it('outras pastas (miniatura, editor, vozes) continuam públicas', async () => {
      const uploads = quarantined();
      await uploads.uploadBuffer(
        Buffer.from('a'),
        'video-editor',
        'render.mp4',
        'image/png',
      );
      await uploads.uploadBuffer(
        Buffer.from('a'),
        'voices/u1',
        'sample.mp3',
        'audio/mpeg',
      );
      expect(puts().map((p) => p.input.Bucket)).toEqual([PUBLIC, PUBLIC]);
    });
  });

  it('localiza a área e a chave pela URL (sem levar a assinatura)', () => {
    const uploads = quarantined();
    expect(
      uploads.locateStoredMedia(
        `https://s3.exemplo.com/${QUARANTINE}/generations/g1/u/o.png?X-Amz-Signature=x`,
      ),
    ).toEqual({ area: 'quarantine', key: 'generations/g1/u/o.png' });
    expect(uploads.locateStoredMedia(`${CDN}/generations/g1/u/o.png`)).toEqual({
      area: 'public',
      key: 'generations/g1/u/o.png',
    });
    expect(
      uploads.locateStoredMedia(
        `https://s3.exemplo.com/${PRIVATE}/inputs/g1/u/f.png?X-Amz-Expires=7200`,
      ),
    ).toEqual({ area: 'input-private', key: 'inputs/g1/u/f.png' });
    expect(uploads.locateStoredMedia('https://outro.site/foto.png')).toBeNull();
    expect(uploads.locateStoredMedia(`${CDN}/inputs/../segredo`)).toBeNull();
  });

  it('promoteFromQuarantine: grava no público com cache curto e chave nova, depois apaga da quarentena', async () => {
    const uploads = quarantined();
    const promoted = await uploads.promoteFromQuarantine(
      'generations/g1/u-old/output_0.png',
      {
        body: Buffer.from('bytes'),
        contentType: 'image/png',
      },
    );
    expect(promoted.key).toMatch(
      /^generations\/g1\/[0-9a-f-]{36}\/output_0\.png$/,
    );
    expect(promoted.key).not.toContain('u-old');
    expect(promoted.url).toBe(`${CDN}/${promoted.key}`);
    expect(puts()[0].input).toMatchObject({
      Bucket: PUBLIC,
      Key: promoted.key,
      CacheControl: 'public, max-age=86400',
      ContentType: 'image/png',
    });
    expect(deletes()[0].input).toEqual({
      Bucket: QUARANTINE,
      Key: 'generations/g1/u-old/output_0.png',
    });
    // sem o corpo em mãos, lê da quarentena
    await uploads.promoteFromQuarantine('generations/g1/u2/output_1.png');
    expect(
      commands().some(
        (c) =>
          c.kind === GetObjectCommand.name && c.input.Bucket === QUARANTINE,
      ),
    ).toBe(true);
  });

  describe('moveToEvidence', () => {
    it('vai para o bucket de evidência (privado) e só então apaga a origem; o hash é o dos bytes, nos metadados', async () => {
      const uploads = quarantined();
      const digest = createHash('sha256')
        .update(Buffer.from([1, 2, 3, 4]))
        .digest('hex');
      const errorLog = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const key = await uploads.moveToEvidence(
        'quarantine',
        'generations/g1/u/o.png',
        'a'.repeat(64),
      );
      expect(key).toMatch(
        new RegExp(`^evidence/${digest}/[0-9a-f-]{36}/o\\.png$`),
      );
      expect(puts()[0].input).toMatchObject({
        Bucket: EVIDENCE,
        Key: key,
        CacheControl: PRIVATE_INPUT_CACHE_CONTROL,
        Metadata: { sha256: digest },
      });
      // o hash esperado divergente só vira log: a evidência é guardada mesmo assim
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('sha256 diferente do esperado'),
      );
      expect(deletes()[0].input).toEqual({
        Bucket: QUARANTINE,
        Key: 'generations/g1/u/o.png',
      });
    });

    it('sem S3_EVIDENCE_BUCKET: pasta evidence/ do bucket privado de entradas, nunca o público', async () => {
      const uploads = service({ IMAGE_SAFETY_MODE: 'shadow' });
      await uploads.moveToEvidence('public', 'inputs/g1/u/f.png', null);
      expect(puts()[0].input.Bucket).toBe(PRIVATE);
      // sem hash de quem chama, o da evidência é calculado dos bytes (nunca "sem-hash")
      expect(String(puts()[0].input.Key)).toMatch(/^evidence\/[0-9a-f]{64}\//);
    });

    it('sem bucket privado nenhum: lança e não apaga a origem', async () => {
      const uploads = service(
        { IMAGE_SAFETY_MODE: 'shadow' },
        { S3_INPUT_PRIVATE_BUCKET: undefined },
      );
      await expect(
        uploads.moveToEvidence('public', 'inputs/g1/u/f.png', null),
      ).rejects.toBeInstanceOf(StorageReadError);
      expect(deletes()).toHaveLength(0);
      expect(puts()).toHaveLength(0);
    });
  });

  describe('readObject', () => {
    it('acima do limite: too_large; objeto ausente: not_found', async () => {
      const uploads = quarantined();
      await expect(
        uploads.readObject('quarantine', 'generations/g1/u/o.png', 2),
      ).rejects.toMatchObject({
        reason: 'too_large',
      });
      send.mockRejectedValueOnce(
        Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }),
      );
      await expect(
        uploads.readObject('quarantine', 'generations/g1/u/x.png', 100),
      ).rejects.toMatchObject({
        reason: 'not_found',
      });
      await expect(
        uploads.readObject('quarantine', 'generations/g1/u/o.png', 100),
      ).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
    });

    it('área não configurada: not_configured', async () => {
      const uploads = service();
      await expect(
        uploads.readObject('quarantine', 'generations/g1/u/o.png', 100),
      ).rejects.toMatchObject({
        reason: 'not_configured',
      });
    });
  });

  it('signedQuarantineUrl: 120 s por padrão', async () => {
    const uploads = quarantined();
    const url = await uploads.signedQuarantineUrl('generations/g1/u/o.png');
    expect(url).toContain(`/${QUARANTINE}/generations/g1/u/o.png`);
    expect(url).toContain('X-Amz-Expires=120');
  });

  it('promoção em duas fases: copiar não apaga a quarentena; apagar é um passo à parte', async () => {
    const uploads = quarantined();
    const copied = await uploads.copyQuarantineToPublic(
      'generations/g1/u-old/output_0.png',
      { body: Buffer.from('bytes'), contentType: 'image/png' },
    );
    expect(puts()[0].input).toMatchObject({ Bucket: PUBLIC, Key: copied.key });
    expect(deletes()).toHaveLength(0);
    await uploads.deleteQuarantineObject('generations/g1/u-old/output_0.png');
    expect(deletes()[0].input).toEqual({
      Bucket: QUARANTINE,
      Key: 'generations/g1/u-old/output_0.png',
    });
  });

  it('modo off com o bucket configurado: o que ficou na quarentena ainda é lido (desligamento não prende nada)', async () => {
    const uploads = service({ S3_QUARANTINE_BUCKET: QUARANTINE });
    expect(uploads.quarantineEnabled).toBe(false);
    expect(uploads.quarantineConfigured).toBe(true);
    await expect(
      uploads.readObject('quarantine', 'generations/g1/u/o.png', 100),
    ).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('leitura com prazo: o GetObject leva um abortSignal', async () => {
    const uploads = quarantined();
    await uploads.readObject('quarantine', 'generations/g1/u/o.png', 100);
    const options = send.mock.calls.find(
      ([command]) => command instanceof GetObjectCommand,
    )?.[1] as { abortSignal?: AbortSignal } | undefined;
    expect(options?.abortSignal).toBeDefined();
  });

  it('deleteStoredObject apaga só na área pedida', async () => {
    const uploads = quarantined();
    await uploads.deleteStoredObject('input-private', 'inputs/g1/u/f.png');
    expect(deletes()[0].input).toEqual({
      Bucket: PRIVATE,
      Key: 'inputs/g1/u/f.png',
    });
  });
});
