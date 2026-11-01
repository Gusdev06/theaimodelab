import { CallHandler, ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { getMetadataStorage, validate } from 'class-validator';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { lastValueFrom, of } from 'rxjs';
import {
  CONSENT_RULES,
  ContentSafetyInterceptor,
  consentDecision,
  generationIdOf,
  isUncensoredModel,
  normalizePath,
  requiresConsent,
  safetyExcerpt,
} from '../content-safety.interceptor';
import { ContentSafetyService } from '../content-safety.service';
import { BusinessException } from '../../common/exceptions/business.exception';

function ctx(method: string, url: string, body: unknown, extra: { userId?: string; routePath?: string } = {}): ExecutionContext {
  const req = {
    method,
    originalUrl: url,
    body,
    user: { sub: extra.userId ?? 'user-1' },
    ...(extra.routePath ? { route: { path: extra.routePath } } : {}),
  };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const FOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ';

describe('ContentSafetyInterceptor', () => {
  let safety: { record: jest.Mock; recordOrThrow: jest.Mock; linkGeneration: jest.Mock };
  let interceptor: ContentSafetyInterceptor;
  let next: CallHandler & { handle: jest.Mock };

  beforeEach(() => {
    safety = {
      record: jest.fn().mockResolvedValue('evt-recusa'),
      recordOrThrow: jest.fn().mockResolvedValue('evt-atestado'),
      linkGeneration: jest.fn().mockResolvedValue(undefined),
    };
    interceptor = new ContentSafetyInterceptor(safety as unknown as ContentSafetyService);
    next = { handle: jest.fn(() => of({ id: 'gen-1', status: 'PROCESSING', creditsConsumed: 10 })) };
  });

  /** roda o pedido até a resposta, como o Nest faz */
  async function run(c: ExecutionContext): Promise<unknown> {
    return lastValueFrom(await interceptor.intercept(c, next));
  }

  describe('menor de idade', () => {
    it('recusa antes do provedor e registra o termo e um trecho (nunca o pedido inteiro)', async () => {
      const prompt = `a cinematic photo of a teen girl ${'in soft window light '.repeat(30)}`;
      await expect(run(ctx('POST', '/api/v1/generations/generate-image', { prompt, model: 'sem-censura' }))).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'CONTENT_POLICY_MINOR' }),
        status: 422,
      });
      expect(next.handle).not.toHaveBeenCalled();
      expect(safety.record).toHaveBeenCalledTimes(1);
      const event = safety.record.mock.calls[0][0];
      expect(event).toMatchObject({ kind: 'MINOR_BLOCKED', userId: 'user-1', match: 'teen', route: 'POST /api/v1/generations/generate-image' });
      expect(event.excerpt.startsWith('a cinematic photo of a teen girl')).toBe(true);
      expect(event.excerpt.length).toBeLessThanOrEqual(300);
    });

    it('pega o menor em qualquer campo de texto, inclusive aninhado', async () => {
      const body = { image: 'data:image/png;base64,AAAA', options: { script: 'ela tem 15 anos' } };
      await expect(run(ctx('POST', '/api/v1/avatars/abc/generate-video', body))).rejects.toBeInstanceOf(BusinessException);
      expect(safety.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'MINOR_BLOCKED', match: expect.stringContaining('15') }));
    });

    it('vem antes do atestado: troca de rosto com atestado e menor no texto é recusada como menor', async () => {
      const body = { source_image: FOTO, target_image: FOTO, consent_confirmed: true, prompt: 'schoolgirl' };
      await expect(run(ctx('POST', '/api/v1/generations/face-swap', body))).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'CONTENT_POLICY_MINOR' }),
      });
      expect(safety.recordOrThrow).not.toHaveBeenCalled();
    });

    it('falha ao gravar o evento não libera o pedido', async () => {
      safety.record.mockResolvedValue(null); // o service já engole o erro do banco; a recusa continua
      await expect(run(ctx('POST', '/api/v1/generations/generate-image', { prompt: 'novinha' }))).rejects.toBeInstanceOf(BusinessException);
      expect(next.handle).not.toHaveBeenCalled();
    });
  });

  describe('alfabeto que a trava não lê', () => {
    it('vira 422 CONTENT_POLICY_LANGUAGE e não entra na trilha de menor', async () => {
      const body = { prompt: 'नग्न महिला समुद्र तट पर', model: 'sem-censura' };
      await expect(run(ctx('POST', '/api/v1/generations/generate-image', body))).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'CONTENT_POLICY_LANGUAGE' }),
        status: 422,
      });
      expect(safety.record).not.toHaveBeenCalled();
      expect(next.handle).not.toHaveBeenCalled();
    });

    it('hebraico com termo de menor vira 422 CONTENT_POLICY_MINOR e fica registrado', async () => {
      await expect(run(ctx('POST', '/api/v1/generations/generate-image', { prompt: 'ילדה עירומה' }))).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'CONTENT_POLICY_MINOR' }),
      });
      expect(safety.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'MINOR_BLOCKED' }));
    });
  });

  describe('pedido grande demais', () => {
    it('vira 413 REQUEST_TOO_LARGE e não entra na trilha de menor', async () => {
      const body = { prompt: 'a woman on the beach '.repeat(3_000), model: 'gpt-image-2' };
      await expect(run(ctx('POST', '/api/v1/generations/generate-image', body))).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'REQUEST_TOO_LARGE' }),
        status: 413,
      });
      expect(safety.record).not.toHaveBeenCalled();
      expect(next.handle).not.toHaveBeenCalled();
    });

    it('corpo com textos demais também é 413, nunca liberado sem leitura', async () => {
      const body = { prompt: 'ok', tags: Array.from({ length: 150 }, (_, i) => ({ name: `tag ${i}`, title: `t ${i}` })) };
      await expect(run(ctx('POST', '/api/v1/generations/generate-image', body))).rejects.toMatchObject({ status: 413 });
      expect(safety.record).not.toHaveBeenCalled();
    });
  });

  describe('atestado de imagem', () => {
    it('troca de rosto sem atestado é recusada e registrada', async () => {
      await expect(run(ctx('POST', '/api/v1/generations/face-swap', { source_image: FOTO, target_image: FOTO }))).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'CONSENT_REQUIRED' }),
        status: 400,
      });
      expect(safety.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'CONSENT_MISSING', route: 'POST /api/v1/generations/face-swap' }));
      expect(next.handle).not.toHaveBeenCalled();
    });

    it('com atestado: grava ANTES do handler e liga à geração criada depois', async () => {
      const out = await run(ctx('POST', '/api/v1/generations/face-swap', { source_image: FOTO, target_image: FOTO, consent_confirmed: true }));
      expect(out).toMatchObject({ id: 'gen-1' });
      expect(safety.recordOrThrow).toHaveBeenCalledWith(expect.objectContaining({ kind: 'CONSENT_ATTESTED', userId: 'user-1' }));
      expect(safety.recordOrThrow.mock.invocationCallOrder[0]).toBeLessThan(next.handle.mock.invocationCallOrder[0]);
      await flush();
      expect(safety.linkGeneration).toHaveBeenCalledWith('evt-atestado', 'gen-1');
      expect(safety.record).not.toHaveBeenCalled();
    });

    it('resposta com generationId (avatares) também liga', async () => {
      next.handle.mockReturnValue(of({ generationId: 'gen-av', id: 'avatar-1' }));
      await run(ctx('POST', '/api/v1/generations/face-swap', { source_image: FOTO, target_image: FOTO, consent_confirmed: true }));
      await flush();
      expect(safety.linkGeneration).toHaveBeenCalledWith('evt-atestado', 'gen-av');
    });

    it('sem gravar o atestado, o pedido não segue (fail closed)', async () => {
      safety.recordOrThrow.mockRejectedValue(new ServiceUnavailableException('sem banco'));
      await expect(
        run(ctx('POST', '/api/v1/generations/virtual-try-on', { influencer_image: FOTO, clothing_image: FOTO, consent_confirmed: true })),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(next.handle).not.toHaveBeenCalled();
    });

    it('falha ao ligar à geração não derruba a resposta', async () => {
      safety.linkGeneration.mockRejectedValue(new Error('db fora'));
      const out = await run(ctx('POST', '/api/v1/generations/face-swap', { source_image: FOTO, target_image: FOTO, consent_confirmed: true }));
      await flush();
      expect(out).toMatchObject({ id: 'gen-1' });
      expect(safety.linkGeneration).toHaveBeenCalled();
    });

    it('resposta sem id: nada a ligar', async () => {
      next.handle.mockReturnValue(of({ ok: true }));
      await run(ctx('POST', '/api/v1/generations/face-swap', { source_image: FOTO, target_image: FOTO, consent_confirmed: true }));
      await flush();
      expect(safety.linkGeneration).not.toHaveBeenCalled();
    });

    it('"true" em texto não vale como atestado (só o booleano)', async () => {
      await expect(run(ctx('POST', '/api/v1/generations/face-swap', { source_image: FOTO, target_image: FOTO, consent_confirmed: 'true' })))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONSENT_REQUIRED' }) });
    });

    it.each([
      '/API/V1/GENERATIONS/FACE-SWAP',
      '/api/v1/generations/Face-Swap/',
      '/api/v1/generations/face-swap//',
      '/api/v1//generations/face-swap?x=1',
      '/api/v1/generations/face-swap/?consent_confirmed=true',
    ])('maiúscula, barra no fim ou query não driblam a regra: %s', async (url) => {
      await expect(run(ctx('POST', url, { source_image: FOTO, target_image: FOTO }))).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'CONSENT_REQUIRED' }),
      });
      expect(next.handle).not.toHaveBeenCalled();
    });

    it('usa a rota que o Express casou quando ela existe', async () => {
      const c = ctx('post', '/qualquer/coisa', { source_image: FOTO, target_image: FOTO }, { routePath: '/api/v1/generations/face-swap' });
      await expect(run(c)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONSENT_REQUIRED' }) });
    });

    it('provador virtual exige sempre', async () => {
      await expect(run(ctx('POST', '/api/v1/generations/virtual-try-on', { influencer_image: FOTO, clothing_image: FOTO }))).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'CONSENT_REQUIRED' }),
      });
    });

    it('ferramenta de despir (deepdeep) exige nas duas rotas de imagem, com ou sem foto', async () => {
      for (const url of ['/api/v1/generations/generate-image', '/api/v1/generations/generate-image-auto']) {
        for (const body of [{ prompt: 'portrait', model: 'deepdeep' }, { prompt: 'portrait', model: 'deepdeep', images: [{ base64: FOTO }] }]) {
          await expect(run(ctx('POST', url, body))).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONSENT_REQUIRED' }) });
        }
      }
      expect(next.handle).not.toHaveBeenCalled();
    });

    it('modelo sem censura com foto exige; sem foto (só texto) não', async () => {
      await expect(
        run(ctx('POST', '/api/v1/generations/generate-image', { prompt: 'portrait', model: 'sem-censura', images: [{ base64: FOTO }] })),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONSENT_REQUIRED' }) });
      await run(ctx('POST', '/api/v1/generations/generate-image', { prompt: 'portrait', model: 'sem-censura', images: [] }));
      await run(ctx('POST', '/api/v1/generations/generate-image-auto', { prompt: 'portrait', model: 'sem-censura' }));
      expect(next.handle).toHaveBeenCalledTimes(2);
      expect(safety.recordOrThrow).not.toHaveBeenCalled();
    });

    it.each([
      ['image-to-video-wavespeed', { prompt: 'walks', first_frame: FOTO }],
      ['image-to-video-seedance-spicy', { first_frame: FOTO }],
      ['image-to-video-comfydeploy', { prompt: 'walks', first_frame: FOTO }],
      ['minimax-h3-image-to-video', { prompt: 'walks', first_frame: FOTO }],
      ['minimax-h3-reference-to-video', { prompt: 'walks', reference_images: [{ base64: FOTO }] }],
      ['minimax-h3-reference-to-video', { prompt: 'walks', reference_videos: [{ base64: 'AAAA' }] }],
      ['motion-control', { video: 'AAAA', image: FOTO }],
      ['talking-avatar', { text: 'oi, tudo bem?', image: FOTO }],
    ])('rota que manda a foto a provedor sem filtro exige: %s', async (name, body) => {
      await expect(run(ctx('POST', `/api/v1/generations/${name}`, body))).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'CONSENT_REQUIRED' }),
      });
      expect(next.handle).not.toHaveBeenCalled();
    });

    it('provedor com filtro e foto: segue sem atestado e sem registro', async () => {
      await run(ctx('POST', '/api/v1/generations/image-to-video-kling', { first_frame: FOTO, resolution: 'RES_720P' }));
      await run(ctx('POST', '/api/v1/generations/generate-image', { prompt: 'portrait', model: 'gpt-image-2', images: [{ base64: FOTO }] }));
      expect(next.handle).toHaveBeenCalledTimes(2);
      expect(safety.record).not.toHaveBeenCalled();
      expect(safety.recordOrThrow).not.toHaveBeenCalled();
    });

    it('provedor com filtro, foto e atestado: grava e liga (é o que libera o fallback sem censura)', async () => {
      await run(ctx('POST', '/api/v1/generations/generate-image', { prompt: 'portrait', model: 'gpt-image-2', images: [{ base64: FOTO }], consent_confirmed: true }));
      await run(ctx('POST', '/api/v1/generations/seedance-video', { prompt: 'walks', first_frame: { base64: FOTO }, consent_confirmed: true }));
      await flush();
      expect(safety.recordOrThrow).toHaveBeenCalledTimes(2);
      expect(safety.linkGeneration).toHaveBeenCalledTimes(2);
    });

    it('atestado sem foto (texto puro) não é gravado: não há imagem a atestar', async () => {
      await run(ctx('POST', '/api/v1/generations/generate-image', { prompt: 'portrait', model: 'gpt-image-2', consent_confirmed: true }));
      await run(ctx('POST', '/api/v1/generations/text-to-video', { prompt: 'a beach', consent_confirmed: true }));
      expect(safety.recordOrThrow).not.toHaveBeenCalled();
    });
  });

  it('geração comum de adulto passa sem registro nenhum', async () => {
    await run(ctx('POST', '/api/v1/generations/generate-image', { prompt: 'a 25 year old woman, studio light', model: 'gpt-image-2' }));
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(safety.record).not.toHaveBeenCalled();
    expect(safety.recordOrThrow).not.toHaveBeenCalled();
  });

  it('GET não é inspecionado', async () => {
    await run(ctx('GET', '/api/v1/generations/events', undefined));
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(safety.record).not.toHaveBeenCalled();
  });
});

describe('requiresConsent', () => {
  it.each([
    ['/api/v1/generations/face-swap', {}, true],
    ['/api/v1/generations/face-swap/', {}, true],
    ['/api/v1/generations/face-swap?x=1', {}, true],
    ['/API/V1/Generations/Face-Swap', {}, true],
    ['/api/v1/generations/virtual-try-on', {}, true],
    ['/api/v1/generations/motion-control', {}, true],
    ['/api/v1/generations/talking-avatar', {}, true],
    ['/api/v1/generations/generate-image', { model: 'deepdeep' }, true],
    ['/api/v1/generations/generate-image-auto', { model: 'deepdeep' }, true],
    ['/api/v1/generations/generate-image', { model: 'sem-censura', images: [{ base64: 'x' }] }, true],
    ['/api/v1/generations/generate-image', { model: 'SEM-CENSURA', images: [{ base64: 'x' }] }, true],
    ['/api/v1/generations/generate-image', { model: 'sem-censura' }, false],
    ['/api/v1/generations/generate-image', { model: 'gpt-image-2', images: [{ base64: 'x' }] }, false],
    ['/api/v1/generations/image-to-video-wavespeed', { first_frame: 'x' }, true],
    ['/api/v1/generations/image-to-video-wavespeed', { first_frame: '  ' }, false],
    ['/api/v1/generations/minimax-h3-reference-to-video', { reference_audios: [{ base64: 'x' }] }, false],
    ['/api/v1/generations/image-to-video', { first_frame: 'x' }, false],
    ['/api/v1/generations/text-to-video', { prompt: 'x' }, false],
    ['/api/v1/generations/constructor', {}, false],
  ])('%s %j -> %s', (path, body, expected) => {
    expect(requiresConsent(path, body)).toBe(expected);
  });
});

describe('consentDecision', () => {
  it('distingue obrigatório, opcional (com foto em provedor com filtro) e nada a atestar', () => {
    expect(consentDecision('/api/v1/generations/face-swap', {})).toBe('required');
    expect(consentDecision('/api/v1/generations/image-to-video-kie', { first_frame: 'x' })).toBe('optional');
    expect(consentDecision('/api/v1/generations/generate-image', { model: 'gemini-3-pro-image-preview', images: [{}] })).toBe('optional');
    expect(consentDecision('/api/v1/generations/omni-video', { video: { base64: 'x' } })).toBe('optional');
    expect(consentDecision('/api/v1/generations/omni-video', { prompt: 'x' })).toBe('none');
    expect(consentDecision('/api/v1/avatars/abc/generate-video', { image: 'x' })).toBe('none');
  });
});

describe('auxiliares', () => {
  it('normalizePath', () => {
    expect(normalizePath('/API/v1//Generations/Face-Swap///?a=1#x')).toBe('/api/v1/generations/face-swap');
    expect(normalizePath('')).toBe('/');
    expect(normalizePath(undefined)).toBe('/');
  });

  it('generationIdOf', () => {
    expect(generationIdOf({ id: 'g1', status: 'PROCESSING' })).toBe('g1');
    expect(generationIdOf({ generationId: 'g2', id: 'a1' })).toBe('g2');
    expect(generationIdOf({ id: '' })).toBeNull();
    expect(generationIdOf([{ id: 'g1' }])).toBeNull();
    expect(generationIdOf(null)).toBeNull();
  });

  it('isUncensoredModel', () => {
    for (const slug of ['sem-censura', 'deepdeep', 'wavespeed-ltx-spicy', 'comfydeploy-wan', 'wavespeed-minimax-h3', 'futuro-modelo-unlocked']) {
      expect(isUncensoredModel(slug)).toBe(true);
    }
    for (const slug of ['gpt-image-2', 'gemini-3-pro-image-preview', 'veo-3.1-generate-001', '', undefined, 42]) {
      expect(isUncensoredModel(slug)).toBe(false);
    }
  });

  it('safetyExcerpt junta os textos livres e corta em 300', () => {
    expect(safetyExcerpt({ prompt: 'a  b', script: 'c', negative_prompt: 'd', image: 'https://x/y.png' })).toBe('a b c');
    expect(safetyExcerpt({ prompt: 'x'.repeat(1000) })).toHaveLength(300);
    expect(safetyExcerpt({})).toBeNull();
  });
});

/**
 * A tabela de regras tem que bater com o controller e os DTOs: rota que recebe foto/vídeo fora da tabela escapa da
 * regra, e DTO sem `consent_confirmed` devolve 400 (forbidNonWhitelisted) quando o site repete o pedido com o
 * atestado. O controller é lido como texto para não carregar o GenerationsService inteiro no teste.
 */
describe('CONSENT_RULES × GenerationsController × DTOs', () => {
  type DtoClass = new () => object;
  const DTO_DIR = join(__dirname, '../../generations/dto');
  const CONTROLLER = join(__dirname, '../../generations/generations.controller.ts');
  /** campo de mídia no DTO: image(s), frame, video(s) no fim do nome (os *_mime_type ficam de fora) */
  const MEDIA_PROP = /(?:^|_)(?:images?|frames?|videos?)$/;

  const dtoClasses = new Map<string, DtoClass>();
  const postRoutes = new Map<string, string>(); // rota → nome da classe do DTO do @Body

  function dtoFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return dtoFiles(full);
      return name.endsWith('.dto.ts') ? [full] : [];
    });
  }

  function propsOf(dto: DtoClass): Set<string> {
    return new Set(getMetadataStorage().getTargetValidationMetadatas(dto, '', true, false).map((m) => m.propertyName));
  }

  beforeAll(async () => {
    for (const file of dtoFiles(DTO_DIR)) {
      const mod = (await import(file)) as Record<string, unknown>;
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value === 'function') dtoClasses.set(name, value as DtoClass);
      }
    }
    const source = readFileSync(CONTROLLER, 'utf8');
    for (const chunk of source.split(/(?=@(?:Post|Get|Delete|Patch|Put|Sse)\()/)) {
      const route = /^@Post\('([^']+)'\)/.exec(chunk);
      const body = /@Body\(\)\s+dto:\s*(\w+)/.exec(chunk);
      if (route && body) postRoutes.set(route[1], body[1]);
    }
  });

  it('leu o controller e os DTOs', () => {
    expect(postRoutes.size).toBeGreaterThan(20);
    expect(postRoutes.get('face-swap')).toBe('GenerateFaceSwapDto');
  });

  it('toda rota da tabela existe no controller e os campos de mídia existem no DTO', () => {
    for (const [route, rule] of Object.entries(CONSENT_RULES)) {
      const dtoName = postRoutes.get(route);
      expect({ route, dtoName }).toEqual({ route, dtoName: expect.any(String) });
      const props = propsOf(dtoClasses.get(dtoName!)!);
      for (const field of rule.media) expect({ route, field, exists: props.has(field) }).toEqual({ route, field, exists: true });
    }
  });

  it('toda rota de geração que recebe foto ou vídeo está na tabela', () => {
    for (const [route, dtoName] of postRoutes) {
      const dto = dtoClasses.get(dtoName);
      if (!dto) continue;
      const media = [...propsOf(dto)].filter((p) => MEDIA_PROP.test(p));
      if (media.length) expect({ route, media, inTable: route in CONSENT_RULES }).toEqual({ route, media, inTable: true });
    }
  });

  it('o DTO de toda rota da tabela aceita consent_confirmed booleano (e recusa "true" em texto)', async () => {
    for (const route of Object.keys(CONSENT_RULES)) {
      const dto = dtoClasses.get(postRoutes.get(route)!)!;
      const ok = await validate(plainToInstance(dto, { consent_confirmed: true }), { whitelist: true, forbidNonWhitelisted: true });
      expect({ route, errors: ok.filter((e) => e.property === 'consent_confirmed').length }).toEqual({ route, errors: 0 });
      const bad = await validate(plainToInstance(dto, { consent_confirmed: 'true' }), { whitelist: true, forbidNonWhitelisted: true });
      const constraints = bad.find((e) => e.property === 'consent_confirmed')?.constraints ?? {};
      expect({ route, isBoolean: 'isBoolean' in constraints }).toEqual({ route, isBoolean: true });
    }
  });
});
