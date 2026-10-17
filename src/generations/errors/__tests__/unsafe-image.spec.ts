import { ContentSafetyError } from '../content-safety.error';
import { classifyGenerationFailure, GenerationFailureCode } from '../failure-reason';

describe('"unsafe image upload" da kie (Veo / Gemini Omni)', () => {
  const veo = 'Veo generation failed: public error unsafe image upload.';
  const omni = 'Gemini Omni generation failed: public error unsafe image upload. (400)';

  it('é reconhecido como bloqueio de conteúdo (aciona o fallback de safety)', () => {
    expect(ContentSafetyError.fromErrorMessage(veo)).toBeInstanceOf(ContentSafetyError);
    expect(ContentSafetyError.fromErrorMessage(omni)).toBeInstanceOf(ContentSafetyError);
  });

  it('o usuário vê CONTENT_SAFETY_BLOCKED, não falha genérica', () => {
    expect(classifyGenerationFailure(veo)).toBe(GenerationFailureCode.CONTENT_SAFETY_BLOCKED);
    expect(classifyGenerationFailure(omni)).toBe(GenerationFailureCode.CONTENT_SAFETY_BLOCKED);
  });

  it('erro de provedor comum continua PROVIDER_ERROR', () => {
    expect(classifyGenerationFailure('Kling generation failed: internal error, please try again later.')).toBe(
      GenerationFailureCode.PROVIDER_ERROR,
    );
  });
});
