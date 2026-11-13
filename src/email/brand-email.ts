import { localeFromCountry } from '../pending-grants/buyer-locale';

/**
 * Peças comuns dos e-mails de cliente com a cara da marca (regra do dono, 12/11: toda mensagem leva o banner).
 *
 * - Idioma: pt, es ou en. A conta grava `locale` pelo IP (México vira en-US, por exemplo), então o país, quando
 *   existe, decide primeiro; depois o prefixo do locale; sem pista, inglês.
 * - Banner: imagem pública da marca em assets.theaimodelab.com, uma das 4 por idioma, escolhida de forma estável
 *   pelo destinatário (a mesma cliente vê sempre o mesmo banner na mesma série). Nunca miniatura de geração.
 * - Links do site sempre com o prefixo do idioma (/pt-br, /es, /en): sem ele o site abre em português.
 */
export type MailLocale = 'pt' | 'es' | 'en';

export const BRAND_BANNER_BASE_URL = 'https://assets.theaimodelab.com/assets/brand/banners';
const BANNERS_PER_LOCALE = 4;

/** Prefixo da rota do site por idioma. */
export function sitePathFor(locale: MailLocale): 'pt-br' | 'es' | 'en' {
  if (locale === 'pt') return 'pt-br';
  return locale;
}

/** Idioma do e-mail de uma conta: país primeiro (o locale gravado vem do IP e erra a América Latina), depois o locale. */
export function mailLocaleFor(account: { locale?: string | null; country?: string | null }): MailLocale {
  const byCountry = localeFromCountry(account.country ?? null);
  if (byCountry) return byCountry;
  const prefix = (account.locale ?? '').trim().toLowerCase();
  if (prefix.startsWith('pt')) return 'pt';
  if (prefix.startsWith('es')) return 'es';
  return 'en';
}

/** Banner da marca para o idioma; `seed` (o e-mail da cliente) escolhe uma das 4 versões de forma estável. */
export function brandBannerUrl(locale: MailLocale, seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const index = (hash % BANNERS_PER_LOCALE) + 1;
  return `${BRAND_BANNER_BASE_URL}/email-${locale}-${index}.jpg`;
}

/** Junta parâmetros de UTM (ou outros) a um link, respeitando o "?" que já existir. */
export function withQuery(url: string, params: Record<string, string | null | undefined>): string {
  const query = Object.entries(params)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value as string)}`)
    .join('&');
  if (!query) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

const HTML_LANG: Record<MailLocale, string> = { pt: 'pt-BR', es: 'es', en: 'en' };

export interface BrandEmailContent {
  locale: MailLocale;
  /** Texto curto que o Gmail/Outlook mostra ao lado do assunto. */
  preheader: string;
  /** URL do banner; null = sem banner (ex.: conta de outra marca, que não usa a arte da The AI Model Lab). */
  bannerUrl: string | null;
  title: string;
  /** Parágrafos em HTML já escapado (podem ter <strong>). */
  paragraphs: string[];
  /** Bloco de destaque opcional (ex.: o código de 6 dígitos), em HTML já escapado. */
  highlight?: string;
  cta?: { label: string; url: string };
  /** Linha pequena depois do botão (HTML já escapado). */
  note?: string;
  footer: string;
}

/**
 * Layout escuro da marca, em tabelas (Gmail, Outlook e Apple Mail), 520 px de largura e fluido no celular.
 * O banner vai no topo, a mensagem em 1 título + 1 a 3 parágrafos + 1 botão.
 */
export function renderBrandEmail(content: BrandEmailContent): string {
  const banner = content.bannerUrl
    ? `<tr><td style="padding:0;"><img src="${content.bannerUrl}" alt="The AI Model Lab" width="520" style="display:block;width:100%;max-width:520px;height:auto;border:0;"></td></tr>`
    : '';
  const paragraphs = content.paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#d4d4dc;">${p}</p>`)
    .join('\n              ');
  const highlight = content.highlight
    ? `<div style="margin:8px 0 24px;padding:18px 20px;border-radius:12px;background-color:#1f1f29;text-align:center;">${content.highlight}</div>`
    : '';
  const cta = content.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;"><tr><td bgcolor="#ff2d87" style="border-radius:999px;">
                <a href="${content.cta.url}" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">${content.cta.label}</a>
              </td></tr></table>`
    : '';
  const note = content.note
    ? `<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#8a8a99;">${content.note}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="${HTML_LANG[content.locale]}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="color-scheme" content="dark light"></head>
<body style="margin:0;padding:0;background-color:#0b0b10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${content.preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0b0b10;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="width:100%;max-width:520px;background-color:#15151d;border-radius:16px;overflow:hidden;">
          ${banner}
          <tr>
            <td style="padding:32px 28px 12px;">
              <h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;font-weight:800;color:#ffffff;">${content.title}</h1>
              ${paragraphs}
              ${highlight}
              ${cta}
              ${note}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px 28px;">
              <p style="margin:0;font-size:12px;line-height:1.5;color:#6f6f80;">${content.footer}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
