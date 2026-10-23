import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../../prisma/prisma.module';
import { PrismaService } from '../../../prisma/prisma.service';
import { ContentSafetyAdminController } from '../../content-safety-admin.controller';
import { ContentSafetyModule } from '../../content-safety.module';
import { ImageSafetyModule } from '../../image-safety/image-safety.module';
import { SafetyReviewModule } from '../safety-review.module';
import { SafetyReviewService } from '../safety-review.service';

/**
 * Montagem como no app.module: os módulos globais de segurança mais o do revisor. O controller do ContentSafetyModule
 * recebe o serviço do revisor; sem o módulo do revisor, o ContentSafetyModule continua montando sozinho.
 */
async function compile(withReview: boolean) {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ S3_BUCKET_NAME: 'ai-generations', SAFETY_REVIEWER_IDS: 'reviewer-0001' })],
      }),
      PrismaModule,
      ContentSafetyModule,
      ImageSafetyModule,
      ...(withReview ? [SafetyReviewModule] : []),
    ],
  })
    .overrideProvider(PrismaService)
    .useValue({})
    .compile();
}

describe('SafetyReviewModule', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('monta com os módulos globais de segurança e entrega o serviço ao controller', async () => {
    const moduleRef = await compile(true);
    const service = moduleRef.get(SafetyReviewService);
    expect(service).toBeInstanceOf(SafetyReviewService);
    const controller = moduleRef.get(ContentSafetyAdminController);
    expect((controller as unknown as { reviewService: unknown }).reviewService).toBe(service);
    await moduleRef.close();
  });

  it('sem o módulo do revisor, o ContentSafetyModule monta e as rotas do revisor ficam sem serviço', async () => {
    const moduleRef = await compile(false);
    const controller = moduleRef.get(ContentSafetyAdminController);
    expect((controller as unknown as { reviewService: unknown }).reviewService).toBeNull();
    await moduleRef.close();
  });
});
