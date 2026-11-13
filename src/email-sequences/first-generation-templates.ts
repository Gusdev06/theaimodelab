import { ORIGIN_SUPPORT_EMAIL } from '../brand/brand';
import { MailLocale, renderBrandEmail, sitePathFor, withQuery } from '../email/brand-email';

/**
 * Aviso da 1ª cena da conta (D-04, auditoria da jornada 13/11): vídeo leva 1–3 min e quem sai da tela perde o
 * gancho. Pronta: 1 e-mail ~10 min depois, só se a 1ª geração concluída levou mais de 60 s. Falhou: 1 e-mail
 * dizendo que os créditos voltaram. Banner da marca, SEM miniatura do resultado (entrega e privacidade), CTA
 * para os Reels. Assunto sem termo adulto (mesma reputação de domínio dos transacionais).
 */
export type FirstGenerationEmailKind = 'ready' | 'failed';

const COPY: Record<FirstGenerationEmailKind, Record<MailLocale, {
  subject: string;
  preheader: string;
  title: string;
  paragraphs: string[];
  button: string;
}>> = {
  ready: {
    pt: {
      subject: 'Sua 1ª cena ficou pronta',
      preheader: 'Ela já está salva na sua conta. Abra e veja.',
      title: 'Sua 1ª cena ficou pronta',
      paragraphs: [
        'Ela terminou enquanto você estava fora e já está salva na sua conta.',
        'Abra para ver, baixar ou transformar em vídeo.',
      ],
      button: 'Ver minha cena',
    },
    es: {
      subject: 'Tu 1.ª escena está lista',
      preheader: 'Ya está guardada en tu cuenta. Ábrela y mírala.',
      title: 'Tu 1.ª escena está lista',
      paragraphs: [
        'Terminó mientras no estabas y ya está guardada en tu cuenta.',
        'Ábrela para verla, descargarla o convertirla en video.',
      ],
      button: 'Ver mi escena',
    },
    en: {
      subject: 'Your 1st scene is ready',
      preheader: "It's already saved in your account. Open it and take a look.",
      title: 'Your 1st scene is ready',
      paragraphs: [
        'It finished while you were away and is already saved in your account.',
        'Open it to watch, download or turn it into a video.',
      ],
      button: 'See my scene',
    },
  },
  failed: {
    pt: {
      subject: 'Sua 1ª cena não saiu: os créditos voltaram',
      preheader: 'Deu erro na geração e nada foi cobrado. Tente de novo em 1 toque.',
      title: 'Sua 1ª cena não saiu',
      paragraphs: [
        'Deu erro na geração e os <strong>créditos já voltaram</strong> para a sua conta.',
        'Tente de novo: escolha uma cena nos Reels e toque em gerar.',
      ],
      button: 'Tentar de novo',
    },
    es: {
      subject: 'Tu 1.ª escena no salió: los créditos volvieron',
      preheader: 'Hubo un error en la generación y no se cobró nada. Inténtalo de nuevo en 1 toque.',
      title: 'Tu 1.ª escena no salió',
      paragraphs: [
        'Hubo un error en la generación y los <strong>créditos ya volvieron</strong> a tu cuenta.',
        'Inténtalo de nuevo: elige una escena en los Reels y toca generar.',
      ],
      button: 'Intentar de nuevo',
    },
    en: {
      subject: "Your 1st scene didn't make it: your credits are back",
      preheader: 'The generation failed and nothing was charged. Try again in 1 tap.',
      title: "Your 1st scene didn't make it",
      paragraphs: [
        'The generation failed and your <strong>credits are already back</strong> in your account.',
        'Try again: pick a scene in Reels and tap generate.',
      ],
      button: 'Try again',
    },
  },
};

const FOOTER: Record<MailLocale, string> = {
  pt: `Este aviso sai só na sua 1ª cena. Dúvidas? ${ORIGIN_SUPPORT_EMAIL}`,
  es: `Este aviso sale solo con tu 1.ª escena. ¿Dudas? ${ORIGIN_SUPPORT_EMAIL}`,
  en: `You only get this notice for your 1st scene. Questions? ${ORIGIN_SUPPORT_EMAIL}`,
};

export function buildFirstGenerationEmail(
  kind: FirstGenerationEmailKind,
  locale: MailLocale,
  params: { appUrl: string; bannerUrl: string | null },
): { subject: string; html: string } {
  const copy = COPY[kind][locale];
  const reelsUrl = withQuery(`${params.appUrl.replace(/\/+$/, '')}/${sitePathFor(locale)}/x/reels`, {
    utm_source: 'email',
    utm_campaign: kind === 'ready' ? 'first_scene_ready' : 'first_scene_failed',
  });
  return {
    subject: copy.subject,
    html: renderBrandEmail({
      locale,
      preheader: copy.preheader,
      bannerUrl: params.bannerUrl,
      title: copy.title,
      paragraphs: copy.paragraphs,
      cta: { label: copy.button, url: reelsUrl },
      footer: FOOTER[locale],
    }),
  };
}
