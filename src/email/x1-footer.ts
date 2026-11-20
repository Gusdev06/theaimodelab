/**
 * Rodapé "falar direto" dos e-mails de cliente: 1 linha com WhatsApp (a Mia do suporte) e Telegram.
 *
 * Regra do dono (17 e 20/11/2026): WhatsApp + Telegram em todo link e mensagem com a cliente, para puxar a
 * conversa 1 a 1. Fica FORA de e-mail de senha, código de verificação, segurança, exclusão de conta,
 * cancelamento, reembolso, jurídico e parceiro: quem chama só passa `x1Locale` nos envios permitidos.
 *
 * `EMAIL_X1_LINKS=off` desliga sem deploy de código (lido a cada envio).
 */

export type X1Locale = 'pt' | 'es' | 'en';

const DEFAULT_SUPPORT_WA_NUMBER = '5511922198321';
const TELEGRAM_BOT = 'heaimodelab_bot';

const WA_TEXT: Record<X1Locale, string> = {
  pt: 'MIA · Oi, Mia! Quero conversar com você.',
  es: 'MIA · ¡Hola, Mia! Quiero hablar contigo.',
  en: 'MIA · Hi Mia! I want to chat with you.',
};

const GUIDE_LINE: Record<X1Locale, string> = {
  pt: '💬 Prefere falar comigo direto?',
  es: '💬 ¿Prefieres hablar conmigo directo?',
  en: '💬 Rather talk to me directly?',
};

const RECOVERY_PLANS = ['creator', 'pro', 'advanced', 'studio', 'pack'] as const;
export type X1RecoveryPlan = (typeof RECOVERY_PLANS)[number];

export interface X1FooterOptions {
  /** Plano da recuperação de pagamento: o bot abre a conversa já no assunto (`rec_{plano}_{idioma}`). */
  recoveryPlan?: X1RecoveryPlan | null;
}

export function isX1LinksEnabled(): boolean {
  return (process.env.EMAIL_X1_LINKS ?? 'on').trim().toLowerCase() !== 'off';
}

/** Reconhece o plano pelo nome exibido ("Pro", "Plano Creator mensal"...); null quando não bate. */
export function recoveryPlanFromName(planName: string | null | undefined): X1RecoveryPlan | null {
  const lower = (planName ?? '').toLowerCase();
  return RECOVERY_PLANS.find((plan) => lower.includes(plan)) ?? null;
}

export function x1WhatsAppUrl(locale: X1Locale): string {
  const configured = (process.env.MIA_X1_WA_NUMBER ?? '').replace(/\D/g, '');
  const number = configured.length >= 10 ? configured : DEFAULT_SUPPORT_WA_NUMBER;
  return `https://wa.me/${number}?text=${encodeURIComponent(WA_TEXT[locale]).replace(/'/g, '%27')}`;
}

export function x1TelegramUrl(locale: X1Locale, options: X1FooterOptions = {}): string {
  const payload = options.recoveryPlan ? `rec_${options.recoveryPlan}_${locale}` : `x1_${locale}`;
  return `https://t.me/${TELEGRAM_BOT}?start=${payload}`;
}

/** Bloco em tabela de 1 linha, fundo transparente: serve nos layouts claro e escuro. */
export function x1FooterHtml(locale: X1Locale, options: X1FooterOptions = {}): string {
  const wa = x1WhatsAppUrl(locale).replace(/&/g, '&amp;');
  const tg = x1TelegramUrl(locale, options);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" data-x1-footer="1"><tr><td align="center" style="padding:14px 12px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#8a8a99;">${GUIDE_LINE[locale]} <a href="${wa}" style="color:#1da851;font-weight:700;text-decoration:none;">WhatsApp</a> &middot; <a href="${tg}" style="color:#229ed9;font-weight:700;text-decoration:none;">Telegram</a></td></tr></table>`;
}

/**
 * Coloca o rodapé antes do `</body>` (ou no fim, se o HTML for um pedaço). Idempotente e sem efeito com a
 * flag desligada.
 */
export function withX1Footer(html: string, locale: X1Locale, options: X1FooterOptions = {}): string {
  if (!isX1LinksEnabled() || html.includes('data-x1-footer')) return html;
  const block = x1FooterHtml(locale, options);
  const closeIndex = html.lastIndexOf('</body>');
  if (closeIndex === -1) return `${html}\n${block}`;
  return `${html.slice(0, closeIndex)}${block}\n${html.slice(closeIndex)}`;
}

/** 'pt-BR' (resolveEmailLocale) e 'pt' (MailLocale) viram o mesmo idioma. */
export function x1LocaleFrom(value: string | null | undefined): X1Locale {
  const prefix = (value ?? '').trim().toLowerCase();
  if (prefix.startsWith('pt')) return 'pt';
  if (prefix.startsWith('es')) return 'es';
  return 'en';
}
