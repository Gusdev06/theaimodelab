import { ContentSafetyError } from '../content-safety.error';
import { classifyGenerationFailure, GenerationFailureCode } from '../failure-reason';

describe('auditoria de modelos 16/11: mensagens de falha reais', () => {
  const nanoBanana =
    'Nano Banana generation failed: Google declined to generate an image for this request. Please try a different prompt.';
  const seedreamLite =
    'Seedream Lite createTask failed: The text length cannot exceed the maximum limit (code 500)';

  it('"Google declined to generate" é bloqueio de conteúdo e aciona o desvio de safety', () => {
    expect(ContentSafetyError.fromErrorMessage(nanoBanana)).toBeInstanceOf(ContentSafetyError);
    expect(classifyGenerationFailure(nanoBanana)).toBe(GenerationFailureCode.CONTENT_SAFETY_BLOCKED);
  });

  it('prompt longo do Seedream Lite vira PROMPT_TOO_LONG, não erro de provedor (sem retry cego)', () => {
    expect(classifyGenerationFailure(seedreamLite)).toBe(GenerationFailureCode.PROMPT_TOO_LONG);
    expect(ContentSafetyError.fromErrorMessage(seedreamLite)).toBeNull();
  });
});
