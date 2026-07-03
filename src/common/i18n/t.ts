import { I18nContext } from 'nestjs-i18n';

/**
 * Helper pra traduzir chaves de erros a partir do contexto da request.
 * Se não houver contexto (fora de request — ex: cron, webhook), cai no fallback `pt-BR`.
 */
export function t(key: string, args?: Record<string, unknown>): string {
  const ctx = I18nContext.current();
  if (!ctx) {
    return key;
  }
  return ctx.t(key, { args });
}
