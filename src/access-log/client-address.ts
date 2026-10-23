import { BlockList, isIP } from 'net';

/**
 * Endereço do cliente para o registro de acesso (Marco Civil, art. 15). Regra única, usada pelo interceptor e pelo
 * `trust proxy` do Express (main.ts):
 *  - o IP do socket é a verdade, salvo quando quem conectou é um proxy declarado no env;
 *  - só então o x-forwarded-for é lido, da direita para a esquerda, saltando os proxies confiáveis (a mesma regra do
 *    proxy-addr do Express): a entrada mais à direita foi escrita pelo proxy que está na frente, as da esquerda podem
 *    ter vindo do próprio cliente;
 *  - x-real-ip só vale quando o proxy confiável não mandou x-forwarded-for;
 *  - a porta de origem só é conhecida quando o cliente conectou direto (socket) ou no proxy que está na frente da API
 *    (1 salto, cabeçalho próprio dele); com mais saltos (rewrite da Vercel + proxy do VPS) ela não chega e fica nula.
 */

/** Diz se o endereço, no salto `hop` (0 = socket), é um proxy confiável. Mesma assinatura do `trust proxy` do Express. */
export type ProxyTrust = (address: string, hop: number) => boolean;

/** Sem proxy declarado: nenhum cabeçalho é lido, o cliente é o socket. */
export const TRUST_NO_PROXY: ProxyTrust = () => false;

/** Teto de entradas lidas do x-forwarded-for (as mais próximas): cabeçalho gigante não vira trabalho gigante. */
export const MAX_FORWARDED_ENTRIES = 20;

const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;
const BRACKETED_IPV6 = /^\[([^\]]+)\](?::\d{1,5})?$/;
const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;
const PORT_TEXT = /^\d{1,5}$/;

/**
 * IP normalizado ou null quando não é IP: IPv4 sem o prefixo `::ffff:`, IPv6 em minúsculas e sem a zona, sem porta e
 * sem colchetes (há proxy que escreve "203.0.113.7:51234" ou "[2001:db8::1]:443" no x-forwarded-for).
 */
export function normalizeIp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().replace(/^"|"$/g, '');
  if (!value || value.length > 64) return null;
  const bracketed = BRACKETED_IPV6.exec(value);
  if (bracketed) value = bracketed[1];
  const withPort = IPV4_WITH_PORT.exec(value);
  if (withPort) value = withPort[1];
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  value = value.toLowerCase();
  const mapped = IPV4_MAPPED.exec(value);
  if (mapped) value = mapped[1];
  return isIP(value) ? value : null;
}

/** Porta TCP válida (1 a 65535) ou null. Aceita número ou texto só com dígitos. */
export function validPort(raw: unknown): number | null {
  let value: number;
  if (typeof raw === 'number') value = raw;
  else if (typeof raw === 'string' && PORT_TEXT.test(raw.trim()))
    value = Number(raw.trim());
  else return null;
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

function firstValue(
  raw: string | string[] | null | undefined,
): string | undefined {
  return Array.isArray(raw) ? raw[0] : (raw ?? undefined);
}

/** Entradas do x-forwarded-for, da mais próxima (direita) para a mais distante; várias linhas do cabeçalho se somam. */
export function forwardedChain(
  raw: string | string[] | null | undefined,
): string[] {
  const joined = Array.isArray(raw) ? raw.join(',') : (raw ?? '');
  if (typeof joined !== 'string' || !joined) return [];
  const entries = joined
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.slice(-MAX_FORWARDED_ENTRIES).reverse();
}

/* ------------------------------------------------------------------ lista de proxies */

type IpFamily = 'ipv4' | 'ipv6';

/** Nomes aceitos na lista, com as mesmas faixas do `trust proxy` do Express. */
export const TRUSTED_PROXY_NAMES: Readonly<
  Record<string, ReadonlyArray<readonly [string, number, IpFamily]>>
> = {
  loopback: [
    ['127.0.0.0', 8, 'ipv4'],
    ['::1', 128, 'ipv6'],
  ],
  linklocal: [
    ['169.254.0.0', 16, 'ipv4'],
    ['fe80::', 10, 'ipv6'],
  ],
  uniquelocal: [
    ['10.0.0.0', 8, 'ipv4'],
    ['172.16.0.0', 12, 'ipv4'],
    ['192.168.0.0', 16, 'ipv4'],
    ['fc00::', 7, 'ipv6'],
  ],
};

function familyOf(ip: string): IpFamily {
  return isIP(ip) === 6 ? 'ipv6' : 'ipv4';
}

export interface ParsedProxyList {
  list: BlockList;
  /** entradas aceitas, na forma em que vão para o log do boot */
  entries: string[];
}

/**
 * Lista de proxies confiáveis: nomes (loopback, linklocal, uniquelocal), IPs e faixas CIDR separados por vírgula.
 * Entrada inválida é ignorada com aviso; faixa /0 é recusada (confiar na internet inteira anula a regra).
 */
export function parseTrustedProxyList(
  raw: string,
  warnings: string[],
): ParsedProxyList | null {
  const list = new BlockList();
  const entries: string[] = [];
  for (const item of raw.split(',')) {
    const entry = item.trim().toLowerCase();
    if (!entry) continue;
    const named = Object.prototype.hasOwnProperty.call(
      TRUSTED_PROXY_NAMES,
      entry,
    )
      ? TRUSTED_PROXY_NAMES[entry]
      : undefined;
    if (named) {
      for (const [network, prefix, family] of named)
        list.addSubnet(network, prefix, family);
      entries.push(entry);
      continue;
    }
    const [address, prefixText, extra] = entry.split('/');
    const ip = normalizeIp(address);
    if (!ip || extra !== undefined) {
      warnings.push(
        `TRUSTED_PROXY_IPS: "${entry}" não é IP, faixa CIDR nem nome conhecido; ignorado`,
      );
      continue;
    }
    const family = familyOf(ip);
    if (prefixText === undefined) {
      list.addAddress(ip, family);
      entries.push(ip);
      continue;
    }
    const maxPrefix = family === 'ipv6' ? 128 : 32;
    const prefix = /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : NaN;
    if (!Number.isInteger(prefix) || prefix < 1 || prefix > maxPrefix) {
      warnings.push(
        `TRUSTED_PROXY_IPS: faixa "${entry}" inválida (prefixo de 1 a ${maxPrefix}; /0 confiaria em qualquer um); ignorada`,
      );
      continue;
    }
    list.addSubnet(ip, prefix, family);
    entries.push(`${ip}/${prefix}`);
  }
  return entries.length ? { list, entries } : null;
}

/**
 * Confiança nos proxies: limite de saltos (TRUSTED_PROXY_HOPS), lista (TRUSTED_PROXY_IPS) ou os dois (cada salto
 * precisa estar na lista E dentro do limite). Sem nenhum: ninguém é proxy.
 */
export function buildProxyTrust(
  hops: number | null,
  proxies: ParsedProxyList | null,
): ProxyTrust {
  if (hops === 0) return TRUST_NO_PROXY;
  if (hops === null && !proxies) return TRUST_NO_PROXY;
  return (address, hop) => {
    if (!Number.isInteger(hop) || hop < 0) return false;
    if (hops !== null && hop >= hops) return false;
    if (!proxies) return true;
    const ip = normalizeIp(address);
    return ip !== null && proxies.list.check(ip, familyOf(ip));
  };
}

/* ------------------------------------------------------------------ resolução */

export interface ClientAddressInput {
  remoteAddress?: string | null;
  remotePort?: number | null;
  forwardedFor?: string | string[] | null;
  realIp?: string | string[] | null;
  /** valor do cabeçalho de porta de origem escrito pelo proxy da frente (ACCESS_LOG_PORT_HEADER) */
  sourcePort?: string | string[] | null;
}

export type ClientAddressSource = 'socket' | 'x-forwarded-for' | 'x-real-ip';

export interface ClientAddress {
  /** null quando o socket não informa ou o proxy confiável mandou lixo no lugar do IP */
  ip: string | null;
  port: number | null;
  /** proxies confiáveis entre o cliente e a API (0 = o cliente é o socket) */
  hops: number;
  source: ClientAddressSource;
}

/** Endereço do cliente pela regra do topo do arquivo. Nunca lança. */
export function resolveClientAddress(
  input: ClientAddressInput,
  trust: ProxyTrust,
): ClientAddress {
  const socketIp = normalizeIp(input.remoteAddress);
  const socket: ClientAddress = {
    ip: socketIp,
    port: validPort(input.remotePort),
    hops: 0,
    source: 'socket',
  };
  if (!socketIp || !safeTrust(trust, socketIp, 0)) return socket;

  const chain = forwardedChain(input.forwardedFor);
  if (chain.length === 0) {
    // o proxy da frente não mandou x-forwarded-for: o x-real-ip escrito por ele é o cliente
    const realIp = normalizeIp(firstValue(input.realIp));
    if (!realIp) return socket;
    return {
      ip: realIp,
      port: validPort(firstValue(input.sourcePort)),
      hops: 1,
      source: 'x-real-ip',
    };
  }

  for (let index = 0; index < chain.length; index++) {
    const hop = index + 1;
    const ip = normalizeIp(chain[index]);
    // lixo escrito por um proxy confiável: o cliente é desconhecido (gravar o IP do proxy seria apontar outra pessoa)
    if (!ip)
      return { ip: null, port: null, hops: hop, source: 'x-forwarded-for' };
    const last = hop === chain.length;
    if (last || !safeTrust(trust, ip, hop)) {
      return {
        ip,
        // só o proxy que viu o cliente sabe a porta dele; com mais saltos, a porta gravada seria a de outro proxy
        port: hop === 1 ? validPort(firstValue(input.sourcePort)) : null,
        hops: hop,
        source: 'x-forwarded-for',
      };
    }
  }
  return socket;
}

function safeTrust(trust: ProxyTrust, address: string, hop: number): boolean {
  try {
    return trust(address, hop) === true;
  } catch {
    return false;
  }
}
