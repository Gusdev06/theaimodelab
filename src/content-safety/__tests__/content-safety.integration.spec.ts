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
  /** contas em memória: a declaração de imagens fica na linha da conta, como na tabela users */
  interface AccountRow {
    termsVersion: string | null;
    imageDeclarationAt: Date | null;
    imageDeclarationVersion: string | null;
  }
  const accounts: Record<string, AccountRow> = {};
  const prismaMock = {
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => accounts[where.id] ?? null),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string; imageDeclarationAt?: null }; data: Partial<AccountRow> }) => {
        const row = accounts[where.id];
        if (!row) return { count: 0 };
        if ('imageDeclarationAt' in where && row.imageDeclarationAt !== null) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
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
    // os testes da declaração da conta entram "logados" por este cabeçalho; sem ele o pedido segue sem usuário, como antes
    app.use((req: { headers: Record<string, unknown>; user?: { sub: string } }, _res: unknown, next: () => void) => {
      const testUser = req.headers['x-test-user'];
      if (typeof testUser === 'string') req.user = { sub: testUser };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
    controller = moduleRef.get(FakeGenerationsController);
  });

  beforeEach(() => {
    events.length = 0;
    links.length = 0;
    controller.handled.length = 0;
    for (const id of Object.keys(accounts)) delete accounts[id];
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

  describe('declaração de imagens gravada na conta (uma vez)', () => {
    const post = (url: string, userId: string, body: Record<string, unknown>) =>
      request(app.getHttpServer()).post(url).set('x-test-user', userId).send(body);
    const TROCA_DE_ROSTO = { source_image: FOTO, target_image: FOTO };

    it('conta que já declarou não manda mais o campo: a troca de rosto passa, com a evidência marcada como vinda da conta', async () => {
      accounts['u-declarou'] = { termsVersion: '2026-10-15', imageDeclarationAt: new Date('2026-11-06T15:00:00.000Z'), imageDeclarationVersion: '2026-11-06' };

      const res = await post('/api/v1/generations/face-swap', 'u-declarou', TROCA_DE_ROSTO);

      expect(res.status).toBe(201);
      expect(controller.handled).toEqual(['face-swap']);
      expect(events).toEqual([
        expect.objectContaining({
          kind: 'CONSENT_ATTESTED',
          userId: 'u-declarou',
          match: 'account-declaration:2026-11-06',
          termsVersion: '2026-10-15',
        }),
      ]);
      await flush();
      expect(links).toEqual([{ id: 'evt-1', generationId: 'gen-swap' }]);
    });

    it('site que ainda manda o campo: o campo vale só para aquele pedido; a conta não fica declarada e o seguinte, sem o campo, leva 400', async () => {
      accounts['u-antigo'] = { termsVersion: '2026-10-15', imageDeclarationAt: null, imageDeclarationVersion: null };
      prismaMock.user.findUnique.mockClear();
      prismaMock.user.updateMany.mockClear();

      const attested = await post('/api/v1/generations/face-swap', 'u-antigo', { ...TROCA_DE_ROSTO, consent_confirmed: true });
      expect(attested.status).toBe(201);
      expect(accounts['u-antigo']).toEqual({ termsVersion: '2026-10-15', imageDeclarationAt: null, imageDeclarationVersion: null });
      // com o campo, nada é escrito em users e a única leitura é a da versão do termo que acompanha a evidência
      // (já existia antes da declaração da conta); a declaração da conta não é consultada
      expect(prismaMock.user.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.user.findUnique.mock.calls.map(([args]) => args)).toEqual([
        { where: { id: 'u-antigo' }, select: { termsVersion: true } },
      ]);

      const after = await post('/api/v1/generations/face-swap', 'u-antigo', TROCA_DE_ROSTO);
      expect(after.status).toBe(400);
      expect(after.body).toMatchObject({ code: 'CONSENT_REQUIRED' });
      expect(accounts['u-antigo'].imageDeclarationAt).toBeNull();
      expect(prismaMock.user.updateMany).not.toHaveBeenCalled();

      expect(events.map((event) => [event.kind, event.match])).toEqual([
        ['CONSENT_ATTESTED', null],
        ['CONSENT_MISSING', null],
      ]);
    });

    it('rota opcional com o campo: sem conseguir gravar o atestado o pedido passa mesmo assim (nunca 503 onde sem o campo passaria)', async () => {
      accounts['u-campo'] = { termsVersion: '2026-10-15', imageDeclarationAt: null, imageDeclarationVersion: null };
      prismaMock.contentSafetyEvent.create.mockRejectedValueOnce(new Error('banco fora'));

      const res = await post('/api/v1/generations/generate-image', 'u-campo', {
        prompt: 'portrait, studio light',
        model: 'gpt-image-2',
        resolution: 'RES_2K',
        images: [{ base64: 'iVBORw0KGgo' }],
        consent_confirmed: true,
      });

      expect(res.status).toBe(201);
      expect(controller.handled).toEqual(['generate-image']);
      expect(events).toEqual([]);
      await flush();
      expect(links).toEqual([]);
      expect(accounts['u-campo'].imageDeclarationAt).toBeNull();
    });

    it('acabou de declarar pela rota do perfil: o pedido seguinte passa na hora (o "não" de antes não ficou guardado)', async () => {
      accounts['u-novo'] = { termsVersion: '2026-10-15', imageDeclarationAt: null, imageDeclarationVersion: null };

      const before = await post('/api/v1/generations/virtual-try-on', 'u-novo', { influencer_image: FOTO, clothing_image: FOTO });
      expect(before.status).toBe(400);

      // o que POST /users/me/image-declaration grava (por outro service, até em outra instância da API)
      accounts['u-novo'] = { termsVersion: '2026-10-15', imageDeclarationAt: new Date(), imageDeclarationVersion: '2026-11-06' };

      const after = await post('/api/v1/generations/virtual-try-on', 'u-novo', { influencer_image: FOTO, clothing_image: FOTO });
      expect(after.status).toBe(201);
      expect(controller.handled).toEqual(['virtual-try-on']);
    });

    it('modelo com filtro e foto (rota opcional) de conta que já declarou: sem o campo, o atestado é gravado e ligado', async () => {
      accounts['u-opcional'] = { termsVersion: '2026-10-15', imageDeclarationAt: new Date('2026-11-06T15:00:00.000Z'), imageDeclarationVersion: '2026-11-06' };

      const res = await post('/api/v1/generations/generate-image', 'u-opcional', {
        prompt: 'portrait, studio light',
        model: 'gpt-image-2',
        resolution: 'RES_2K',
        images: [{ base64: 'iVBORw0KGgo' }],
      });

      expect(res.status).toBe(201);
      expect(events).toEqual([expect.objectContaining({ kind: 'CONSENT_ATTESTED', match: 'account-declaration:2026-11-06' })]);
      await flush();
      expect(links).toEqual([{ id: 'evt-1', generationId: 'gen-img' }]);
    });

    it('rota opcional: sem conseguir gravar o atestado o pedido passa mesmo assim (nunca 503 onde hoje passa)', async () => {
      accounts['u-opcional-2'] = { termsVersion: '2026-10-15', imageDeclarationAt: new Date('2026-11-06T15:00:00.000Z'), imageDeclarationVersion: '2026-11-06' };
      prismaMock.contentSafetyEvent.create.mockRejectedValueOnce(new Error('banco fora'));

      const res = await post('/api/v1/generations/generate-image', 'u-opcional-2', {
        prompt: 'portrait, studio light',
        model: 'gpt-image-2',
        resolution: 'RES_2K',
        images: [{ base64: 'iVBORw0KGgo' }],
      });

      expect(res.status).toBe(201);
      expect(controller.handled).toEqual(['generate-image']);
      await flush();
      expect(links).toEqual([]);
    });

    it('conta sem declaração em rota opcional: passa sem registro nenhum, como antes', async () => {
      accounts['u-sem'] = { termsVersion: '2026-10-15', imageDeclarationAt: null, imageDeclarationVersion: null };

      const res = await post('/api/v1/generations/generate-image', 'u-sem', {
        prompt: 'portrait, studio light',
        model: 'gpt-image-2',
        resolution: 'RES_2K',
        images: [{ base64: 'iVBORw0KGgo' }],
      });

      expect(res.status).toBe(201);
      expect(events).toEqual([]);
      expect(accounts['u-sem'].imageDeclarationAt).toBeNull();
    });
  });
});
