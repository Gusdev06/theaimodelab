import { Body, Controller, Global, INestApplication, Module, Post, UseInterceptors, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { ContentSafetyInterceptor } from '../content-safety.interceptor';
import { ContentSafetyModule } from '../content-safety.module';
import { PrismaService } from '../../prisma/prisma.service';
import { GenerateImageDto } from '../../generations/dto/generate-image.dto';
import { GenerateVirtualTryOnDto } from '../../generations/dto/generate-virtual-try-on.dto';

/**
 * Prova que o interceptor resolve pelo módulo global e roda no pipeline real do Nest (rota → interceptor →
 * exceção → HTTP), não só chamado à mão: um controller qualquer decorado com @UseInterceptors recusa com o
 * status e o código certos, o pedido limpo chega ao handler, e o atestado é gravado antes do handler e ligado à
 * geração depois. A validação global é a mesma do main.ts (forbidNonWhitelisted): o DTO tem que aceitar o atestado.
 */
@Controller('api/v1/generations')
@UseInterceptors(ContentSafetyInterceptor)
class FakeGenerationsController {
  handled: string[] = [];
  @Post('generate-image')
  generate(@Body() body: GenerateImageDto) {
    this.handled.push('generate-image');
    return { id: 'gen-img', status: 'PROCESSING', body };
  }
  @Post('face-swap')
  faceSwap() {
    this.handled.push('face-swap');
    return { id: 'gen-swap', status: 'PROCESSING' };
  }
  @Post('virtual-try-on')
  tryOn(@Body() body: GenerateVirtualTryOnDto) {
    this.handled.push('virtual-try-on');
    return { id: 'gen-tryon', status: 'PROCESSING', model: body.model ?? null };
  }
}

const FOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg';
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('ContentSafety no pipeline do Nest', () => {
  let app: INestApplication;
  let controller: FakeGenerationsController;
  const events: Array<Record<string, unknown>> = [];
  const links: Array<{ id: string; generationId: unknown }> = [];
  const prismaMock = {
    contentSafetyEvent: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return { id: `evt-${events.length}` };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: { generationId: unknown } }) => {
        links.push({ id: where.id, generationId: data.generationId });
        return { id: where.id };
      }),
      count: jest.fn(async () => 0),
      findMany: jest.fn(async () => []),
    },
  };

  beforeAll(async () => {
    // igual à produção: o PrismaModule é @Global, então o ContentSafetyModule enxerga o PrismaService sem importar
    @Global()
    @Module({ providers: [{ provide: PrismaService, useValue: prismaMock }], exports: [PrismaService] })
    class FakePrismaModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [FakePrismaModule, ContentSafetyModule],
      controllers: [FakeGenerationsController],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
    controller = moduleRef.get(FakeGenerationsController);
  });

  beforeEach(() => {
    events.length = 0;
    links.length = 0;
    controller.handled.length = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  it('referência a menor → 422 CONTENT_POLICY_MINOR, o handler nunca roda e o trecho fica registrado', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/generations/generate-image')
      .send({ prompt: 'menina de 12 anos na praia', model: 'sem-censura', resolution: 'RES_2K' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'CONTENT_POLICY_MINOR' });
    expect(controller.handled).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({ kind: 'MINOR_BLOCKED', match: expect.stringContaining('12'), excerpt: expect.stringContaining('menina de 12 anos na praia') }),
    ]);
  });

  it('texto grande demais → 413 REQUEST_TOO_LARGE, sem evento de menor', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/generations/generate-image')
      .send({ prompt: 'golden hour portrait '.repeat(3_000), model: 'gpt-image-2', resolution: 'RES_2K' });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ code: 'REQUEST_TOO_LARGE' });
    expect(events).toEqual([]);
    expect(controller.handled).toEqual([]);
  });

  it('troca de rosto sem atestado → 400 CONSENT_REQUIRED; com atestado → 201, gravado antes e ligado à geração', async () => {
    const no = await request(app.getHttpServer()).post('/api/v1/generations/face-swap').send({ source_image: FOTO, target_image: FOTO });
    expect(no.status).toBe(400);
    expect(no.body).toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(events).toEqual([expect.objectContaining({ kind: 'CONSENT_MISSING', route: 'POST /api/v1/generations/face-swap' })]);

    const yes = await request(app.getHttpServer())
      .post('/api/v1/generations/face-swap')
      .send({ source_image: FOTO, target_image: FOTO, consent_confirmed: true });
    expect(yes.status).toBe(201);
    expect(events[1]).toMatchObject({ kind: 'CONSENT_ATTESTED', generationId: null });
    await flush();
    expect(links).toEqual([{ id: 'evt-2', generationId: 'gen-swap' }]);
  });

  it.each(['/API/V1/GENERATIONS/FACE-SWAP', '/api/v1/generations/Face-Swap/', '/api/v1/generations/face-swap?consent_confirmed=true'])(
    'maiúscula, barra no fim ou query não driblam a regra: %s',
    async (url) => {
      const res = await request(app.getHttpServer()).post(url).send({ source_image: FOTO, target_image: FOTO });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'CONSENT_REQUIRED' });
      expect(controller.handled).toEqual([]);
    },
  );

  it('sem conseguir gravar o atestado → 503 e o handler não roda', async () => {
    prismaMock.contentSafetyEvent.create.mockRejectedValueOnce(new Error('banco fora'));
    const res = await request(app.getHttpServer())
      .post('/api/v1/generations/virtual-try-on')
      .send({ influencer_image: FOTO, clothing_image: FOTO, consent_confirmed: true });
    expect(res.status).toBe(503);
    expect(controller.handled).toEqual([]);
  });

  it('provador virtual: o DTO aceita o atestado (forbidNonWhitelisted) e a geração fica ligada', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/generations/virtual-try-on')
      .send({ influencer_image: FOTO, clothing_image: FOTO, consent_confirmed: true });
    expect(res.status).toBe(201);
    expect(controller.handled).toEqual(['virtual-try-on']);
    await flush();
    expect(links).toEqual([{ id: 'evt-1', generationId: 'gen-tryon' }]);
  });

  it('modelo comum com foto e atestado: aceito, gravado e ligado (libera o fallback sem censura)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/generations/generate-image')
      .send({ prompt: 'portrait, studio light', model: 'gpt-image-2', resolution: 'RES_2K', images: [{ base64: 'iVBORw0KGgo' }], consent_confirmed: true });
    expect(res.status).toBe(201);
    expect(events).toEqual([expect.objectContaining({ kind: 'CONSENT_ATTESTED' })]);
    await flush();
    expect(links).toEqual([{ id: 'evt-1', generationId: 'gen-img' }]);
  });

  it('pedido adulto comum chega ao handler sem nenhum registro', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/generations/generate-image')
      .send({ prompt: 'a 30 year old woman, golden hour', model: 'gpt-image-2', resolution: 'RES_2K' });
    expect(res.status).toBe(201);
    expect(controller.handled).toEqual(['generate-image']);
    expect(events).toEqual([]);
  });
});
