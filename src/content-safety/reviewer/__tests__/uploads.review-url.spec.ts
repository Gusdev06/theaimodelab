import { Logger } from '@nestjs/common';
import { StorageReadError, UploadsService } from '../../../uploads/uploads.service';

/** URL assinada curta do revisor em qualquer área (sem S3: URL simulada com a validade, nunca a pública). */

function createUploads(
  env: Record<string, string>,
  safety: { quarantineBucket?: string | null; evidenceBucket?: string | null } = {},
) {
  const config = {
    get: (key: string, fallback?: unknown) => env[key] ?? fallback,
  };
  return new UploadsService(config as never, {
    imageMode: 'shadow',
    quarantineBucket: safety.quarantineBucket ?? null,
    evidenceBucket: safety.evidenceBucket ?? null,
  } as never);
}

describe('UploadsService.signedReviewMediaUrl', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('assina na área certa com 120 s por padrão (evidência, quarentena, entrada privada, público)', async () => {
    const uploads = createUploads(
      { S3_BUCKET_NAME: 'ai-generations', S3_INPUT_PRIVATE_BUCKET: 'taml-inputs' },
      { quarantineBucket: 'taml-quarentena', evidenceBucket: 'taml-evidencia' },
    );
    await expect(uploads.signedReviewMediaUrl('evidence', 'evidence/abc/x.png')).resolves.toBe(
      'https://mock-s3.local/taml-evidencia/evidence/abc/x.png?X-Amz-Expires=120',
    );
    await expect(
      uploads.signedReviewMediaUrl('quarantine', 'generations/g/u/out.png', 60),
    ).resolves.toContain('taml-quarentena/generations/g/u/out.png?X-Amz-Expires=60');
    await expect(
      uploads.signedReviewMediaUrl('input-private', 'inputs/g/u/in.png'),
    ).resolves.toContain('taml-inputs/inputs/g/u/in.png');
    await expect(
      uploads.signedReviewMediaUrl('public', 'generations/g/p/out.png'),
    ).resolves.toContain('ai-generations/generations/g/p/out.png?X-Amz-Expires=120');
  });

  it('evidência sem bucket próprio cai no privado das entradas; área sem bucket ou chave insegura lança', async () => {
    const uploads = createUploads({
      S3_BUCKET_NAME: 'ai-generations',
      S3_INPUT_PRIVATE_BUCKET: 'taml-inputs',
    });
    await expect(uploads.signedReviewMediaUrl('evidence', 'evidence/abc/x.png')).resolves.toContain(
      'taml-inputs/evidence/abc/x.png',
    );
    await expect(
      uploads.signedReviewMediaUrl('quarantine', 'generations/g/u/out.png'),
    ).rejects.toBeInstanceOf(StorageReadError);
    await expect(
      uploads.signedReviewMediaUrl('evidence', '../outro/x.png'),
    ).rejects.toMatchObject({ reason: 'not_found' });
  });
});
