import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildProxyTrust,
  parseTrustedProxyList,
  resolveClientAddress,
  TRUST_NO_PROXY,
  type ParsedProxyList,
  type ProxyTrust,
} from './client-address';

/**
 * Configuração do registro de acesso (Marco Civil, art. 15). Vale em qualquer modo de segurança de imagem: é
 * obrigação legal, não regra de produto.
 *
 * - TRUSTED_PROXY_HOPS: quantos proxies, a partir do socket, escrevem o x-forwarded-for (ex.: 2 = proxy do VPS +
 *   rewrite da Vercel). Confia em quem estiver nesses saltos: só serve se a porta da API não estiver aberta para a
 *   internet sem passar por eles.
 * - TRUSTED_PROXY_IPS: lista de IPs, faixas CIDR ou nomes (loopback, linklocal, uniquelocal) dos proxies. Com os dois,
 *   cada salto precisa estar na lista e dentro do limite.
 * - Sem nenhum dos dois: nenhum cabeçalho é lido e o IP gravado é o do socket (o do proxy, quando houver um).
 * - ACCESS_LOG_PORT_HEADER: cabeçalho em que o proxy da frente escreve a porta de ORIGEM do cliente (no nginx,
 *   `proxy_set_header X-Real-Port $remote_port;`). Padrão x-real-port.
 * - ACCESS_LOG_RETENTION_MONTHS: guarda em meses (mínimo e padrão 6; a autoridade pode pedir mais).
 */

/** Lê uma variável de ambiente (ConfigService.get ou process.env). */
export type AccessLogEnvSource = (key: string) => string | undefined;

export const DEFAULT_SOURCE_PORT_HEADER = 'x-real-port';
export const MIN_RETENTION_MONTHS = 6;
export const MAX_RETENTION_MONTHS = 60;
export const MAX_TRUSTED_PROXY_HOPS = 10;

const HEADER_NAME = /^[a-z0-9-]{1,64}$/;
/** Por convenção é a porta de DESTINO (443) no proxy, não a do cliente: só vale se o proxy gravar $remote_port nele. */
const DESTINATION_PORT_HEADER = 'x-forwarded-port';

export interface AccessLogConfig {
  /** mesma função vai para o `trust proxy` do Express (main.ts) */
  trust: ProxyTrust;
  /** algum proxy foi declarado (sem isso, o main.ts não mexe no Express) */
  trustConfigured: boolean;
  sourcePortHeader: string;
  retentionMonths: number;
  /** resumo para o log do boot, sem dado de cliente */
  summary: string;
}

export interface LoadedAccessLogConfig {
  config: AccessLogConfig;
  /** um aviso por valor recusado; nunca contém segredo */
  warnings: string[];
}

function text(env: AccessLogEnvSource, key: string): string {
  const value = env(key);
  return typeof value === 'string' ? value.trim() : '';
}

function readHops(env: AccessLogEnvSource, warnings: string[]): number | null {
  const raw = text(env, 'TRUSTED_PROXY_HOPS');
  if (!raw) return null;
  const value = /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value > MAX_TRUSTED_PROXY_HOPS) {
    warnings.push(
      `TRUSTED_PROXY_HOPS inválido (inteiro de 0 a ${MAX_TRUSTED_PROXY_HOPS}); nenhum proxy será confiado por saltos`,
    );
    return null;
  }
  return value;
}

function readProxyList(
  env: AccessLogEnvSource,
  warnings: string[],
): ParsedProxyList | null {
  const raw = text(env, 'TRUSTED_PROXY_IPS');
  if (!raw) return null;
  const parsed = parseTrustedProxyList(raw, warnings);
  if (!parsed)
    warnings.push(
      'TRUSTED_PROXY_IPS sem nenhuma entrada válida; nenhum proxy será confiado pela lista',
    );
  return parsed;
}

function readPortHeader(env: AccessLogEnvSource, warnings: string[]): string {
  const raw = text(env, 'ACCESS_LOG_PORT_HEADER').toLowerCase();
  if (!raw) return DEFAULT_SOURCE_PORT_HEADER;
  if (!HEADER_NAME.test(raw)) {
    warnings.push(
      `ACCESS_LOG_PORT_HEADER inválido (letras, números e hífen); usando ${DEFAULT_SOURCE_PORT_HEADER}`,
    );
    return DEFAULT_SOURCE_PORT_HEADER;
  }
  if (raw === DESTINATION_PORT_HEADER)
    warnings.push(
      'ACCESS_LOG_PORT_HEADER=x-forwarded-port: por convenção esse cabeçalho é a porta de destino (443), não a do ' +
        'cliente; confira se o proxy grava $remote_port nele',
    );
  return raw;
}

function readRetentionMonths(
  env: AccessLogEnvSource,
  warnings: string[],
): number {
  const raw = text(env, 'ACCESS_LOG_RETENTION_MONTHS');
  if (!raw) return MIN_RETENTION_MONTHS;
  const value = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  if (
    !Number.isInteger(value) ||
    value < MIN_RETENTION_MONTHS ||
    value > MAX_RETENTION_MONTHS
  ) {
    warnings.push(
      `ACCESS_LOG_RETENTION_MONTHS inválido (inteiro de ${MIN_RETENTION_MONTHS} a ${MAX_RETENTION_MONTHS}; ` +
        `abaixo de ${MIN_RETENTION_MONTHS} descumpre o Marco Civil); usando ${MIN_RETENTION_MONTHS}`,
    );
    return MIN_RETENTION_MONTHS;
  }
  return value;
}

export function loadAccessLogConfig(
  env: AccessLogEnvSource,
): LoadedAccessLogConfig {
  const warnings: string[] = [];
  const hops = readHops(env, warnings);
  const proxies = readProxyList(env, warnings);
  const trust = buildProxyTrust(hops, proxies);
  const trustConfigured = trust !== TRUST_NO_PROXY;
  const sourcePortHeader = readPortHeader(env, warnings);
  const retentionMonths = readRetentionMonths(env, warnings);

  const proxyParts: string[] = [];
  if (trustConfigured && hops !== null) proxyParts.push(`saltos=${hops}`);
  if (trustConfigured && proxies)
    proxyParts.push(`lista=${proxies.entries.join(',')}`);
  const summary =
    `registro de acesso: proxies=${proxyParts.length ? proxyParts.join(' ') : 'nenhum (IP do socket)'} ` +
    `porta=${sourcePortHeader} guarda=${retentionMonths} meses`;

  return {
    config: {
      trust,
      trustConfigured,
      sourcePortHeader,
      retentionMonths,
      summary,
    },
    warnings,
  };
}

/**
 * `trust proxy` do Express com a mesma regra do interceptor (chamado no main.ts). O req.ip, que o throttler usa, passa
 * a ser o cliente real só quando há proxy declarado; sem proxy, não mexe no Express e devolve false.
 */
export function configureTrustProxy(
  app: { set(setting: string, value: unknown): unknown },
  env: AccessLogEnvSource,
): boolean {
  const { config } = loadAccessLogConfig(env);
  if (!config.trustConfigured) return false;
  app.set('trust proxy', config.trust);
  return true;
}

/** O que o IP de auditoria lê da requisição. */
export interface AuditRequest {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null } | null;
}

let processEnvTrust: Pick<AccessLogConfig, 'trust' | 'trustConfigured'> | null =
  null;

/** Confiança nos proxies lida do ambiente uma vez, a mesma do main.ts (configureTrustProxy). */
function trustFromProcessEnv(): Pick<
  AccessLogConfig,
  'trust' | 'trustConfigured'
> {
  if (!processEnvTrust) {
    const { config } = loadAccessLogConfig((key) => process.env[key]);
    processEnvTrust = {
      trust: config.trust,
      trustConfigured: config.trustConfigured,
    };
  }
  return processEnvTrust;
}

/**
 * IP de quem age numa rota de auditoria (revisor, liberação, remoção, andamento de denúncia), para a trilha
 * content_safety_access_log. Com proxy declarado (TRUSTED_PROXY_HOPS/IPS), a regra é a do registro de acesso: o
 * x-forwarded-for só vale nos saltos confiáveis e quem chama a API direto não consegue forjar o IP. Sem proxy declarado,
 * fica o 1º salto do x-forwarded-for (a Vercel reescreve; quem chama o VPS direto escreve o que quiser) e, sem ele, o
 * socket. Não serve para o limite por cliente do canal público de denúncia (reportClientIp).
 */
export function auditClientIp(
  request: AuditRequest,
  trust: Pick<AccessLogConfig, 'trust' | 'trustConfigured'> = trustFromProcessEnv(),
): string | null {
  const headers = request.headers ?? {};
  if (trust.trustConfigured) {
    return resolveClientAddress(
      {
        remoteAddress: request.socket?.remoteAddress ?? request.ip ?? null,
        forwardedFor: headers['x-forwarded-for'],
        realIp: headers['x-real-ip'],
      },
      trust.trust,
    ).ip;
  }
  const forwarded = headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
    ?.split(',')[0]
    ?.trim();
  return (first || request.ip || null)?.slice(0, 64) ?? null;
}

/** Token de injeção da configuração (o AccessLogModule registra o provider abaixo). */
export const ACCESS_LOG_CONFIG = Symbol('ACCESS_LOG_CONFIG');

/**
 * Erro de todo boot sem proxy declarado. Não depende do NODE_ENV: a produção roda fora de `production` e o aviso
 * sumiria justo lá. Sem dado de cliente nem valor de env.
 */
export const NO_TRUSTED_PROXY_ALERT =
  'registro de acesso (Marco Civil, art. 15) SEM proxy declarado: cada linha grava o IP e a porta do proxy da frente ' +
  '(Vercel ou nginx), não os do cliente, e o registro não identifica ninguém. Defina TRUSTED_PROXY_HOPS (2 = Vercel + ' +
  'nginx) ou TRUSTED_PROXY_IPS e grave a porta de origem no nginx (proxy_set_header X-Real-Port $remote_port)';

/**
 * Provider Nest: lê pelo ConfigService, avisa cada valor recusado e loga o resumo uma vez no boot. Sem proxy declarado,
 * erro a cada boot (NO_TRUSTED_PROXY_ALERT): o boot segue, mas a falta não fica escondida num log de nível info.
 */
export const accessLogConfigProvider: Provider = {
  provide: ACCESS_LOG_CONFIG,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): AccessLogConfig => {
    const logger = new Logger('AccessLogConfig');
    const { config, warnings } = loadAccessLogConfig((key) => {
      const value = configService.get<unknown>(key);
      return typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : undefined;
    });
    for (const warning of warnings) logger.warn(warning);
    logger.log(config.summary);
    if (!config.trustConfigured) logger.error(NO_TRUSTED_PROXY_ALERT);
    return config;
  },
};
