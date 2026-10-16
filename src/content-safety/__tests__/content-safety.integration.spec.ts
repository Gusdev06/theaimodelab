import { Body, Controller, Global, INestApplication, Module, Post, UseInterceptors } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { ContentSafetyInterceptor } from '../content-safety.interceptor';
import { ContentSafetyModule } from '../content-safety.module';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Prova que o interceptor resolve pelo módulo global e roda no pipeline real do Nest (rota → interceptor →
 * exceção → HTTP), não só chamado à mão: um controller qualquer decorado com @UseInterceptors recusa com o
 * status e o código certos, e o pedido limpo chega ao handler.
 */
@Controller('api/v1/generations')
@UseInterceptors(ContentSafetyInterceptor)
class FakeGenerationsController {
  handled = 0;
  @Post('generate-image')
  generate(@Body() body: unknown) {
    this.handled += 1;
    return { ok: true, body };
  }
  @Post('face-swap')
  faceSwap() {
    this.handled += 1;
    return { ok: true };
  }
}

describe('ContentSafety no pipeline do Nest', () => {
  let app: INestApplication;
  let controller: FakeGenerationsController;
  const events: unknown[] = [];

  beforeAll(async () => {
    const prismaMock = {
      contentSafetyEvent: {
        create: jest.fn(async ({ data }: { data: unknown }) => { events.push(data); return data; }),
        count: jest.fn(async () => 0),
        findMany: jest.fn(async () => []),
      },
    };
    // igual à produção: o PrismaModule é @Global, então o ContentSafetyModule enxerga o PrismaService sem importar
    @Global()
    @Module({ providers: [{ provide: PrismaService, useValue: prismaMock }], exports: [PrismaService] })
    class FakePrismaModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [FakePrismaModule, ContentSafetyModule],
      controllers: [FakeGenerationsController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    controller = moduleRef.get(FakeGenerationsController);
  });

  afterAll(async () => {
    await app.close();
  });

  it('referência a menor → 422 CONTENT_POLICY_MINOR e o handler nunca roda', async () => {
    const before = controller.handled;
    const res = await request(app.getHttpServer())
      .post('/api/v1/generations/generate-image')
      .send({ prompt: 'menina de 12 anos', model: 'sem-censura' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'CONTENT_POLICY_MINOR' });
    expect(controller.handled).toBe(before);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'MINOR_BLOCKED', match: '12' }));
  });

  it('troca de rosto sem atestado → 400 CONSENT_REQUIRED; com atestado → 201', async () => {
    const no = await request(app.getHttpServer()).post('/api/v1/generations/face-swap').send({ source_image: 'a', target_image: 'b' });
    expect(no.status).toBe(400);
    expect(no.body).toMatchObject({ code: 'CONSENT_REQUIRED' });
    const yes = await request(app.getHttpServer())
      .post('/api/v1/generations/face-swap')
      .send({ source_image: 'a', target_image: 'b', consent_confirmed: true });
    expect(yes.status).toBe(201);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'CONSENT_ATTESTED' }));
  });

  it('pedido adulto comum chega ao handler', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/generations/generate-image')
      .send({ prompt: 'a 30 year old woman, golden hour', model: 'gpt-image-2' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });
});
