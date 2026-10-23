import {
  auditClientIp,
  type AccessLogConfig,
  type AuditRequest,
} from '../../access-log/access-log.config';
import { REFINER_TEXT_MEDIA_KEY } from '../image-safety/image-safety.scans';

/**
 * Peças puras do fluxo do revisor de segurança (camada 7): marcador do admin, formato do registro de comunicação,
 * correspondência da chave promovida, percentis e datas. Sem banco, sem rede.
 */

/** O que o admin comum vê no lugar da mídia em revisão, em evidência ou em retenção legal. */
export const SAFETY_REVIEW_MARKER = 'em revisão de segurança';

/** Motivo obrigatório de toda ação do revisor (ver a mídia, liberar, confirmar, comunicar). */
export const REVIEW_REASON_MIN_LENGTH = 10;
export const REVIEW_REASON_MAX_LENGTH = 1000;

/** Regra gravada quando a confirmação vem do revisor (não de um detector). */
export const REVIEW_CONFIRMED_RULE = 'REVIEW_CONFIRMED';

/** Canais de comunicação à autoridade: CNCA/PF (Nidus), NCMEC (CyberTipline), SaferNet, outro. */
export const REPORT_CHANNELS = ['cnca', 'ncmec', 'safernet', 'outro'] as const;
export type ReportChannel = (typeof REPORT_CHANNELS)[number];

/** Protocolo devolvido pelo canal: só caracteres de identificador (fica legível e parseável no registro). */
export const REPORT_PROTOCOL_FORMAT = /^[A-Za-z0-9._/-]{1,80}$/;

/** Ações gravadas em content_safety_access_log por este fluxo. */
export type ReviewAccessAction = 'view_media' | 'release' | 'confirm' | 'report';

export const REVIEW_DECISIONS = ['release', 'confirm', 'report'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

const REPORT_PREFIX = /^\[canal:([a-z]+)\](?:\[protocolo:([A-Za-z0-9._/-]{1,80})\])?\s?/;

/** Motivo da comunicação no registro: `[canal:cnca][protocolo:ABC-1] motivo`. */
export function formatReportReason(
  channel: ReportChannel,
  protocol: string | null,
  reason: string,
): string {
  return `[canal:${channel}]${protocol ? `[protocolo:${protocol}]` : ''} ${reason}`;
}

/** Canal e protocolo de uma linha `report` do registro; null quando o texto não segue o formato. */
export function parseReportReason(
  text: string | null | undefined,
): { channel: string; protocol: string | null } | null {
  const match = REPORT_PREFIX.exec(text ?? '');
  if (!match) return null;
  return { channel: match[1], protocol: match[2] ?? null };
}

/** A checagem guardou uma mídia (não o caso leve, que só tem marcador, nem a linha de texto do refinador)? */
export function hasStoredMedia(mediaKey: string | null | undefined): boolean {
  return (
    typeof mediaKey === 'string' &&
    mediaKey.length > 0 &&
    !mediaKey.startsWith('light:') &&
    mediaKey !== REFINER_TEXT_MEDIA_KEY
  );
}

/**
 * A chave publicada veio da promoção desta chave da quarentena? A promoção troca só o segmento do uuid
 * (`generations/<id>/<uuid>/<arquivo>`) ou, em chave curta, acrescenta um (`generations/<id>/<arquivo>`).
 */
export function matchesPromotedKey(
  quarantineKey: string,
  publishedKey: string,
): boolean {
  if (quarantineKey === publishedKey) return true;
  const source = quarantineKey.split('/');
  const target = publishedKey.split('/');
  const sourceFile = source.pop();
  const targetFile = target.pop();
  if (!sourceFile || sourceFile !== targetFile) return false;
  if (source.length >= 3) {
    if (target.length !== source.length) return false;
    return source.slice(0, -1).every((part, index) => part === target[index]);
  }
  if (target.length !== source.length + 1) return false;
  return source.every((part, index) => part === target[index]);
}

/** Percentil (0–100) de uma lista já ORDENADA; vazia = null. Vizinho mais próximo, sem interpolar. */
export function percentile(
  sorted: readonly number[],
  p: number,
): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((Math.min(Math.max(p, 0), 100) / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank - 1, 0), sorted.length - 1)];
}

/** Dia UTC `AAAA-MM-DD`. */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Começo do dia UTC. */
export function utcDayStart(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Data do filtro: `AAAA-MM-DD` (dia UTC; `end` = fim do dia, exclusivo no dia seguinte) ou ISO completo. Inválida
 * devolve null (quem chama responde 400).
 */
export function parseDateBound(
  value: string | undefined,
  end: boolean,
): Date | null | undefined {
  if (value === undefined || value === '') return undefined;
  if (DATE_ONLY.test(value)) {
    const start = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(start.getTime())) return null;
    return end ? new Date(start.getTime() + 86_400_000) : start;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * IP de quem revisa, para o registro (auditClientIp): com proxy declarado em TRUSTED_PROXY_HOPS/IPS, só o salto
 * confiável vale (não dá para forjar chamando a API direto); sem proxy declarado, o 1º do x-forwarded-for (a API fica
 * atrás do rewrite da Vercel), senão o do socket. Só vai para o registro de acesso, nunca para decisão.
 */
export function reviewerIpOf(
  request: AuditRequest,
  trust?: Pick<AccessLogConfig, 'trust' | 'trustConfigured'>,
): string | null {
  return auditClientIp(request, trust);
}
