/**
 * Aviso de suspensão para a pessoa (LGPD, art. 20; DSA, art. 17): diz a categoria da regra do termo, que a decisão foi
 * automática e por onde pedir a revisão humana. Nunca diz qual sinal técnico disparou (seria um oráculo para quem
 * tenta burlar), nem o nome da marca (a mesma API atende mais de um site). Função pura: quem envia é o StrikesService.
 */

export type NoticeLocale = 'pt' | 'en' | 'es';

export interface SuspensionNoticeInput {
  name: string | null;
  /** User.locale ("pt-BR", "en", "es-ES"…); desconhecido = português */
  locale: string | null;
  /** canal de revisão (SAFETY_REVIEW_CONTACT): e-mail ou endereço https; null = só o site */
  reviewContact: string | null;
  /** site (FRONTEND_URL), usado quando não há canal próprio */
  siteUrl: string | null;
}

export interface SuspensionNotice {
  locale: NoticeLocale;
  subject: string;
  html: string;
}

const EMAIL_FORMAT = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

export function noticeLocaleOf(
  locale: string | null | undefined,
): NoticeLocale {
  const value = (locale ?? '').toLowerCase();
  if (value.startsWith('es')) return 'es';
  if (value.startsWith('en')) return 'en';
  return 'pt';
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ] as string,
  );
}

/** Canal de revisão aceito: e-mail ou https. Qualquer outra coisa é ignorada (nunca vira link). */
export function reviewChannelOf(
  value: string | null | undefined,
): { kind: 'email' | 'url'; value: string } | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (EMAIL_FORMAT.test(text)) return { kind: 'email', value: text };
  try {
    const url = new URL(text);
    if (url.protocol === 'https:')
      return { kind: 'url', value: url.toString() };
  } catch {
    // não é URL
  }
  return null;
}

const COPY: Readonly<
  Record<
    NoticeLocale,
    {
      subject: string;
      greeting: (name: string | null) => string;
      body: string;
      automated: string;
      review: string;
      reviewFallback: string;
      meanwhile: string;
    }
  >
> = {
  pt: {
    subject: 'Sua conta foi suspensa para revisão',
    greeting: (name) => (name ? `Olá, ${name}.` : 'Olá.'),
    body: 'Sua conta foi suspensa porque um pedido recente não passou na checagem de segurança de conteúdo prevista nos Termos de Uso (proteção de crianças e adolescentes).',
    automated: 'Essa decisão foi tomada de forma automática.',
    review:
      'Você tem o direito de pedir que uma pessoa da nossa equipe revise a decisão (Lei 13.709/2018, art. 20). Para pedir a revisão, use este canal:',
    reviewFallback:
      'Você tem o direito de pedir que uma pessoa da nossa equipe revise a decisão (Lei 13.709/2018, art. 20). Para pedir a revisão, fale com o suporte pelo site.',
    meanwhile:
      'Enquanto a revisão não termina, o acesso fica bloqueado e as gerações que estavam na fila foram canceladas.',
  },
  en: {
    subject: 'Your account has been suspended pending review',
    greeting: (name) => (name ? `Hi ${name},` : 'Hi,'),
    body: 'Your account has been suspended because a recent request did not pass the content safety check set out in our Terms of Use (protection of children and teenagers).',
    automated: 'This decision was made automatically.',
    review:
      'You have the right to ask a person on our team to review this decision. To request a review, use this channel:',
    reviewFallback:
      'You have the right to ask a person on our team to review this decision. To request a review, contact support through the website.',
    meanwhile:
      'Until the review is complete, access is blocked and the generations that were waiting in the queue have been canceled.',
  },
  es: {
    subject: 'Tu cuenta fue suspendida para revisión',
    greeting: (name) => (name ? `Hola, ${name}.` : 'Hola.'),
    body: 'Tu cuenta fue suspendida porque un pedido reciente no pasó el control de seguridad de contenido previsto en los Términos de Uso (protección de niños, niñas y adolescentes).',
    automated: 'Esta decisión se tomó de forma automática.',
    review:
      'Tienes derecho a pedir que una persona de nuestro equipo revise la decisión. Para pedir la revisión, usa este canal:',
    reviewFallback:
      'Tienes derecho a pedir que una persona de nuestro equipo revise la decisión. Para pedir la revisión, contacta al soporte a través del sitio.',
    meanwhile:
      'Mientras la revisión no termina, el acceso queda bloqueado y las generaciones que estaban en la cola fueron canceladas.',
  },
};

export function buildSuspensionNotice(
  input: SuspensionNoticeInput,
): SuspensionNotice {
  const locale = noticeLocaleOf(input.locale);
  const copy = COPY[locale];
  const name = input.name?.replace(/\s+/g, ' ').trim().slice(0, 80) || null;
  const channel =
    reviewChannelOf(input.reviewContact) ??
    (reviewChannelOf(input.siteUrl)?.kind === 'url'
      ? reviewChannelOf(input.siteUrl)
      : null);
  const link = channel
    ? channel.kind === 'email'
      ? `<a href="mailto:${escapeHtml(channel.value)}">${escapeHtml(channel.value)}</a>`
      : `<a href="${escapeHtml(channel.value)}">${escapeHtml(channel.value)}</a>`
    : null;
  const paragraphs = [
    escapeHtml(copy.greeting(name)),
    escapeHtml(copy.body),
    escapeHtml(copy.automated),
    link
      ? `${escapeHtml(copy.review)} ${link}`
      : escapeHtml(copy.reviewFallback),
    escapeHtml(copy.meanwhile),
  ];
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.55;color:#111">${paragraphs
    .map((text) => `<p style="margin:0 0 12px">${text}</p>`)
    .join('')}</div>`;
  return { locale, subject: copy.subject, html };
}
