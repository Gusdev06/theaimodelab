import { Global, Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../../prisma/prisma.module';
import { PrismaService } from '../../../prisma/prisma.service';
import { ReportsTakedownController } from '../../../reports/reports-takedown.controller';
import { ReportsModule } from '../../../reports/reports.module';
import {
  IMAGE_SAFETY_CONFIG,
  imageSafetyConfigProvider,
} from '../../image-safety/image-safety.config';
import { BLOCKLIST } from '../../image-safety/image-safety.tokens';
import { CdnPurgeService } from '../cdn-purge.service';
import { TakedownPurgeCron } from '../takedown-purge.cron';
import { TakedownService } from '../takedown.service';

/**
 * Montagem real do ReportsModule com a remoção. O que a remoção lê do ImageSafetyModule (global em produção) vem de
 * um módulo global de teste com o mesmo contrato: a configuração (modo off, lida do env vazio) e a lista de bloqueio.
 * Com o modo off e sem token do CDN, monta assim mesmo (a remoção é ação do revisor e vale em qualquer modo).
 */
@Global()
@Module({
  providers: [
    imageSafetyConfigProvider,
    { provide: BLOCKLIST, useValue: { add: jest.fn(), match: jest.fn(), countRecent: jest.fn() } },
  ],
  exports: [IMAGE_SAFETY_CONFIG, BLOCKLIST],
})
class ImageSafetyContractModule {}

describe('TakedownModule (montagem)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('monta com o modo off, sem CDN: serviço, cron e controller resolvidos; purga não configurada', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ S3_BUCKET_NAME: 'ai-generations' })],
        }),
        PrismaModule,
        ImageSafetyContractModule,
        ReportsModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(TakedownService)).toBeInstanceOf(TakedownService);
    expect(moduleRef.get(TakedownPurgeCron)).toBeDefined();
    expect(moduleRef.get(ReportsTakedownController)).toBeDefined();
    expect(moduleRef.get(CdnPurgeService).configured).toBe(false);
    await moduleRef.close();
  });
});
