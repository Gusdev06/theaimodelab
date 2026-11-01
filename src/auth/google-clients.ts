/**
 * Clientes Google aceitos no login por token (POST /api/v1/auth/google): o desta API (GOOGLE_CLIENT_ID) mais os de
 * GOOGLE_EXTRA_CLIENT_IDS, separados por vírgula. Exemplo: o site da Funvmake, que usa esta API com o próprio cliente
 * Google. Sem nenhum configurado devolve undefined, que mantém o comportamento antigo do verifyIdToken.
 */
export function googleAudiences(primary: string | undefined | null, extra: string | undefined | null): string[] | undefined {
  const ids = [primary, ...String(extra ?? '').split(',')]
    .map((id) => (id ?? '').trim())
    .filter(Boolean);
  const unique = [...new Set(ids)];
  return unique.length ? unique : undefined;
}

/**
 * O token de acesso foi emitido para um dos clientes aceitos? Lê o tokeninfo do Google (aud/azp). Sem lista de
 * clientes não dá para conferir, e a checagem não bloqueia.
 */
export function accessTokenAllowed(
  tokenInfo: { aud?: unknown; azp?: unknown } | null | undefined,
  audiences: string[] | undefined,
): boolean {
  if (!audiences?.length) return true;
  if (!tokenInfo) return false;
  return [tokenInfo.aud, tokenInfo.azp].some((value) => typeof value === 'string' && audiences.includes(value));
}
