import { HttpStatus } from '@nestjs/common';

export const ErrorCodes = {
  INSUFFICIENT_CREDITS: {
    code: 'INSUFFICIENT_CREDITS',
    statusCode: HttpStatus.PAYMENT_REQUIRED,
    message: 'Créditos insuficientes',
  },
  MAX_CONCURRENT_REACHED: {
    code: 'MAX_CONCURRENT_REACHED',
    statusCode: HttpStatus.TOO_MANY_REQUESTS,
    message: 'Limite de gerações simultâneas atingido',
  },
  INVALID_FILE_TYPE: {
    code: 'INVALID_FILE_TYPE',
    statusCode: HttpStatus.BAD_REQUEST,
    message: 'Tipo de arquivo não suportado',
  },
  FILE_TOO_LARGE: {
    code: 'FILE_TOO_LARGE',
    statusCode: HttpStatus.BAD_REQUEST,
    message: 'Arquivo excede tamanho máximo',
  },
  GENERATION_FAILED: {
    code: 'GENERATION_FAILED',
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    message: 'Erro na geração',
  },
  GENERATION_TIMEOUT: {
    code: 'GENERATION_TIMEOUT',
    statusCode: HttpStatus.GATEWAY_TIMEOUT,
    message: 'Timeout na geração',
  },
  PLAN_UPGRADE_REQUIRED: {
    code: 'PLAN_UPGRADE_REQUIRED',
    statusCode: HttpStatus.FORBIDDEN,
    message: 'Feature não disponível no plano atual',
  },
  SUBSCRIPTION_PAST_DUE: {
    code: 'SUBSCRIPTION_PAST_DUE',
    statusCode: HttpStatus.PAYMENT_REQUIRED,
    message: 'Pagamento pendente',
  },
  NSFW_CONTENT_DETECTED: {
    code: 'NSFW_CONTENT_DETECTED',
    statusCode: HttpStatus.BAD_REQUEST,
    message: 'Conteúdo NSFW detectado no prompt',
  },
  PROMPT_TOO_LONG: {
    code: 'PROMPT_TOO_LONG',
    statusCode: HttpStatus.BAD_REQUEST,
    message: 'Prompt excede limite de caracteres',
  },
} as const;

export type ErrorCode = keyof typeof ErrorCodes;
