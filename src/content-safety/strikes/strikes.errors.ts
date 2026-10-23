import { PlatformSafetyBlockError } from '../../generations/errors/content-safety.error';
import {
  ACCOUNT_SUSPENDED_RULE,
  PHOTO_RETRY_LIMIT_RULE,
} from './strikes.types';

/**
 * Erros da camada 6. Estendem PlatformSafetyBlockError de propósito: o processor já os trata como bloqueio terminal
 * (sem nova tentativa, sem desvio), com estorno e o código público genérico IMAGE_SAFETY_BLOCKED. A cliente nunca
 * sabe se foi a suspensão, o limite de tentativas ou uma regra de imagem.
 */

/**
 * A conta foi suspensa: nenhum job dela vai mais ao provedor. As entradas ficam (evidencePending): a conta está em
 * revisão de segurança e as fotos que esperavam na fila nunca foram checadas.
 */
export class AccountSuspendedSafetyError extends PlatformSafetyBlockError {
  constructor() {
    super('input', ACCOUNT_SUSPENDED_RULE, 'NONE', { evidencePending: true });
    this.name = 'AccountSuspendedSafetyError';
  }
}

/**
 * Nova tentativa com foto acima do limite depois de um bloqueio de foto (1 a cada 10 min, 5 em 24 h): recusada sem
 * checar (nem a AWS é chamada). A foto não foi lida, então segue a limpeza comum das entradas.
 */
export class PhotoRetryLimitError extends PlatformSafetyBlockError {
  constructor() {
    super('input', PHOTO_RETRY_LIMIT_RULE, 'NONE');
    this.name = 'PhotoRetryLimitError';
  }
}
