/**
 * Envio dos e-mails da Mia do pacote candy-retencao (24/11/2026): o mesmo caminho dos e-mails de lifecycle
 * (Markdown → HTML, moldura de broadcast, merge tags, Resend), com a marca de origem da conta e o rodapé
 * WhatsApp + Telegram no idioma dela. Quem chama faz a reserva no email_sequence_logs ANTES (dedupe por claim) e
 * apaga a reserva se isto lançar.
 */

import { resolveBrand } from '../brand/brand';
import { EmailService } from '../email/email.service';
import { MailLocale, mailLocaleFor } from '../email/brand-email';
import { X1FooterOptions, x1LocaleFrom } from '../email/x1-footer';
import { renderMarkdownToEmailHtml } from '../admin-emails/helpers/markdown.helper';
import { wrapInBroadcastTemplate } from '../admin-emails/helpers/email-template.helper';
import { applyMergeTags, buildMergeVars } from '../admin-emails/helpers/merge-tags.helper';
import type { EmailLocale } from './onboarding-sequence-templates';

export interface MiaMailRecipient {
  email: string;
  name: string | null;
  locale?: string | null;
  country?: string | null;
  signupBrand?: string | null;
}

/** Idioma do e-mail: país primeiro (mesma regra dos avisos da marca), depois o locale gravado. */
export function emailLocaleOf(account: { locale?: string | null; country?: string | null }): EmailLocale {
  return toEmailLocale(mailLocaleFor(account));
}

export function toEmailLocale(locale: MailLocale): EmailLocale {
  if (locale === 'pt') return 'pt-BR';
  return locale;
}

export function toMailLocale(locale: EmailLocale): MailLocale {
  return locale === 'pt-BR' ? 'pt' : locale;
}

/**
 * Manda 1 e-mail. Devolve o id do Resend, ou null quando o serviço de e-mail não está configurado (nada saiu).
 * Lança no erro do Resend: quem chama libera a reserva.
 */
export async function sendMiaEmail(
  emailService: EmailService,
  params: {
    recipient: MiaMailRecipient;
    subject: string;
    bodyMarkdown: string;
    plan?: string | null;
    logoUrl?: string;
    x1Options?: X1FooterOptions;
  },
): Promise<string | null> {
  const { recipient } = params;
  const innerHtml = await renderMarkdownToEmailHtml(params.bodyMarkdown);
  const wrapped = wrapInBroadcastTemplate(innerHtml, params.logoUrl ?? process.env.LOGO_URL ?? '');
  const vars = buildMergeVars({ name: recipient.name, plan: params.plan ?? null, email: recipient.email });
  const { id } = await emailService.sendRawEmail({
    to: recipient.email,
    subject: applyMergeTags(params.subject, vars),
    html: applyMergeTags(wrapped, vars),
    brand: resolveBrand(recipient.signupBrand),
    x1Locale: x1LocaleFrom(toMailLocale(emailLocaleOf(recipient))),
    x1Options: params.x1Options,
  });
  return id;
}

/** URL pública do app (primeiro FRONTEND_URL), sem barra no fim. */
export function appBaseUrl(): string {
  const raw = (process.env.FRONTEND_URL ?? '').split(',')[0]?.trim();
  return (raw || 'https://www.theaimodelab.com').replace(/\/+$/, '');
}
