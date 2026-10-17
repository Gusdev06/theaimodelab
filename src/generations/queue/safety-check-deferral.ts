import { DelayedError, type Job } from 'bullmq';
import {
  SAFETY_JOB_DEFERRALS_KEY,
  SAFETY_JOB_FIRST_ATTEMPT_KEY,
} from '../../content-safety/image-safety/image-safety.service';
import type { SafetyCheckPendingError } from '../errors/content-safety.error';

/**
 * Checagem de segurança pendente (fornecedor fora): o job volta à fila com espera (moveToDelayed + DelayedError, o
 * padrão do BullMQ para adiar sem contar como falha) e guarda no job a 1ª tentativa e quantos adiamentos já houve, para
 * a janela de 10 min. Nada vai ao provedor. Se o adiamento não der (sem token, lock perdido, Redis fora), devolve o
 * próprio erro pendente: o retry normal do BullMQ assume e, no fim, a geração falha como SAFETY_CHECK_UNAVAILABLE com
 * estorno. Usado pelos dois processors.
 */
export async function deferJobForSafetyCheck(
  job: Pick<Job, 'data' | 'updateData' | 'moveToDelayed'>,
  token: string | undefined,
  error: SafetyCheckPendingError,
): Promise<Error> {
  try {
    const data =
      job.data && typeof job.data === 'object'
        ? (job.data as Record<string, unknown>)
        : {};
    await job.updateData({
      ...data,
      [SAFETY_JOB_FIRST_ATTEMPT_KEY]: error.firstAttemptAt,
      [SAFETY_JOB_DEFERRALS_KEY]: error.deferrals + 1,
    });
    await job.moveToDelayed(Date.now() + error.delayMs, token);
    return new DelayedError();
  } catch {
    return error;
  }
}
