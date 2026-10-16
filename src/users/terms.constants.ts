/**
 * Versão vigente do termo de aceite mostrado no app (18+, responsabilidade pelo
 * conteúdo, acesso da plataforma a tudo que é gerado, uso aceitável).
 *
 * O usuário vê o termo UMA vez por versão: aceitou nesta versão, não vê mais.
 * Mudar o texto do termo = acrescentar a data nova em TERMS_VERSIONS e trocar
 * esta constante, e todo mundo aceita de novo no próximo acesso. Espelhada em
 * `web/lib/terms.ts` — mudou aqui, muda lá.
 */
export const CURRENT_TERMS_VERSION = '2026-10-15';

/** Todas as versões já publicadas, da mais antiga para a mais nova (AAAA-MM-DD: compara como texto). */
export const TERMS_VERSIONS: readonly string[] = ['2026-09-03', CURRENT_TERMS_VERSION];

/** Versão que o app antigo mostrava. Ele não manda a versão no aceite. */
export const LEGACY_TERMS_VERSION = '2026-09-03';

/**
 * Versão que fica gravada no aceite: a que o app MOSTROU. Sem versão no corpo = app antigo (termo de
 * 2026-09-03). Versão desconhecida (site mais novo que a API) = a mais nova que a API conhece.
 * Assim API e site podem ir ao ar em qualquer ordem sem prender ninguém num loop de aceite.
 */
export function resolveShownTermsVersion(shown?: string | null): string {
  if (!shown) return LEGACY_TERMS_VERSION;
  return TERMS_VERSIONS.includes(shown) ? shown : CURRENT_TERMS_VERSION;
}
