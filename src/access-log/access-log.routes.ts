/**
 * Rotas gravadas no registro de acesso (Marco Civil, art. 15; camada 8 da trava): entrada na conta (senha, cadastro,
 * Google e renovação da sessão) e pedido de geração (o que liga o IP ao conteúdo numa comunicação à autoridade). A
 * tabela fica aqui, e não em decorador nos controllers, para rota nova de geração entrar sem depender de lembrar de
 * decorar o handler (o mesmo motivo do ContentSafetyInterceptor).
 */

export type AccessKind =
  | 'login'
  | 'register'
  | 'google'
  | 'refresh'
  | 'generation';

/**
 * De onde sai o id da geração criada:
 * - id: as rotas de /generations respondem { id }
 * - generationId: avatar falante ({ generationId })
 * - generationIds: agente ({ generationIds: [] }, uma linha por geração)
 * - none: a resposta não tem geração (o id dela é de outra coisa, como o avatar)
 */
export type GenerationIdSource =
  | 'id'
  | 'generationId'
  | 'generationIds'
  | 'none';

export interface AccessRoute {
  method: 'GET' | 'POST';
  /** casa com o caminho declarado (`:id` no lugar do id) ou com a URL normalizada */
  pattern: RegExp;
  kind: AccessKind;
  generationIds: GenerationIdSource;
}

export const ACCESS_LOG_ROUTES: readonly AccessRoute[] = [
  {
    method: 'POST',
    pattern: /^\/api\/v1\/auth\/login$/,
    kind: 'login',
    generationIds: 'none',
  },
  // o cadastro já devolve a sessão: é a 1ª entrada na conta (e o IP de criação é o mais pedido numa investigação)
  {
    method: 'POST',
    pattern: /^\/api\/v1\/auth\/register$/,
    kind: 'register',
    generationIds: 'none',
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/auth\/google$/,
    kind: 'google',
    generationIds: 'none',
  },
  {
    method: 'GET',
    pattern: /^\/api\/v1\/auth\/google\/callback$/,
    kind: 'google',
    generationIds: 'none',
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/auth\/refresh$/,
    kind: 'refresh',
    generationIds: 'none',
  },
  // todo POST de um trecho só em /generations cria geração (imagem, vídeo, áudio, voz); `:id/favorite` tem dois
  {
    method: 'POST',
    pattern: /^\/api\/v1\/generations\/[a-z0-9-]+$/,
    kind: 'generation',
    generationIds: 'id',
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/avatars\/[^/]+\/generate-video$/,
    kind: 'generation',
    generationIds: 'generationId',
  },
  // criação do avatar falante: envia a foto ou o vídeo da pessoa à HeyGen (a resposta é o avatar, sem geração)
  {
    method: 'POST',
    pattern: /^\/api\/v1\/avatars$/,
    kind: 'generation',
    generationIds: 'none',
  },
  {
    method: 'POST',
    pattern: /^\/api\/v1\/agent\/chat$/,
    kind: 'generation',
    generationIds: 'generationIds',
  },
];

/** Teto de gerações ligadas a um pedido (o agente cria poucas por mensagem). */
export const MAX_GENERATIONS_PER_ACCESS = 20;

const ID_FORMAT = /^[A-Za-z0-9_-]{1,64}$/;
const AUTH_KINDS: ReadonlySet<AccessKind> = new Set([
  'login',
  'register',
  'google',
  'refresh',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Id de conta ou de geração no formato do banco (cuid); qualquer outra coisa vira null. */
export function safeId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return ID_FORMAT.test(id) ? id : null;
}

/** Rota gravada para o método e o caminho (já normalizado), ou null quando o pedido não entra no registro. */
export function matchAccessRoute(
  method: string,
  path: string,
): AccessRoute | null {
  const verb = method.toUpperCase();
  for (const route of ACCESS_LOG_ROUTES) {
    if (route.method === verb && route.pattern.test(path)) return route;
  }
  return null;
}

/**
 * Conta do acesso. Entrada na conta: só a resposta de sucesso diz quem entrou (`user.id`); o `req.user` do callback do
 * Google é o perfil do Google, não a conta. Geração: a conta do token (o JwtAuthGuard roda antes).
 */
export function accountIdOf(
  route: AccessRoute,
  requestUser: unknown,
  response: unknown,
  succeeded: boolean,
): string | null {
  if (AUTH_KINDS.has(route.kind)) {
    if (!succeeded || !isRecord(response) || !isRecord(response.user))
      return null;
    return safeId(response.user.id);
  }
  return isRecord(requestUser) ? safeId(requestUser.sub) : null;
}

/** Gerações criadas pelo pedido, conforme a rota (sem repetição, no máximo MAX_GENERATIONS_PER_ACCESS). */
export function generationIdsOf(
  route: AccessRoute,
  response: unknown,
): string[] {
  if (route.generationIds === 'none' || !isRecord(response)) return [];
  const raw =
    route.generationIds === 'generationIds'
      ? Array.isArray(response.generationIds)
        ? response.generationIds
        : []
      : [response[route.generationIds]];
  const ids = new Set<string>();
  for (const value of raw) {
    const id = safeId(value);
    if (id) ids.add(id);
    if (ids.size >= MAX_GENERATIONS_PER_ACCESS) break;
  }
  return [...ids];
}
