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
  // Segurança de conteúdo (15/10/2026): a plataforma recusa antes de qualquer provedor de IA
  CONTENT_POLICY_MINOR: {
    code: 'CONTENT_POLICY_MINOR',
    statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    message:
      'Este pedido faz referência a menor de idade e foi recusado. A The AI Model Lab é exclusivamente para conteúdo com adultos (18+).',
  },
  CONSENT_REQUIRED: {
    code: 'CONSENT_REQUIRED',
    statusCode: HttpStatus.BAD_REQUEST,
    message:
      'Confirme que a foto é de uma pessoa gerada por IA ou de um adulto que autorizou o uso da própria imagem.',
  },
  REQUEST_TOO_LARGE: {
    code: 'REQUEST_TOO_LARGE',
    statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
    message: 'O pedido tem texto demais. Encurte o prompt e tente de novo.',
  },
  // alfabeto que a trava de menor ainda não lê: recusado sem leitura (não é registrado como tentativa com menor)
  CONTENT_POLICY_LANGUAGE: {
    code: 'CONTENT_POLICY_LANGUAGE',
    statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'Ainda não conseguimos conferir pedidos neste alfabeto. Escreva em português, inglês ou espanhol.',
  },
} as const;

export type ErrorCode = keyof typeof ErrorCodes;
