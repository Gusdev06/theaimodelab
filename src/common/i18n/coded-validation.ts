import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ValidationError, ValidationOptions } from 'class-validator';
import { t } from './t';

/**
 * Validação com código estável + texto no idioma da cliente.
 *
 * Antes o cadastro devolvia "Senha deve conter pelo menos uma letra maiúscula..." em português para toda cliente
 * (EN/ES inclusive). Agora a regra do DTO usa `coded('PASSWORD_WEAK')`: a mensagem sai de
 * src/i18n/<idioma>/errors.json (chave `validation.<CODE>`) e a resposta 400 ganha o campo `code`.
 *
 * O formato antigo continua igual ({ statusCode, message: string[], error }), só com `code` a mais: quem lê
 * `message` não quebra. Erro sem código (DTO que não usa `coded`) sai exatamente como antes.
 */
export function coded(code: string, options: ValidationOptions = {}): ValidationOptions {
  return {
    ...options,
    message: () => t(`errors.validation.${code}`),
    context: { ...(options.context ?? {}), code },
  };
}

/** Código do 1º erro, o mesmo que vira `message[0]` (mesma ordem do achatamento do ValidationPipe). */
export function firstValidationCode(errors: ValidationError[]): string | undefined {
  for (const error of errors) {
    const constraintKeys = Object.keys(error.constraints ?? {});
    if (constraintKeys.length > 0) {
      const context = error.contexts?.[constraintKeys[0]] as { code?: unknown } | undefined;
      return typeof context?.code === 'string' ? context.code : undefined;
    }
    if (error.children?.length) {
      const nested = firstValidationCode(error.children);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

export class CodedValidationPipe extends ValidationPipe {
  createExceptionFactory() {
    return (validationErrors: ValidationError[] = []) => {
      const messages = this.flattenValidationErrors(validationErrors);
      const code = firstValidationCode(validationErrors);
      if (!code) return new BadRequestException(messages);
      return new BadRequestException({ statusCode: 400, message: messages, error: 'Bad Request', code });
    };
  }
}
