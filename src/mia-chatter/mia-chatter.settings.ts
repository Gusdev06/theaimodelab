import type { ChatterLocale, TierId } from './chatter-script';

/** Preferências da cliente guardadas em mia_chatter_accounts.settings (Json). */
export interface MiaChatterSettings {
  /** nome da persona no chat (padrão: o nome de exibição da Fanvue) */
  personaName: string | null;
  /** 1–3 linhas sobre a persona (cidade, trabalho, manias), para o tom do texto */
  personaBio: string | null;
  /** língua das respostas; auto = a do fã */
  locale: 'auto' | ChatterLocale;
  /** a cliente confirmou que o perfil dela na Fanvue está marcado como IA (a Fanvue exige; sem isso a Mia não liga) */
  aiLabelConfirmed: boolean;
  /** mídias do cofre da Fanvue que vão travadas (PPV) em cada degrau; vazio = a oferta sai só em texto */
  tierMedia: Record<TierId, string[]>;
}

export interface MiaChatterStats {
  conversations: number;
  replies: number;
  offers: number;
  sales: number;
  revenueUsd: number;
  /** respostas que saíram do texto pronto do kit (teto do mês, sem chave ou modelo fora do contrato) */
  kitReplies: number;
  whales: number;
}

export const EMPTY_STATS: MiaChatterStats = { conversations: 0, replies: 0, offers: 0, sales: 0, revenueUsd: 0, kitReplies: 0, whales: 0 };

const LOCALES = new Set(['auto', 'pt', 'es', 'en']);
const MEDIA_UUID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_MEDIA_PER_TIER = 10;

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function cleanMedia(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item === 'string' && MEDIA_UUID.test(item.trim())) unique.add(item.trim());
    if (unique.size >= MAX_MEDIA_PER_TIER) break;
  }
  return [...unique];
}

export function parseSettings(raw: unknown): MiaChatterSettings {
  const object = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const media = object.tierMedia && typeof object.tierMedia === 'object' ? (object.tierMedia as Record<string, unknown>) : {};
  const locale = typeof object.locale === 'string' && LOCALES.has(object.locale) ? (object.locale as MiaChatterSettings['locale']) : 'auto';
  return {
    personaName: cleanText(object.personaName, 40),
    personaBio: cleanText(object.personaBio, 400),
    locale,
    aiLabelConfirmed: object.aiLabelConfirmed === true,
    tierMedia: { teaser: cleanMedia(media.teaser), spicy: cleanMedia(media.spicy), whale: cleanMedia(media.whale) },
  };
}

/** Aplica só os campos enviados; o que não veio fica como estava. */
export function mergeSettings(current: MiaChatterSettings, patch: Partial<Record<keyof MiaChatterSettings, unknown>>): MiaChatterSettings {
  const next: Record<string, unknown> = { ...current };
  for (const key of ['personaName', 'personaBio', 'locale', 'aiLabelConfirmed'] as const) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (patch.tierMedia && typeof patch.tierMedia === 'object') {
    next.tierMedia = { ...current.tierMedia, ...(patch.tierMedia as Record<string, unknown>) };
  }
  return parseSettings(next);
}

export function parseStats(raw: unknown): MiaChatterStats {
  const object = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const number = (key: keyof MiaChatterStats) => {
    const value = Number(object[key]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  return {
    conversations: number('conversations'),
    replies: number('replies'),
    offers: number('offers'),
    sales: number('sales'),
    revenueUsd: Math.round(number('revenueUsd') * 100) / 100,
    kitReplies: number('kitReplies'),
    whales: number('whales'),
  };
}
