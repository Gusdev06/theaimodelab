import { ErrorCodes } from '../../../common/constants/error-codes';
import {
  ContentSafetyError,
  InputImageSafetyBlockError,
  isSafetyCheckHalt,
  isTerminalSafetyBlock,
  OutputImageSafetyBlockError,
  SafetyCheckPendingError,
  SafetyCheckUnavailableError,
  TextSafetyBlockError,
} from '../content-safety.error';
import {
  classifyGenerationFailure,
  failureCodeOf,
  failureUserMessage,
  GenerationFailureCode,
  IMAGE_SAFETY_BLOCKED_MESSAGE,
  rawFailureText,
  SAFETY_CHECK_UNAVAILABLE_MESSAGE,
} from '../failure-reason';

/**
 * Erros da checagem da própria plataforma: um código público só para toda regra (entrada, texto, resultado), sem
 * dizer qual detector disparou; terminais (sem nova tentativa) menos o pendente; nunca confundidos com bloqueio de
 * provedor (que desviaria para o Unlocked).
 */
describe('erros da checagem de segurança da plataforma', () => {
  const blocks = [
    new InputImageSafetyBlockError('E2', 'STRONG'),
    new TextSafetyBlockError('T_CLASSIFIER', 'MEDIUM'),
    new OutputImageSafetyBlockError('S1', 'STRONG'),
  ];

  it.each(blocks)(
    '%s: mesmo código e mesmo texto para a cliente, sem regra nem score',
    (error) => {
      const code = failureCodeOf(error);
      expect(code).toBe(GenerationFailureCode.IMAGE_SAFETY_BLOCKED);
      const message = failureUserMessage(code, error);
      expect(message).toBe(IMAGE_SAFETY_BLOCKED_MESSAGE);
      expect(message).not.toMatch(/E2|S1|T_|STRONG|MEDIUM|menor|crian/i);
    },
  );

  it('indisponível e pendente: SAFETY_CHECK_UNAVAILABLE ("tente de novo em instantes")', () => {
    for (const error of [
      new SafetyCheckUnavailableError('rekognition', 'timeout'),
      new SafetyCheckPendingError('rekognition', 'timeout', 30_000, 0, 0),
    ]) {
      const code = failureCodeOf(error);
      expect(code).toBe(GenerationFailureCode.SAFETY_CHECK_UNAVAILABLE);
      expect(failureUserMessage(code, error)).toBe(
        SAFETY_CHECK_UNAVAILABLE_MESSAGE,
      );
    }
  });

  it('terminais (sem nova tentativa) menos o pendente, que espera na fila; nenhum desvia', () => {
    for (const error of blocks) expect(isTerminalSafetyBlock(error)).toBe(true);
    expect(
      isTerminalSafetyBlock(new SafetyCheckUnavailableError('x', 'y')),
    ).toBe(true);
    const pending = new SafetyCheckPendingError('x', 'y', 1, 0, 0);
    expect(isTerminalSafetyBlock(pending)).toBe(false);
    expect(isSafetyCheckHalt(pending)).toBe(true);
    expect(isSafetyCheckHalt(new Error('Internal Error'))).toBe(false);
  });

  it('não são ContentSafetyError e o texto não casa com os padrões de bloqueio de provedor', () => {
    for (const error of [
      ...blocks,
      new SafetyCheckUnavailableError('rekognition', 'timeout'),
      new SafetyCheckPendingError('rekognition', 'timeout', 30_000, 0, 0),
    ]) {
      expect(error).not.toBeInstanceOf(ContentSafetyError);
      expect(ContentSafetyError.fromErrorMessage(error.message)).toBeNull();
      expect([
        GenerationFailureCode.CONTENT_SAFETY_BLOCKED,
        GenerationFailureCode.CONTENT_POLICY_MINOR,
      ]).not.toContain(classifyGenerationFailure(rawFailureText(error)));
    }
  });

  it('rotas sem fila: 422 IMAGE_SAFETY_BLOCKED e 503 SAFETY_CHECK_UNAVAILABLE', () => {
    expect(ErrorCodes.IMAGE_SAFETY_BLOCKED).toMatchObject({ statusCode: 422 });
    expect(ErrorCodes.SAFETY_CHECK_UNAVAILABLE).toMatchObject({
      statusCode: 503,
    });
    expect(ErrorCodes.IMAGE_SAFETY_BLOCKED.message).toBe(
      IMAGE_SAFETY_BLOCKED_MESSAGE,
    );
  });
});
