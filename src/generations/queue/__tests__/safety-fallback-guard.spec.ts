import { createHash } from 'crypto';
import {
  checkRefinedPrompt,
  jobCarriesUserMedia,
  mediaUrlForLog,
  providerMessageForLog,
  refinedPromptBlockOf,
  requestTextsOfJob,
  stackFramesForLog,
  textFingerprintForLog,
  withRefreshedMediaUrls,
} from '../safety-fallback-guard';
import {
  RefinedPromptMinorBlockError,
  safetyFallbackVerdict,
  UnverifiedContentBlockError,
} from '../../errors/content-safety.error';
import {
  failureCodeOf,
  GenerationFailureCode,
} from '../../errors/failure-reason';

/**
 * Peças puras da guarda dos desvios: mídia do usuário no job, trava de texto sobre o prompt reescrito, URLs de
 * entrada reassinadas e o log sem o texto do pedido nem a URL assinada.
 */
describe('jobCarriesUserMedia', () => {
  it.each([
    ['hasInputImages', { hasInputImages: true }],
    ['hasVideoInput', { hasVideoInput: true }],
    ['imageUrls (Grok/Kling/kie)', { imageUrls: ['https://cdn.test/a.png'] }],
    [
      'imageUrl (LTX/ComfyDeploy/MiniMax)',
      { imageUrl: 'https://cdn.test/a.png' },
    ],
    ['videoUrl (motion control)', { videoUrl: 'https://cdn.test/a.mp4' }],
    ['troca de rosto', { sourceImageUrl: 'https://cdn.test/a.png' }],
    [
      'referências do Seedance',
      { referenceImageUrls: ['https://cdn.test/a.png'] },
    ],
    ['vídeo de referência', { referenceVideoUrls: ['https://cdn.test/a.mp4'] }],
    [
      'clipes do Omni',
      { videoList: [{ url: 'https://cdn.test/a.mp4', start: 0, ends: 3 }] },
    ],
    ['primeiro frame', { firstFrameUrl: 'https://cdn.test/a.png' }],
    ['último frame', { lastImageUrl: 'https://cdn.test/a.png' }],
    [
      'áudio de referência (Seedance só com a voz)',
      { referenceAudioUrls: ['https://cdn.test/voz.mp3'] },
    ],
    ['áudio da clonagem de voz', { audioUrl: 'https://cdn.test/voz.mp3' }],
  ])('%s → leva mídia', (_label, data) => {
    expect(
      jobCarriesUserMedia({ generationId: 'g', prompt: 'x', ...data }),
    ).toBe(true);
  });

  it.each([
    ['só texto', { prompt: 'mulher adulta na praia', hasInputImages: false }],
    ['listas vazias', { imageUrls: [], referenceImageUrls: [], videoList: [] }],
    ['URL em branco', { imageUrl: '   ' }],
    ['marcador não booleano', { hasVideoInput: 'true' }],
    ['nulo', null],
    ['texto', 'imageUrl'],
  ])('%s → sem mídia', (_label, data) => {
    expect(jobCarriesUserMedia(data)).toBe(false);
  });
});

describe('checkRefinedPrompt / refinedPromptBlockOf', () => {
  const ADULT_ORIGINAL = 'garota de 25 anos sexy de biquini na praia';

  it('reescrita sem sinal de menor segue para o provedor', () => {
    const adult =
      'An original fictional character, adult woman walking on the beach at sunset';
    expect(checkRefinedPrompt(adult)).toEqual({ status: 'ok' });
    expect(refinedPromptBlockOf(adult, ADULT_ORIGINAL)).toBeNull();
  });

  it.each([
    [
      ADULT_ORIGINAL,
      'An original fictional character, a young girl in a two-piece swimsuit on the beach',
      'young girl',
    ],
    [
      'universitária de 22 anos de lingerie',
      'An original fictional character, a college girl in a silk set',
      'college girl',
    ],
  ])(
    'só a reescrita acusa (o original %j passou): bloqueio genérico refiner_flagged, nunca menor',
    (original, refined, match) => {
      expect(checkRefinedPrompt(original)).toEqual({ status: 'ok' });
      const block = refinedPromptBlockOf(refined, original);
      expect(block).toBeInstanceOf(UnverifiedContentBlockError);
      expect(block).not.toBeInstanceOf(RefinedPromptMinorBlockError);
      const unverified = block as UnverifiedContentBlockError;
      expect(unverified.source).toBe('refiner_flagged');
      expect(unverified.guardMatch).toBe(match);
      expect(failureCodeOf(unverified, true)).toBe(
        GenerationFailureCode.CONTENT_SAFETY_BLOCKED,
      );
      // nem o texto reescrito nem o original vão para o erro
      expect(unverified.message).not.toContain(refined);
      expect(unverified.providerDetail).not.toContain(original);
    },
  );

  it('reescrita e pedido original acusados: bloqueio por menor com o termo do ORIGINAL', () => {
    expect(checkRefinedPrompt('a teen girl on the beach')).toEqual({
      status: 'minor',
      match: 'teen',
    });
    const block = refinedPromptBlockOf(
      'a teen girl on the beach',
      'menina de 12 anos na praia',
    );
    expect(block).toBeInstanceOf(RefinedPromptMinorBlockError);
    expect((block as RefinedPromptMinorBlockError).guardMatch).toBe(
      'menina de 12',
    );
    expect(failureCodeOf(block as Error, true)).toBe(
      GenerationFailureCode.CONTENT_POLICY_MINOR,
    );
  });

  it('reescrita que a trava não consegue ler não vai ao provedor (sem evento de menor)', () => {
    expect(checkRefinedPrompt('नग्न महिला')).toEqual({ status: 'unchecked' });
    const block = refinedPromptBlockOf('नग्न महिला', ADULT_ORIGINAL);
    expect(block).toBeInstanceOf(UnverifiedContentBlockError);
    expect((block as UnverifiedContentBlockError).source).toBe(
      'refiner_unchecked',
    );
  });
});

describe('reescrita no mesmo provedor pelo modo do porteiro de imagem', () => {
  const ADULT_ORIGINAL = 'garota de 25 anos sexy de biquini na praia';
  const REFINED_FLAGGED =
    'An original fictional character, a young girl in a two-piece swimsuit on the beach';
  const PREFLIGHTS = ['clean', 'gray', 'flagged', 'unavailable'] as const;
  const JOBS_WITH_MEDIA = [
    ['foto', { prompt: 'x', imageUrls: ['https://cdn.test/a.png'] }],
    ['vídeo', { prompt: 'x', videoUrl: 'https://cdn.test/a.mp4' }],
    ['só o áudio', { prompt: 'x', referenceAudioUrls: ['https://cdn.test/v.mp3'] }],
  ] as const;

  /** veredito da guarda para a reescrita, com a mídia lida do job como no processor */
  const sameProviderVerdict = (
    job: unknown,
    enforceMediaPreflight: boolean,
    preflight: (typeof PREFLIGHTS)[number] = 'unavailable',
  ) =>
    safetyFallbackVerdict({
      target: 'same_provider',
      isMinor: false,
      hasUserImages: jobCarriesUserMedia(job),
      hasConsent: false,
      enforceMediaPreflight,
      preflight,
    });

  it.each(JOBS_WITH_MEDIA)(
    'porteiro desligado (off), job com %s: a reescrita segue (regra de antes da checagem)',
    (_label, job) => {
      expect(sameProviderVerdict(job, false)).toEqual({
        decision: 'allow_fallback',
        reason: null,
      });
    },
  );

  it.each(JOBS_WITH_MEDIA)(
    'porteiro ligado (shadow ou enforce), job com %s: a reescrita não existe, com qualquer veredito',
    (_label, job) => {
      for (const preflight of PREFLIGHTS) {
        expect(sameProviderVerdict(job, true, preflight)).toEqual({
          decision: 'fail_blocked',
          reason: 'unverified_media',
        });
      }
    },
  );

  it.each([false, true])(
    'só texto (porteiro ligado=%s): a reescrita segue',
    (enforce) => {
      expect(
        sameProviderVerdict({ prompt: 'x', hasInputImages: false }, enforce)
          .decision,
      ).toBe('allow_fallback');
    },
  );

  it('a trava sobre a reescrita não depende do modo: liberada a reescrita, a saída acusada nunca vai ao provedor', () => {
    // a guarda deixa a reescrita seguir com o porteiro desligado...
    expect(
      sameProviderVerdict(JOBS_WITH_MEDIA[0][1], false).decision,
    ).toBe('allow_fallback');
    // ...e a saída do refinador ainda passa pela trava de menor antes do provedor
    expect(refinedPromptBlockOf(REFINED_FLAGGED, ADULT_ORIGINAL)).toBeInstanceOf(
      UnverifiedContentBlockError,
    );
    expect(
      refinedPromptBlockOf('a teen girl on the beach', 'menina de 12 anos na praia'),
    ).toBeInstanceOf(RefinedPromptMinorBlockError);
  });
});

describe('withRefreshedMediaUrls', () => {
  const refresh = jest.fn(async (url: string) => `${url}?nova=1`);

  beforeEach(() => refresh.mockClear());

  it('troca toda URL de mídia do job (as de jobCarriesUserMedia) e deixa o resto igual', async () => {
    const job = {
      generationId: 'g',
      prompt: 'https://texto.que/nao-e-midia',
      imageUrl: 'https://s3.test/a.png',
      videoUrl: 'https://s3.test/v.mp4',
      audioUrl: '   ',
      imageUrls: ['https://s3.test/1.png', 'https://s3.test/2.png'],
      referenceAudioUrls: ['https://s3.test/voz.mp3'],
      videoList: [{ url: 'https://s3.test/c.mp4', start: 0, ends: 3 }, null],
      hasInputImages: true,
    };

    const fresh = await withRefreshedMediaUrls(job, refresh);

    expect(fresh).toEqual({
      ...job,
      imageUrl: 'https://s3.test/a.png?nova=1',
      videoUrl: 'https://s3.test/v.mp4?nova=1',
      imageUrls: [
        'https://s3.test/1.png?nova=1',
        'https://s3.test/2.png?nova=1',
      ],
      referenceAudioUrls: ['https://s3.test/voz.mp3?nova=1'],
      videoList: [
        { url: 'https://s3.test/c.mp4?nova=1', start: 0, ends: 3 },
        null,
      ],
    });
    expect(refresh).toHaveBeenCalledTimes(6);
    // o job original (que o BullMQ guarda) não muda
    expect(job.imageUrl).toBe('https://s3.test/a.png');
  });

  it.each([null, 'texto', ['https://s3.test/a.png']])(
    '%j sem objeto de job volta igual',
    async (data) => {
      expect(await withRefreshedMediaUrls(data, refresh)).toBe(data);
      expect(refresh).not.toHaveBeenCalled();
    },
  );
});

describe('logs sem o pedido nem a URL assinada', () => {
  const SIGNED =
    'https://s3.test/privado/inputs/gen-1/u/input.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc123';

  it('mediaUrlForLog: só origem e caminho', () => {
    expect(mediaUrlForLog(SIGNED)).toBe(
      'https://s3.test/privado/inputs/gen-1/u/input.png',
    );
    expect(mediaUrlForLog('data:image/png;base64,AAAA')).toBe('data:…');
    expect(mediaUrlForLog('não é url')).toBe('invalid-url');
    expect(mediaUrlForLog(undefined)).toBe('none');
  });

  it('providerMessageForLog: tira o pedido, a query das URLs e o data:, e corta', () => {
    const prompt = 'mulher adulta na praia ao entardecer';
    const line = providerMessageForLog(
      new Error(
        `Prompt "${prompt}" rejected.\nDownload failed: ${SIGNED} body=data:image/png;base64,AAAA`,
      ),
      [prompt, 'curto', undefined],
    );
    expect(line).not.toContain(prompt);
    expect(line).toContain(`<pedido ${textFingerprintForLog(prompt)}>`);
    expect(line).not.toContain('X-Amz-');
    expect(line).not.toContain('base64');
    expect(line).toContain('https://s3.test/privado/inputs/gen-1/u/input.png');
    expect(line).not.toContain('\n');

    const long = providerMessageForLog('x'.repeat(500));
    expect(long).toBe(`${'x'.repeat(300)}…(+200)`);
    expect(providerMessageForLog({ codigo: 1 })).toBe('[object Object]');
  });

  it('requestTextsOfJob: prompt, negativo e texto da voz', () => {
    expect(
      requestTextsOfJob({
        prompt: 'p',
        negativePrompt: 'n',
        text: 't',
        imageUrl: 'https://s3.test/a.png',
      }),
    ).toEqual(['p', 'n', 't']);
    expect(requestTextsOfJob(null)).toEqual([]);
  });

  it('stackFramesForLog: a pilha sem a mensagem', () => {
    const error = new Error('mensagem com o pedido da cliente');
    const frames = stackFramesForLog(error);
    expect(frames).toMatch(/^Error\n\s+at /);
    expect(frames).not.toContain('pedido da cliente');
    expect(stackFramesForLog('texto')).toBeUndefined();
  });
});

describe('textFingerprintForLog', () => {
  it('grava só tamanho e sha256 do texto normalizado, nunca o texto', () => {
    const text = 'Mulher   adulta na PRAIA ';
    const normalized = 'mulher adulta na praia';
    const line = textFingerprintForLog(text);
    expect(line).toBe(
      `len=${normalized.length} sha256=${createHash('sha256').update(normalized).digest('hex')}`,
    );
    expect(line).not.toContain('praia');
    expect(textFingerprintForLog('mulher adulta na praia')).toBe(line);
  });

  it('texto ausente não quebra o log', () => {
    expect(textFingerprintForLog(undefined)).toMatch(
      /^len=0 sha256=[0-9a-f]{64}$/,
    );
  });
});
