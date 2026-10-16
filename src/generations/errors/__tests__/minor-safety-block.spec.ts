import {
  ConsentRequiredSafetyError,
  ContentSafetyError,
  decideSafetyFallback,
  isMinorSafetyBlock,
  isTerminalSafetyBlock,
  minorSupportCodeOf,
  MinorSafetyBlockError,
  MINOR_BLOCK_USER_MESSAGE,
} from '../content-safety.error';
import {
  classifyGenerationFailure,
  CONTENT_BLOCKED_NEEDS_CONSENT_MESSAGE,
  CONTENT_BLOCKED_USER_MESSAGE,
  failureCodeOf,
  failureUserMessage,
  GenerationFailureCode,
} from '../failure-reason';

/**
 * Bloqueio do provedor por MENOR nunca pode cair no Unlocked (sem censura) nem na nova tentativa com prompt
 * reescrito; foto do usuário só desvia para modelo sem censura com atestado gravado.
 */
describe('isMinorSafetyBlock', () => {
  it.each([
    [
      'código de criança do Vertex no campo',
      { message: 'blocked', supportCode: '58061214' },
    ],
    ['código de criança no texto', 'Request blocked (support code: 17301594)'],
    ['categoria de moderação', 'flagged: sexual/minors'],
    ['identificador', 'PUBLIC_ERROR_MINOR'],
    ['criança', 'The image appears to contain a child'],
    [
      '"of a minor"',
      'Content depicting sexual content of a minor is not allowed.',
    ],
    ['pt', 'Conteúdo envolvendo menores de idade'],
    [
      'detalhe técnico',
      {
        message: 'Provider error',
        providerDetail: 'Error: image contains minors',
      },
    ],
  ])('%s → menor', (_label, source) => {
    expect(isMinorSafetyBlock(source)).toBe(true);
  });

  it.each([
    ['adjetivo', 'minor scratches detected in the output'],
    ['edição', 'minor edit required'],
    [
      'código de outro bloqueio',
      { message: 'blocked', supportCode: '62263041' },
    ],
    ['número maior que contém o código', 'request id 1580612149'],
    ['nsfw adulto', 'The prompt was flagged as sexually explicit'],
    ['vazio', ''],
  ])('%s → não é menor', (_label, source) => {
    expect(isMinorSafetyBlock(source)).toBe(false);
  });

  it('extrai o código de suporte para a trilha', () => {
    expect(minorSupportCodeOf({ supportCode: '58061214' })).toBe('58061214');
    expect(minorSupportCodeOf('blocked, code 17301594.')).toBe('17301594');
    expect(minorSupportCodeOf('blocked')).toBeNull();
  });
});

describe('decideSafetyFallback', () => {
  describe("alvo 'uncensored' (fallbackToSeedream: Unlocked sem censura com as fotos da geração)", () => {
    it.each([
      [
        { isMinor: true, hasUserImages: false, hasConsent: false },
        'fail_minor',
      ],
      [{ isMinor: true, hasUserImages: true, hasConsent: true }, 'fail_minor'],
      [
        { isMinor: false, hasUserImages: true, hasConsent: false },
        'fail_blocked',
      ],
      [
        { isMinor: false, hasUserImages: true, hasConsent: true },
        'allow_fallback',
      ],
      [
        { isMinor: false, hasUserImages: false, hasConsent: false },
        'allow_fallback',
      ],
    ] as const)('%j → %s', (input, expected) => {
      expect(decideSafetyFallback({ target: 'uncensored', ...input })).toBe(
        expected,
      );
    });
  });

  describe("alvo 'same_provider' (prompt reescrito no mesmo provedor com filtro, que já tem a foto)", () => {
    it.each([
      [
        { isMinor: true, hasUserImages: false, hasConsent: false },
        'fail_minor',
      ],
      [{ isMinor: true, hasUserImages: true, hasConsent: true }, 'fail_minor'],
      // foto sem atestado NÃO impede a nova tentativa: a foto não vai a lugar novo e o filtro continua
      [
        { isMinor: false, hasUserImages: true, hasConsent: false },
        'allow_fallback',
      ],
      [
        { isMinor: false, hasUserImages: true, hasConsent: true },
        'allow_fallback',
      ],
      [
        { isMinor: false, hasUserImages: false, hasConsent: false },
        'allow_fallback',
      ],
    ] as const)('%j → %s', (input, expected) => {
      expect(decideSafetyFallback({ target: 'same_provider', ...input })).toBe(
        expected,
      );
    });
  });
});

describe('falha por menor', () => {
  it('sai como CONTENT_POLICY_MINOR (o site mostra a recusa por menor, sem sugerir modelo sem censura)', () => {
    const error = new MinorSafetyBlockError(
      { message: 'blocked', supportCode: '58061214' },
      'veo3',
    );
    expect(error.model).toBe('veo3');
    expect(
      classifyGenerationFailure(`${error.message} ${error.providerDetail}`),
    ).toBe(GenerationFailureCode.CONTENT_POLICY_MINOR);
  });
});

describe('foto sem atestado (fail_blocked)', () => {
  it('sai como CONTENT_BLOCKED_NEEDS_CONSENT pelo código que o erro carrega, com o texto que pede a autorização', () => {
    const error = new ConsentRequiredSafetyError(
      new ContentSafetyError('Request violates content policy', '62263041'),
      'gpt-image-2',
    );
    expect(error.model).toBe('gpt-image-2');
    expect(error.supportCode).toBe('62263041');
    expect(error.providerDetail).toContain('content policy');
    expect(failureCodeOf(error, true)).toBe(
      GenerationFailureCode.CONTENT_BLOCKED_NEEDS_CONSENT,
    );
    expect(
      failureUserMessage(
        GenerationFailureCode.CONTENT_BLOCKED_NEEDS_CONSENT,
        error,
      ),
    ).toBe(CONTENT_BLOCKED_NEEDS_CONSENT_MESSAGE);
    expect(CONTENT_BLOCKED_NEEDS_CONSENT_MESSAGE).toBe(
      'O filtro do modelo bloqueou esta geração. Para tentar no Unlocked com a sua foto, marque a autorização de imagem e gere de novo.',
    );
  });

  it('o código vem do erro, não do texto (o texto do bloqueio sozinho seria CONTENT_SAFETY_BLOCKED)', () => {
    const error = new ConsentRequiredSafetyError(
      'flagged as sensitive',
      'nano-banana-2',
    );
    expect(
      classifyGenerationFailure(
        `${error.message} ${error.providerDetail}`,
        true,
      ),
    ).toBe(GenerationFailureCode.CONTENT_SAFETY_BLOCKED);
    expect(failureCodeOf(error, true)).toBe(
      GenerationFailureCode.CONTENT_BLOCKED_NEEDS_CONSENT,
    );
  });
});

describe('bloqueio terminal (encerra sem nova tentativa do BullMQ)', () => {
  it('menor e foto sem atestado são terminais; o bloqueio comum não', () => {
    expect(
      isTerminalSafetyBlock(new MinorSafetyBlockError('sexual/minors', 'veo3')),
    ).toBe(true);
    expect(
      isTerminalSafetyBlock(
        new ConsentRequiredSafetyError('content policy', 'veo3'),
      ),
    ).toBe(true);
    expect(
      isTerminalSafetyBlock(new ContentSafetyError('content policy')),
    ).toBe(false);
    expect(isTerminalSafetyBlock(new Error('500 internal error'))).toBe(false);
  });

  it('código pronto no erro vence o texto; código desconhecido é ignorado', () => {
    const minor = new MinorSafetyBlockError(
      { message: 'blocked', supportCode: '17301594' },
      'veo3',
    );
    expect(failureCodeOf(minor, true)).toBe(
      GenerationFailureCode.CONTENT_POLICY_MINOR,
    );
    const forged = Object.assign(new Error('Internal server error'), {
      failureCode: 'NAO_EXISTE',
    });
    expect(failureCodeOf(forged)).toBe(GenerationFailureCode.PROVIDER_ERROR);
  });
});

describe('texto da falha para o usuário', () => {
  const raw = new Error('PUBLIC_ERROR_SEXUAL: prompt "..." flagged');

  it('bloqueios nunca mostram o texto cru do provedor', () => {
    expect(
      failureUserMessage(GenerationFailureCode.CONTENT_POLICY_MINOR, raw),
    ).toBe(MINOR_BLOCK_USER_MESSAGE);
    expect(
      failureUserMessage(GenerationFailureCode.CONTENT_SAFETY_BLOCKED, raw),
    ).toBe(CONTENT_BLOCKED_USER_MESSAGE);
    expect(
      failureUserMessage(
        GenerationFailureCode.CONTENT_BLOCKED_NEEDS_CONSENT,
        raw,
      ),
    ).toBe(CONTENT_BLOCKED_NEEDS_CONSENT_MESSAGE);
  });

  it('as demais falhas seguem com a mensagem do erro', () => {
    expect(
      failureUserMessage(
        GenerationFailureCode.PROVIDER_ERROR,
        new Error('Não foi possível gerar a imagem'),
      ),
    ).toBe('Não foi possível gerar a imagem');
  });
});
