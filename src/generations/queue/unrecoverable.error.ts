import { UnrecoverableError } from 'bullmq';

/**
 * Falha que NÃO deve passar pelo retry automático do BullMQ (bloqueio de
 * conteúdo, entrada recusada, cota do provedor, alternativa já tentada):
 * 30 s depois o resultado seria o mesmo e o provedor seria chamado de novo
 * (TKT-107). Guarda o erro original para o `handleFailure` classificar o
 * motivo real e manter a classe (ContentSafetyError, ProviderFailureError).
 */
export class GenerationUnrecoverableError extends UnrecoverableError {
  constructor(readonly original: Error) {
    super(original.message);
  }
}

export function unwrapJobError(error: Error): Error {
  return error instanceof GenerationUnrecoverableError ? error.original : error;
}

export function isUnrecoverableJobError(error: Error): boolean {
  return (
    error instanceof UnrecoverableError || error?.name === 'UnrecoverableError'
  );
}
