/**
 * Texto do push a partir da MESMA notificação do sino (L16: "push usa as notificações do sino").
 * O corpo usa `data.reason` quando a notificação já traz o texto na língua da cliente (recusa, pré-pago); senão, o
 * texto curto do tipo. Tipo desconhecido (L10, Black e os próximos) cai no genérico, nunca fica sem aviso.
 */

export type PushLocale = 'pt-BR' | 'es' | 'en';

export interface PushMessage {
  title: string;
  body: string;
  /** caminho no site aberto no toque */
  path: string;
  /** agrupa avisos do mesmo tipo no aparelho (o novo substitui o velho) */
  tag: string;
}

type TextPair = { title: string; body: string };

const TEXTS: Record<string, Record<PushLocale, TextPair>> = {
  'payment-declined-fallback': {
    'pt-BR': { title: 'Seu pagamento não passou', body: 'Libere 1 mês avulso agora e continue criando com ela.' },
    es: { title: 'Tu pago no pasó', body: 'Libera 1 mes suelto ahora y sigue creando con ella.' },
    en: { title: 'Your payment didn’t go through', body: 'Unlock 1 month now and keep creating with her.' },
  },
  'prepaid-expiring': {
    'pt-BR': { title: 'Seu acesso termina em breve', body: 'Renove e não perca suas modelos nem seus créditos.' },
    es: { title: 'Tu acceso termina pronto', body: 'Renueva y no pierdas tus modelos ni tus créditos.' },
    en: { title: 'Your access ends soon', body: 'Renew and keep your models and credits.' },
  },
  'prepaid-expired': {
    'pt-BR': { title: 'Seu acesso terminou', body: 'Ela está esperando você voltar. Toque para continuar.' },
    es: { title: 'Tu acceso terminó', body: 'Ella te está esperando. Toca para continuar.' },
    en: { title: 'Your access has ended', body: 'She’s waiting for you. Tap to continue.' },
  },
  'community-approved': {
    'pt-BR': { title: 'Sua criação foi aprovada', body: 'Ela já está na comunidade.' },
    es: { title: 'Tu creación fue aprobada', body: 'Ya está en la comunidad.' },
    en: { title: 'Your creation was approved', body: 'It’s live in the community.' },
  },
  'community-rejected': {
    'pt-BR': { title: 'Sua criação não entrou na comunidade', body: 'Toque para ver o motivo.' },
    es: { title: 'Tu creación no entró en la comunidad', body: 'Toca para ver el motivo.' },
    en: { title: 'Your creation wasn’t added to the community', body: 'Tap to see why.' },
  },
  'user-followed': {
    'pt-BR': { title: 'Você tem um novo seguidor', body: 'Toque para ver quem é.' },
    es: { title: 'Tienes un nuevo seguidor', body: 'Toca para ver quién es.' },
    en: { title: 'You have a new follower', body: 'Tap to see who it is.' },
  },
};

const GENERIC: Record<PushLocale, TextPair> = {
  'pt-BR': { title: 'Novidade na The AI Model Lab', body: 'Toque para ver.' },
  es: { title: 'Novedad en The AI Model Lab', body: 'Toca para ver.' },
  en: { title: 'New on The AI Model Lab', body: 'Tap to see.' },
};

/** Tipos que não viram push (a própria cliente acabou de fazer a ação). */
const SILENT_TYPES = new Set(['community-submitted']);

export function pushLocaleOf(locale: string | null | undefined): PushLocale {
  const value = String(locale ?? '').toLowerCase();
  if (value.startsWith('es')) return 'es';
  if (value.startsWith('pt')) return 'pt-BR';
  return 'en';
}

const BODY_MAX = 180;

export function buildPushMessage(type: string, data: Record<string, unknown> | undefined, locale: string | null | undefined): PushMessage | null {
  if (SILENT_TYPES.has(type)) return null;
  const lang = pushLocaleOf(locale);
  const base = TEXTS[type]?.[lang] ?? GENERIC[lang];
  const reason = typeof data?.reason === 'string' ? data.reason.trim() : '';
  const body = reason ? (reason.length > BODY_MAX ? `${reason.slice(0, BODY_MAX - 1)}…` : reason) : base.body;
  return { title: base.title, body, path: '/', tag: `taml-${type}` };
}
