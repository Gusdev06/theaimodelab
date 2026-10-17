import {
  ConsentRequiredSafetyError,
  ContentSafetyError,
  decideSafetyFallback,
  isMinorSafetyBlock,
  isTerminalSafetyBlock,
  minorBlockAuditOf,
  minorSupportCodeOf,
  MinorSafetyBlockError,
  MINOR_BLOCK_USER_MESSAGE,
  RefinedPromptMinorBlockError,
  safetyFallbackVerdict,
  UnverifiedContentBlockError,
} from '../content-safety.error';
import { toPreflightStatus } from '../../../content-safety/preflight-status';
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
    ['erro público com espaços', 'Veo generation failed: public error minor detected.'],
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
    ['erro público de outro tipo', 'Public error: minor timeout, retry later'],
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
  const TARGETS = ['uncensored', 'same_provider'] as const;
  const PREFLIGHTS = ['clean', 'gray', 'flagged', 'unavailable'] as const;
  const NOT_CLEAN = ['gray', 'flagged', 'unavailable'] as const;

  describe('recusa por menor: encerra em qualquer alvo, com ou sem foto, com qualquer veredito', () => {
    const cases = TARGETS.flatMap((target) =>
      PREFLIGHTS.flatMap((preflight) =>
        [true, false].map((hasUserImages) => ({
          target,
          preflight,
          hasUserImages,
          hasConsent: hasUserImages,
        })),
      ),
    );
    it.each(cases)('%j → fail_minor', (input) => {
      expect(safetyFallbackVerdict({ ...input, isMinor: true })).toEqual({
        decision: 'fail_minor',
        reason: 'minor',
      });
    });
  });

  describe('com mídia do usuário e sem checagem limpa da imagem: terminal nos DOIS alvos, com ou sem atestado', () => {
    const cases = TARGETS.flatMap((target) =>
      NOT_CLEAN.flatMap((preflight) =>
        [true, false].map((hasConsent) => ({ target, preflight, hasConsent })),
      ),
    );
    it.each(cases)('%j → fail_blocked (unverified_media)', (input) => {
      const verdict = safetyFallbackVerdict({
        ...input,
        isMinor: false,
        hasUserImages: true,
      });
      expect(verdict).toEqual({
        decision: 'fail_blocked',
        reason: 'unverified_media',
      });
      expect(
        decideSafetyFallback({ ...input, isMinor: false, hasUserImages: true }),
      ).toBe('fail_blocked');
    });
  });

  describe("com mídia do usuário e checagem 'clean'", () => {
    it.each([
      ['uncensored', true, 'allow_fallback', null],
      ['uncensored', false, 'fail_blocked', 'needs_consent'],
      // reescrever o prompt e reenviar a mesma foto não existe, nem com a foto limpa (camada 4, regra 3)
      ['same_provider', true, 'fail_blocked', 'unverified_media'],
      ['same_provider', false, 'fail_blocked', 'unverified_media'],
    ] as const)(
      'alvo %s, atestado=%s → %s (%s)',
      (target, hasConsent, decision, reason) => {
        expect(
          safetyFallbackVerdict({
            target,
            isMinor: false,
            hasUserImages: true,
            hasConsent,
            preflight: 'clean',
          }),
        ).toEqual({ decision, reason });
      },
    );
  });

  describe('só texto: o veredito da imagem não conta (comportamento de antes)', () => {
    const cases = TARGETS.flatMap((target) =>
      PREFLIGHTS.map((preflight) => ({ target, preflight })),
    );
    it.each(cases)('%j → allow_fallback', (input) => {
      expect(
        decideSafetyFallback({
          ...input,
          isMinor: false,
          hasUserImages: false,
          hasConsent: false,
        }),
      ).toBe('allow_fallback');
    });
  });
});

describe('toPreflightStatus', () => {
  it.each([
    ['clean', 'clean'],
    ['gray', 'gray'],
    ['flagged', 'flagged'],
    ['unavailable', 'unavailable'],
    ['CLEAN', 'unavailable'],
    ['', 'unavailable'],
    [null, 'unavailable'],
    [undefined, 'unavailable'],
    [1, 'unavailable'],
  ] as const)(
    '%j → %s (valor desconhecido nunca vira clean)',
    (value, expected) => {
      expect(toPreflightStatus(value)).toBe(expected);
    },
  );
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
      isTerminalSafetyBlock(
        new UnverifiedContentBlockError(
          'content policy',
          'veo3',
          'unverified_media',
        ),
      ),
    ).toBe(true);
    expect(
      isTerminalSafetyBlock(new RefinedPromptMinorBlockError('teen')),
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

describe('foto sem checagem limpa e reescrita barrada', () => {
  it('foto sem checagem limpa sai como CONTENT_SAFETY_BLOCKED com o texto genérico (sem pedir atestado)', () => {
    const error = new UnverifiedContentBlockError(
      new ContentSafetyError('Request violates content policy', '62263041'),
      'grok-imagine',
      'unverified_media',
    );
    expect(error.model).toBe('grok-imagine');
    expect(error.source).toBe('unverified_media');
    expect(error.supportCode).toBe('62263041');
    expect(error.providerDetail).toContain('content policy');
    const code = failureCodeOf(error, true);
    expect(code).toBe(GenerationFailureCode.CONTENT_SAFETY_BLOCKED);
    expect(failureUserMessage(code, error)).toBe(CONTENT_BLOCKED_USER_MESSAGE);
  });

  it('reescrita acusada pela trava sai como menor, com rota refiner e o termo como match', () => {
    const error = new RefinedPromptMinorBlockError(' teen ');
    expect(error).toBeInstanceOf(MinorSafetyBlockError);
    expect(failureCodeOf(error, true)).toBe(
      GenerationFailureCode.CONTENT_POLICY_MINOR,
    );
    expect(minorBlockAuditOf(error)).toEqual({
      source: 'refiner',
      match: 'teen',
    });
    expect(
      minorBlockAuditOf(new RefinedPromptMinorBlockError(undefined)),
    ).toEqual({ source: 'refiner', match: 'refiner' });
  });

  it('recusa do provedor continua como provider com o código de criança', () => {
    expect(
      minorBlockAuditOf(new MinorSafetyBlockError('code 58061214', 'veo3')),
    ).toEqual({ source: 'provider', match: '58061214' });
    expect(minorBlockAuditOf(new Error('sexual/minors'))).toEqual({
      source: 'provider',
      match: 'provider',
    });
  });
});
