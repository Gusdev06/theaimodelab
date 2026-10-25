/**
 * Marca do e-mail. A mesma API atende dois sites: The AI Model Lab (padrão) e a Funvmake, que é uma pele
 * própria sobre a mesma conta e o mesmo banco. Sem isto, quem se cadastrou na Funvmake recebia e-mails "The AI
 * Model Lab" com links para theaimodelab.com e achava que tinha sido levado para outro site.
 *
 * Como a marca é decidida:
 *  - pedido que vem do navegador: pelo `Origin` (ou `Referer`) do site que chamou a API;
 *  - pedido servidor a servidor (login com Google feito pelo servidor do site): cabeçalho `x-brand`;
 *  - e-mails sem pedido (cron, webhook de pagamento): pela marca gravada na conta (`users.signup_brand`).
 *
 * Tudo é opcional: sem `FUNVMAKE_FRONTEND_URL` no ambiente a Funvmake não existe para a API e todo e-mail
 * continua exatamente como antes.
 */

export type BrandKey = 'taml' | 'funvmake';

export const BRAND_KEYS: readonly BrandKey[] = ['taml', 'funvmake'];

/** Nome da marca de origem, como aparece hoje nos assuntos e modelos de e-mail. */
export const ORIGIN_BRAND_NAME = 'The AI Model Lab';

export interface Brand {
  key: BrandKey;
  name: string;
  /** Site da marca, sem barra no fim (links de login, senha, painel). */
  frontendUrl: string;
  /** Logo do e-mail; vazio = usa o da origem. */
  logoUrl: string;
  /** Remetente; vazio = o da origem com o nome da marca. */
  emailFrom: string;
}

export type EnvReader = (key: string) => string | undefined;

const processEnv: EnvReader = (key) => process.env[key];

function firstUrl(value: string | undefined): string {
  return (value ?? '').split(',')[0]?.trim().replace(/\/+$/, '') ?? '';
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Hosts que contam como Funvmake: `FUNVMAKE_HOSTS` (vírgula) + o host de `FUNVMAKE_FRONTEND_URL` e o do www. */
export function funvmakeHosts(env: EnvReader = processEnv): Set<string> {
  const frontend = firstUrl(env('FUNVMAKE_FRONTEND_URL'));
  if (!frontend) return new Set();
  const hosts = new Set<string>();
  const main = hostOf(frontend);
  if (main) {
    hosts.add(main);
    hosts.add(main.startsWith('www.') ? main.slice(4) : `www.${main}`);
  }
  for (const extra of (env('FUNVMAKE_HOSTS') ?? '').split(',')) {
    const host = extra.trim().toLowerCase();
    if (host) hosts.add(host);
  }
  return hosts;
}

export function isBrandKey(value: unknown): value is BrandKey {
  return typeof value === 'string' && (BRAND_KEYS as readonly string[]).includes(value);
}

function headerValue(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  const raw = headers?.[name];
  if (Array.isArray(raw)) return typeof raw[0] === 'string' ? raw[0] : undefined;
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * Marca de um pedido HTTP. Devolve só `funvmake` (quando reconhecida) ou `null`: a origem é o padrão e não
 * precisa ser gravada. `x-brand` só vale para os nomes conhecidos.
 */
export function detectBrandFromHeaders(
  headers: Record<string, unknown> | undefined,
  env: EnvReader = processEnv,
): BrandKey | null {
  const hosts = funvmakeHosts(env);
  if (hosts.size === 0) return null;
  const explicit = headerValue(headers, 'x-brand')?.trim().toLowerCase();
  if (explicit === 'funvmake') return 'funvmake';
  for (const name of ['origin', 'referer']) {
    const value = headerValue(headers, name);
    const host = value ? hostOf(value) : null;
    if (host && hosts.has(host)) return 'funvmake';
  }
  return null;
}

/** Marca completa para montar o e-mail. Chave desconhecida, vazia ou Funvmake desligada = origem. */
export function resolveBrand(key: string | null | undefined, env: EnvReader = processEnv): Brand {
  const origin: Brand = {
    key: 'taml',
    name: ORIGIN_BRAND_NAME,
    frontendUrl: firstUrl(env('FRONTEND_URL')),
    logoUrl: env('LOGO_URL') ?? '',
    emailFrom: env('RESEND_FROM_EMAIL') ?? '',
  };
  const funvmakeUrl = firstUrl(env('FUNVMAKE_FRONTEND_URL'));
  if (key !== 'funvmake' || !funvmakeUrl) return origin;
  return {
    key: 'funvmake',
    name: env('FUNVMAKE_BRAND_NAME')?.trim() || 'Funvmake',
    frontendUrl: funvmakeUrl,
    logoUrl: env('FUNVMAKE_LOGO_URL')?.trim() || '',
    emailFrom: env('FUNVMAKE_EMAIL_FROM')?.trim() || '',
  };
}

/** Marca de um e-mail disparado por pedido: a do site que pediu vence a gravada na conta. */
export function brandKeyFor(requestBrand: BrandKey | null | undefined, storedBrand: string | null | undefined): BrandKey {
  if (requestBrand) return requestBrand;
  return isBrandKey(storedBrand) ? storedBrand : 'taml';
}

/**
 * Remetente da marca: o próprio dela, senão o da origem com o nome da marca no lugar
 * ("The AI Model Lab <noreply@…>" → "Funvmake <noreply@…>").
 */
export function brandedFrom(originFrom: string, brand: Brand): string {
  if (brand.key === 'taml') return originFrom;
  if (brand.emailFrom) return brand.emailFrom;
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(originFrom);
  const address = match ? match[2] : originFrom.trim();
  return address ? `${brand.name} <${address}>` : originFrom;
}

export interface BrandableMessage {
  subject: string;
  html: string;
}

/**
 * Troca nome, site e logo da origem pelos da marca num e-mail já montado. Na origem não mexe em nada.
 * `origin` são os valores que o modelo usou (o `FRONTEND_URL` e o `LOGO_URL` do serviço de e-mail).
 */
export function applyBrand<T extends BrandableMessage>(
  message: T,
  brand: Brand,
  origin: { frontendUrl: string; logoUrl: string },
): T {
  if (brand.key === 'taml') return message;
  const swap = (text: string): string => {
    let out = text.split(ORIGIN_BRAND_NAME).join(brand.name);
    const from = origin.frontendUrl.replace(/\/+$/, '');
    if (from && brand.frontendUrl) out = out.split(from).join(brand.frontendUrl);
    if (origin.logoUrl && brand.logoUrl) out = out.split(origin.logoUrl).join(brand.logoUrl);
    return out;
  };
  return { ...message, subject: swap(message.subject), html: swap(message.html) };
}
