import { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { ContentSafetyInterceptor, requiresConsent } from '../content-safety.interceptor';
import { ContentSafetyService } from '../content-safety.service';
import { BusinessException } from '../../common/exceptions/business.exception';

function ctx(method: string, url: string, body: unknown, userId = 'user-1'): ExecutionContext {
  const req = { method, originalUrl: url, body, user: { sub: userId } };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('ContentSafetyInterceptor', () => {
  let safety: { record: jest.Mock };
  let interceptor: ContentSafetyInterceptor;
  let next: CallHandler & { handle: jest.Mock };

  beforeEach(() => {
    safety = { record: jest.fn().mockResolvedValue(undefined) };
    interceptor = new ContentSafetyInterceptor(safety as unknown as ContentSafetyService);
    next = { handle: jest.fn(() => of('ok')) };
  });

  async function run(c: ExecutionContext) {
    return interceptor.intercept(c, next);
  }

  it('recusa pedido com referência a menor antes do provedor e registra (sem o prompt inteiro)', async () => {
    const body = { prompt: 'a cinematic photo of a teen girl', model: 'sem-censura' };
    await expect(run(ctx('POST', '/api/v1/generations/generate-image', body))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'CONTENT_POLICY_MINOR' }),
    });
    expect(next.handle).not.toHaveBeenCalled();
    expect(safety.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'MINOR_BLOCKED', userId: 'user-1', match: 'teen' }));
  });

  it('pega o menor em qualquer campo de texto, inclusive aninhado', async () => {
    const body = { image: 'data:image/png;base64,AAAA', options: { script: 'ela tem 15 anos' } };
    await expect(run(ctx('POST', '/api/v1/avatars/abc/generate-video', body))).rejects.toBeInstanceOf(BusinessException);
  });

  it('troca de rosto sem atestado é recusada e registrada', async () => {
    await expect(run(ctx('POST', '/api/v1/generations/face-swap', { source_image: 'x', target_image: 'y' }))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'CONSENT_REQUIRED' }),
    });
    expect(safety.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'CONSENT_MISSING' }));
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('troca de rosto com atestado passa e o atestado fica registrado', async () => {
    const out = await run(ctx('POST', '/api/v1/generations/face-swap', { source_image: 'x', target_image: 'y', consent_confirmed: true }));
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(out).toBeDefined();
    expect(safety.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'CONSENT_ATTESTED' }));
  });

  it('"true" em texto não vale como atestado (só o booleano)', async () => {
    await expect(run(ctx('POST', '/api/v1/generations/face-swap', { source_image: 'x', target_image: 'y', consent_confirmed: 'true' })))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONSENT_REQUIRED' }) });
  });

  it('ferramenta de despir (deepdeep) exige atestado nas duas rotas de imagem', async () => {
    for (const url of ['/api/v1/generations/generate-image', '/api/v1/generations/generate-image-auto']) {
      await expect(run(ctx('POST', url, { prompt: 'portrait', model: 'deepdeep' }))).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'CONSENT_REQUIRED' }),
      });
    }
  });

  it('geração comum de adulto passa sem registro nenhum', async () => {
    await run(ctx('POST', '/api/v1/generations/generate-image', { prompt: 'a 25 year old woman, studio light', model: 'gpt-image-2' }));
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(safety.record).not.toHaveBeenCalled();
  });

  it('GET não é inspecionado', async () => {
    await run(ctx('GET', '/api/v1/generations/events', undefined));
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(safety.record).not.toHaveBeenCalled();
  });

  it('falha ao gravar o evento não libera o pedido', async () => {
    safety.record.mockResolvedValue(undefined); // o service já engole o erro do banco; a recusa continua
    await expect(run(ctx('POST', '/api/v1/generations/generate-image', { prompt: 'novinha' }))).rejects.toBeInstanceOf(BusinessException);
  });
});

describe('requiresConsent', () => {
  it.each([
    ['/api/v1/generations/face-swap', {}, true],
    ['/api/v1/generations/face-swap/', {}, true],
    ['/api/v1/generations/face-swap?x=1', {}, true],
    ['/api/v1/generations/generate-image', { model: 'deepdeep' }, true],
    ['/api/v1/generations/generate-image-auto', { model: 'deepdeep' }, true],
    ['/api/v1/generations/generate-image', { model: 'sem-censura' }, false],
    ['/api/v1/generations/virtual-try-on', { model: 'deepdeep' }, false],
    ['/api/v1/generations/image-to-video', {}, false],
  ])('%s %j -> %s', (path, body, expected) => {
    expect(requiresConsent(path, body)).toBe(expected);
  });
});
