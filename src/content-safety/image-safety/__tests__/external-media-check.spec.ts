import { HttpStatus, Logger } from '@nestjs/common';
import { ContentSafetyEventKind } from '@prisma/client';
import { BusinessException } from '../../../common/exceptions/business.exception';
import { inlineImagesOf, type ExternalMedia } from '../external-media-check';
import { SafetyProviderUnavailableError } from '../types';
import {
  HANG,
  HANG_IGNORING_ABORT,
  READINGS,
  buildMediaCheck,
  photoBase64,
} from './external-media-check.harness';

/** Rotas sem fila: a checagem da mídia antes do cliente externo (respostas simuladas do leitor, nenhuma imagem). */

const USER = 'user-1';
const photo = (content: string): ExternalMedia => ({
  kind: 'image',
  mimeType: 'image/jpeg',
  buffer: Buffer.from(content),
});

async function rejection(promise: Promise<unknown>): Promise<BusinessException> {
  const error = await promise.then(
    () => {
      throw new Error('devia ter recusado');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(BusinessException);
  return error as BusinessException;
}

const codeOf = (error: BusinessException) =>
  (error.getResponse() as { code: string; message: string }).code;
const messageOf = (error: BusinessException) =>
  (error.getResponse() as { code: string; message: string }).message;

describe('ExternalMediaCheck (rotas sem fila)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('modo off: não monta a mídia, não lê, não grava e devolve null', async () => {
    const h = buildMediaCheck({ mode: 'off' });
    const source = jest.fn(() => [photo('child')]);
    await expect(h.check.assertSafe(source, { userId: USER, tool: 'prompt_clone' })).resolves.toBeNull();
    expect(h.check.enabled).toBe(false);
    expect(source).not.toHaveBeenCalled();
    expect(h.scanner.detect).not.toHaveBeenCalled();
    expect(h.prisma.contentSafetyScan.createMany).not.toHaveBeenCalled();
    expect(h.contentSafety.record).not.toHaveBeenCalled();
  });

  it('sem mídia visual: não chama o leitor', async () => {
    const h = buildMediaCheck();
    await expect(
      h.check.assertSafe([{ kind: 'audio', mimeType: 'audio/mpeg', buffer: Buffer.from('a') }], {
        userId: USER,
        tool: 'avatar',
      }),
    ).resolves.toBeNull();
    expect(h.scanner.detect).not.toHaveBeenCalled();
  });

  it('adulta vestida: segue com o veredito limpo e grava a checagem sem geração', async () => {
    const h = buildMediaCheck({ scans: { adulta: READINGS.adult } });
    const verdict = await h.check.assertSafe([photo('adulta')], { userId: USER, tool: 'prompt_clone' });
    expect(verdict?.verdict).toBe('CLEAN');
    expect(h.stored).toHaveLength(1);
    expect(h.stored[0]).toMatchObject({ generationId: null, userId: USER, stage: 'INPUT', verdict: 'CLEAN' });
  });

  it('nudez de adulta: segue (a exceção 18+ do Clone de Prompt continua valendo)', async () => {
    const h = buildMediaCheck({ mode: 'enforce', scans: { nua: READINGS.adultNude } });
    const verdict = await h.check.assertSafe([photo('nua')], { userId: USER, tool: 'prompt_clone' });
    expect(verdict?.verdict).toBe('CLEAN');
  });

  it('criança evidente em pedido sexual: 422 genérico, evidência e evento (forte)', async () => {
    const h = buildMediaCheck({ scans: { crianca: READINGS.child } });
    const error = await rejection(
      h.check.assertSafe([photo('crianca')], { userId: USER, tool: 'face_swap_unlocked' }),
    );
    expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(codeOf(error)).toBe('IMAGE_SAFETY_BLOCKED');
    expect(h.uploads.storeEvidence).toHaveBeenCalledTimes(1);
    expect(h.contentSafety.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        kind: ContentSafetyEventKind.IMAGE_MINOR_BLOCKED,
        route: 'input:face_swap_unlocked',
        match: 'E2/STRONG',
        excerpt: null,
      }),
    );
    // o bloqueio pontua dentro da checagem, uma vez só (a rota não soma outro ponto)
    expect(h.strikes.applySignal).toHaveBeenCalledTimes(1);
  });

  it('criança em pedido não sexual: 422, sem evento e sem guardar a foto (só o veredito, LGPD art. 14)', async () => {
    const h = buildMediaCheck({ scans: { crianca: READINGS.child } });
    const error = await rejection(
      h.check.assertSafe([photo('crianca')], { userId: USER, tool: 'brand_analyzer' }),
    );
    expect(codeOf(error)).toBe('IMAGE_SAFETY_BLOCKED');
    expect(h.uploads.storeEvidence).not.toHaveBeenCalled();
    expect(h.contentSafety.record).not.toHaveBeenCalled();
    expect(h.stored[0]).toMatchObject({ verdict: 'BLOCK', strength: 'LIGHT', sha256: null, phash: null });
  });

  it('nudez com rosto de provável menor: a retenção vira 422, a foto vai para a evidência ligada à checagem e o evento é gravado', async () => {
    const h = buildMediaCheck({ scans: { 'menor-nua': READINGS.minorNude } });
    const error = await rejection(
      h.check.assertSafe([photo('menor-nua')], { userId: USER, tool: 'prompt_clone' }),
    );
    expect(codeOf(error)).toBe('IMAGE_SAFETY_BLOCKED');
    expect(h.uploads.storeEvidence).toHaveBeenCalledWith(
      Buffer.from('menor-nua'),
      'image/jpeg',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      'media',
    );
    expect(h.stored[0]).toMatchObject({ verdict: 'HOLD', ruleId: 'E3a', evidenceKey: 'evidence/h/memoria' });
    expect(h.contentSafety.record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: ContentSafetyEventKind.IMAGE_MINOR_BLOCKED,
        route: 'input:prompt_clone',
        match: 'E3a/MEDIUM',
        generationId: null,
      }),
    );
    // a retenção convertida em bloqueio conta o ponto médio da camada 6
    expect(h.strikes.applySignal).toHaveBeenCalledWith(
      USER,
      'MEDIUM',
      'evt-1',
      expect.objectContaining({ layer: 'input', match: 'E3a/MEDIUM', generationId: null }),
    );
  });

  it('retenção de mídia guardada: a evidência sai do objeto (moveToEvidence), não de uma cópia', async () => {
    const h = buildMediaCheck({ scans: { 'menor-nua': READINGS.minorNude } });
    await rejection(
      h.check.assertSafe(
        [{ ...photo('menor-nua'), area: 'public', key: 'avatar_source/u/foto.jpg' }],
        { userId: USER, tool: 'avatar' },
      ),
    );
    expect(h.uploads.moveToEvidence).toHaveBeenCalledWith(
      'public',
      'avatar_source/u/foto.jpg',
      expect.any(String),
      expect.objectContaining({ body: Buffer.from('menor-nua') }),
    );
    expect(h.uploads.storeEvidence).not.toHaveBeenCalled();
  });

  it('toda regra devolve o mesmo código e o mesmo texto (nunca diz qual detector disparou)', async () => {
    const strong = buildMediaCheck({ scans: { a: READINGS.child } });
    const medium = buildMediaCheck({ scans: { b: READINGS.minorNude } });
    const first = await rejection(strong.check.assertSafe([photo('a')], { userId: USER, tool: 'undress' }));
    const second = await rejection(medium.check.assertSafe([photo('b')], { userId: USER, tool: 'prompt_clone' }));
    expect(codeOf(first)).toBe(codeOf(second));
    expect(messageOf(first)).toBe(messageOf(second));
    expect(messageOf(first)).not.toMatch(/menor|idade|criança|rosto|minor/i);
  });

  it('leitor fora do ar: 503 "tente em instantes", nunca segue sem checar', async () => {
    const h = buildMediaCheck({
      scans: { x: new SafetyProviderUnavailableError('rekognition', 'server_error') },
    });
    const error = await rejection(h.check.assertSafe([photo('x')], { userId: USER, tool: 'prompt_clone' }));
    expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(codeOf(error)).toBe('SAFETY_CHECK_UNAVAILABLE');
    expect(messageOf(error)).toMatch(/instantes/);
  });

  it('leitor que não responde no prazo: 503 quando o prazo da checagem estoura', async () => {
    const h = buildMediaCheck({ scans: { lento: HANG } });
    const startedAt = Date.now();
    const error = await rejection(
      h.check.assertSafe([photo('lento')], { userId: USER, tool: 'prompt_clone', timeoutMs: 50 }),
    );
    expect(codeOf(error)).toBe('SAFETY_CHECK_UNAVAILABLE');
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('leitor preso que ignora o cancelamento: o prazo total também dá 503', async () => {
    const h = buildMediaCheck({ scans: { preso: HANG_IGNORING_ABORT } });
    const error = await rejection(
      h.check.assertSafe([photo('preso')], { userId: USER, tool: 'prompt_clone', timeoutMs: 20 }),
    );
    expect(codeOf(error)).toBe('SAFETY_CHECK_UNAVAILABLE');
  }, 10_000);

  it('retenção que termina depois do prazo (banco lento): a cliente recebe 503 na hora e a evidência, o evento e o ponto saem em segundo plano', async () => {
    const h = buildMediaCheck({ scans: { 'menor-nua': READINGS.minorNude } });
    // o leitor responde, mas a gravação da checagem só termina depois do prazo total (checagem + folga)
    let releaseWrite: () => void = () => undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const write = h.prisma.contentSafetyScan.createMany.getMockImplementation()!;
    h.prisma.contentSafetyScan.createMany.mockImplementationOnce(async (args) => {
      await writeGate;
      return write(args);
    });

    const error = await rejection(
      h.check.assertSafe([photo('menor-nua')], { userId: USER, tool: 'prompt_clone', timeoutMs: 200 }),
    );
    expect(codeOf(error)).toBe('SAFETY_CHECK_UNAVAILABLE');
    expect(h.contentSafety.record).not.toHaveBeenCalled();

    releaseWrite();
    for (let tick = 0; tick < 50 && !h.strikes.applySignal.mock.calls.length; tick++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(h.uploads.storeEvidence).toHaveBeenCalledWith(
      Buffer.from('menor-nua'),
      'image/jpeg',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      'media',
    );
    expect(h.stored[0]).toMatchObject({ verdict: 'HOLD', evidenceKey: 'evidence/h/memoria' });
    expect(h.contentSafety.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: ContentSafetyEventKind.IMAGE_MINOR_BLOCKED, match: 'E3a/MEDIUM' }),
    );
    expect(h.strikes.applySignal).toHaveBeenCalledWith(
      USER,
      'MEDIUM',
      'evt-1',
      expect.objectContaining({ layer: 'input', generationId: null }),
    );
  }, 15_000);

  it('sombra sem as regras fortes agindo: registra a criança e segue (modo de medição)', async () => {
    const h = buildMediaCheck({
      env: { IMAGE_SAFETY_ENFORCE_STRONG: 'false' },
      scans: { crianca: READINGS.child },
    });
    const verdict = await h.check.assertSafe([photo('crianca')], { userId: USER, tool: 'prompt_clone' });
    expect(verdict?.verdict).toBe('BLOCK');
    expect(h.stored[0]).toMatchObject({ verdict: 'BLOCK', enforced: false });
    expect(h.contentSafety.record).not.toHaveBeenCalled();
  });

  it('inlineImagesOf: só as partes com imagem, com os bytes que vão sair', () => {
    const media = inlineImagesOf([
      { text: 'oi' } as never,
      { inline_data: { base64: photoBase64('foto'), mime_type: 'image/png' } },
    ]);
    expect(media).toEqual([{ kind: 'image', mimeType: 'image/png', buffer: Buffer.from('foto') }]);
  });
});
