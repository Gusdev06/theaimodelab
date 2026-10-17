import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../../prisma/prisma.module';
import { PrismaService } from '../../../prisma/prisma.service';
import { UploadsService } from '../../../uploads/uploads.service';
import { ContentSafetyModule } from '../../content-safety.module';
import { ContentSafetyService } from '../../content-safety.service';
import { ImageSafetyModule } from '../image-safety.module';
import { ImageSafetyService } from '../image-safety.service';
import { IMAGE_SCANNER } from '../image-safety.tokens';
import { QuarantineCron } from '../quarantine.cron';
import { RekognitionScanner } from '../rekognition.scanner';

/**
 * Montagem do módulo com o ContentSafetyModule (os dois globais): sem dependência circular, o ContentSafetyService lê
 * o status do preflight pelo leitor, o UploadsService enxerga a configuração (quarentena) e, com o modo off, nenhum
 * cliente da AWS é criado.
 */
async function compile(env: Record<string, string>) {
  const prisma = { contentSafetyScan: { findMany: jest.fn(async () => []) } };
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => env],
      }),
      PrismaModule,
      ContentSafetyModule,
      ImageSafetyModule,
    ],
  })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();
  return { moduleRef, prisma };
}

describe('ImageSafetyModule', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('modo off: monta sem cliente da AWS; status do preflight unavailable sem ler o banco; sem quarentena', async () => {
    const { moduleRef, prisma } = await compile({
      S3_BUCKET_NAME: 'ai-generations',
    });
    expect(moduleRef.get(IMAGE_SCANNER)).toBeNull();
    expect(moduleRef.get(ImageSafetyService).enabled).toBe(false);
    expect(moduleRef.get(QuarantineCron)).toBeDefined();
    await expect(
      moduleRef.get(ContentSafetyService).preflightStatusForGeneration('g1'),
    ).resolves.toBe('unavailable');
    expect(prisma.contentSafetyScan.findMany).not.toHaveBeenCalled();
    expect(moduleRef.get(UploadsService).quarantineEnabled).toBe(false);
  });

  it('modo shadow com bucket de quarentena: leitor de imagem montado, quarentena ligada, status lido do banco', async () => {
    const { moduleRef, prisma } = await compile({
      S3_BUCKET_NAME: 'ai-generations',
      IMAGE_SAFETY_MODE: 'shadow',
      S3_QUARANTINE_BUCKET: 'taml-quarantine',
      S3_EVIDENCE_BUCKET: 'taml-evidencia',
    });
    expect(moduleRef.get(IMAGE_SCANNER)).toBeInstanceOf(RekognitionScanner);
    expect(moduleRef.get(ImageSafetyService).imageEnabled).toBe(true);
    expect(moduleRef.get(UploadsService).quarantineEnabled).toBe(true);
    await expect(
      moduleRef.get(ContentSafetyService).preflightStatusForGeneration('g1'),
    ).resolves.toBe('unavailable');
    expect(prisma.contentSafetyScan.findMany).toHaveBeenCalled();
  });
});
