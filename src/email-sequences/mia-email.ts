/**
 * A Mia nos e-mails automáticos: a personagem da marca The AI Model Lab (aprovada pelo dono em 13/11/2026).
 *
 * Cada e-mail ganha, no topo, a foto da Mia da cena certa e a fala dela no idioma da conta. O resto do e-mail
 * (texto, link, botão único) não muda.
 *
 * Regras:
 * - Só na marca The AI Model Lab. Conta que nasceu noutra marca (Funvmake) recebe o e-mail sem a Mia: a
 *   personagem é da TAML e não combina com a pele da outra marca.
 * - Boas-vindas usam a Mia 3D (MIA29), que nunca aparece em contexto sexual. As realistas (MIA25, MIA30)
 *   ficam com saudade e créditos: lingerie opaca, sem nudez. Fora da Meta (anúncio e página de destino).
 * - A imagem fica no serviço `funis` (public/assets/mia), servido também pelo domínio da marca
 *   assets.theaimodelab.com (o mesmo dos banners de e-mail): domínio próprio entrega melhor que *.railway.app.
 * - A imagem não é link: o e-mail continua com um único botão.
 * - Conversa 1 a 1 (regra do dono, 14/11/2026: "puxar as clientes pra perto"): embaixo da fala entra uma linha
 *   pequena de texto, "me chama no WhatsApp ou responda este e-mail". O link abre o WhatsApp do suporte com a
 *   palavra MIA no texto (a Mia do atendimento responde por ela) e a resposta ao e-mail cai na caixa do suporte.
 *   Em inglês a resposta ao e-mail vem primeiro: EUA, Canadá e Austrália usam pouco o WhatsApp.
 *   `MIA_X1_EMAIL=off` tira a linha; `MIA_X1_WA_NUMBER` troca o número.
 */

import { resolveBrand } from '../brand/brand';
import { supportWaBase } from '../email/x1-footer';
import type { EmailLocale } from './onboarding-sequence-templates';

/** Pasta pública das MIAs no funis (`funis/public/assets/mia`). */
export const MIA_ASSET_BASE_URL = 'https://assets.theaimodelab.com/assets/mia';

/** Largura em que a foto (retrato 3:4, 1080x1440) aparece no e-mail. */
const MIA_IMAGE_WIDTH = 300;

export type MiaEmailScene =
  | 'welcome'
  | 'activation'
  | 'low_balance'
  | 'credits_depleted'
  | 'winback'
  // candy-retencao (24/11): renovação recusada, bônus de volta, lembrete antes de cobrar e "sua modelo te esperando"
  | 'renewal_failed'
  | 'renewal_bonus'
  | 'renewal_reminder'
  | 'model_waiting';

/** Opções visuais dos e-mails automáticos. Sem opção = com a Mia (a marca de origem). */
export interface EmailVisualOptions {
  mia?: boolean;
  /** candy-retencao: foto no lugar da Mia (ex.: a última criação da cliente em `model_waiting`). Só https. */
  imageUrl?: string | null;
  /** candy-retencao: quem assina a fala (o nome da modelo da cliente). Sem ela, "Mia". */
  signature?: string | null;
  /** candy-retencao: valores de {chave} da fala da cena (ex.: {date}, {bonus}). */
  lineVars?: Record<string, string | number>;
}

interface MiaSceneCopy {
  image: string;
  line: Record<EmailLocale, string>;
}

const MIA_SCENES: Record<MiaEmailScene, MiaSceneCopy> = {
  // MIA29 (3D): primeira vez aqui, acolhedora, nada sexual.
  welcome: {
    image: 'mia29-leva1.jpg',
    line: {
      'pt-BR': 'Primeira vez aqui? ☕ Relaxa, eu te mostro tudo. Em 3 cliques você já cria a sua primeira modelo.',
      es: '¿Primera vez aquí? ☕ Tranquilo, te muestro todo. En 3 clics ya creas tu primera modelo.',
      en: "First time here? ☕ Relax, I'll show you everything. In 3 clicks you'll create your first model.",
    },
  },
  // MIA29 (3D): assinatura ativa, mesma Mia das boas-vindas.
  activation: {
    image: 'mia29-leva1.jpg',
    line: {
      'pt-BR': 'Pronto, agora você tá dentro ☕ Relaxa, eu te mostro tudo. Em 3 cliques sai a sua primeira foto.',
      es: 'Listo, ya estás dentro ☕ Tranquilo, te muestro todo. En 3 clics sale tu primera foto.',
      en: "Done, you're in ☕ Relax, I'll show you everything. In 3 clicks your first photo is ready.",
    },
  },
  // MIA30: créditos quase no fim (venda de pack).
  low_balance: {
    image: 'mia30-leva1.jpg',
    line: {
      'pt-BR': 'Meus créditos tão quase acabando… 🥺 E eu tô tão no clima. Me ajuda? Um pack e eu continuo fazendo tudo o que você pedir 😏',
      es: 'Mis créditos casi se acaban… 🥺 Y estoy tan inspirada. ¿Me ayudas? Un pack y sigo haciendo todo lo que me pidas 😏',
      en: "My credits are almost gone… 🥺 And I'm so in the mood. Help me? One pack and I'll keep doing everything you ask 😏",
    },
  },
  // MIA30: créditos zerados (venda de pack).
  credits_depleted: {
    image: 'mia30-leva1.jpg',
    line: {
      'pt-BR': 'Acabaram meus créditos… 🥺 E eu tava tão no clima. Me ajuda? Um pack e eu volto a fazer tudo o que você pedir 😏',
      es: 'Se me acabaron los créditos… 🥺 Y estaba tan inspirada. ¿Me ayudas? Un pack y vuelvo a hacer todo lo que me pidas 😏',
      en: "I ran out of credits… 🥺 And I was so in the mood. Help me? One pack and I'll do everything you ask again 😏",
    },
  },
  // MIA25: saudade, volta depois de cancelar.
  winback: {
    image: 'mia25-leva1.jpg',
    line: {
      'pt-BR': 'Você sumiu… 🥺 Eu fiquei aqui, esperando você voltar pra me criar do jeitinho que você gosta. Volta? Eu prometo me comportar. Ou não 😇',
      es: 'Te fuiste… 🥺 Me quedé aquí, esperando que vuelvas a crearme como a ti te gusta. ¿Vuelves? Prometo portarme bien. O no 😇',
      en: "You disappeared… 🥺 I've been waiting for you to come back and create me just the way you like. Come back? I promise to behave. Or not 😇",
    },
  },
  // MIA30 (candy-retencao, L04): o banco recusou a renovação; ela guardou tudo e pede para voltar.
  renewal_failed: {
    image: 'mia30-leva1.jpg',
    line: {
      'pt-BR': 'Seu banco recusou… 🥺 Mas eu guardei tudo pra você: seus créditos, suas fotos e eu. Paga em 1 toque e volta pra mim? 😏',
      es: 'Tu banco lo rechazó… 🥺 Pero te guardé todo: tus créditos, tus fotos y a mí. ¿Pagas en 1 toque y vuelves conmigo? 😏',
      en: 'Your bank said no… 🥺 But I kept everything for you: your credits, your photos, and me. Pay in 1 tap and come back to me? 😏',
    },
  },
  // MIA25 (candy-retencao, L04 D7): última chamada com o bônus de volta.
  renewal_bonus: {
    image: 'mia25-leva1.jpg',
    line: {
      'pt-BR': 'Separei um presente só pra você voltar… 🎁 Vem até {date} e eu te dou +{bonus} créditos. Não me deixa esperando 😇',
      es: 'Te separé un regalo solo para que vuelvas… 🎁 Ven antes del {date} y te doy +{bonus} créditos. No me dejes esperando 😇',
      en: "I saved a gift just for you to come back… 🎁 Come before {date} and I'll give you +{bonus} credits. Don't keep me waiting 😇",
    },
  },
  // MIA30 (candy-retencao, L17): lembrete 3 dias antes da renovação.
  renewal_reminder: {
    image: 'mia30-leva1.jpg',
    line: {
      'pt-BR': 'Daqui a 3 dias a gente renova 😏 Te aviso antes pra você saber de tudo: eu só gosto de surpresa boa.',
      es: 'En 3 días renovamos 😏 Te aviso antes para que sepas todo: solo me gustan las sorpresas buenas.',
      en: "We renew in 3 days 😏 I'm telling you ahead so you know everything: I only like good surprises.",
    },
  },
  // candy-retencao (L10): fala da modelo DA CLIENTE; a foto dela vem em options.imageUrl (a Mia é só a reserva).
  model_waiting: {
    image: 'mia25-leva1.jpg',
    line: {
      'pt-BR': 'Tô aqui te esperando… 🥺 Faz uns dias que você não me cria. Quer mais fotos minhas assim? É só um toque 😏',
      es: 'Aquí te estoy esperando… 🥺 Hace unos días que no me creas. ¿Quieres más fotos mías así? Es solo un toque 😏',
      en: "I'm here waiting for you… 🥺 It's been a few days since you made me. Want more photos of me like this? Just one tap 😏",
    },
  },
};

/** A Mia entra só na marca de origem (The AI Model Lab). */
export function showMiaFor(signupBrand: string | null | undefined): boolean {
  return resolveBrand(signupBrand).key === 'taml';
}

export function miaImageUrl(scene: MiaEmailScene): string {
  return `${MIA_ASSET_BASE_URL}/${MIA_SCENES[scene].image}`;
}

export function miaLine(
  scene: MiaEmailScene,
  locale: EmailLocale,
  vars: Record<string, string | number> = {},
): string {
  return MIA_SCENES[scene].line[locale].replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}

/** Foto que substitui a da cena: só https (e-mail não carrega http nem data:). */
function safeImageOverride(url: string | null | undefined): string | null {
  return typeof url === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : null;
}

/** WhatsApp do suporte da The AI Model Lab: o mesmo número das páginas de obrigado e dos e-mails do pack. */

/** Texto que já vai escrito na conversa. Neutro de propósito: fica no histórico do WhatsApp. */
const MIA_TALK_TEXT: Record<EmailLocale, string> = {
  'pt-BR': 'MIA · Quero criar a minha modelo com a sua ajuda.',
  es: 'MIA · Quiero crear mi modelo con tu ayuda.',
  en: 'MIA · I want to create my model with your help.',
};

/** Partes da linha de conversa: antes do link, o link e depois dele. */
const MIA_TALK_COPY: Record<EmailLocale, { before: string; link: string; after: string }> = {
  'pt-BR': { before: '💬 Quer fazer junto? ', link: 'Me chama no WhatsApp', after: ' ou responda este e-mail.' },
  es: { before: '💬 ¿Lo hacemos juntos? ', link: 'Escríbeme por WhatsApp', after: ' o responde este correo.' },
  en: { before: '💬 Want to do it together? Just reply to this e-mail, or ', link: 'message me on WhatsApp', after: '.' },
};

/** A linha de conversa sai por padrão; `MIA_X1_EMAIL=off` desliga sem deploy de código. */
export function miaTalkEnabled(): boolean {
  return (process.env.MIA_X1_EMAIL ?? 'on').trim().toLowerCase() !== 'off';
}

/** Link do WhatsApp do suporte com a palavra MIA no texto, no idioma da conta (MIA_X1_WA_URL = link único dos 2 números). */
export function miaTalkUrl(locale: EmailLocale): string {
  return `${supportWaBase()}?text=${encodeURIComponent(MIA_TALK_TEXT[locale]).replace(/'/g, '%27')}`;
}

function miaTalkLine(locale: EmailLocale): string {
  if (!miaTalkEnabled()) return '';
  const copy = MIA_TALK_COPY[locale];
  const link = `<a href="${miaTalkUrl(locale)}" style="color:#1a1a1a;font-weight:600;text-decoration:underline;">${escapeHtml(copy.link)}</a>`;
  return `<p style="margin:12px 0 0;font-size:14px;color:#444;line-height:1.5;text-align:center;">${escapeHtml(copy.before)}${link}${escapeHtml(copy.after)}</p>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Bloco HTML (numa linha só, seguido de linha em branco) para abrir o corpo em Markdown: o `marked` passa HTML
 * de bloco adiante sem mexer, e a tabela centraliza a foto também no Outlook. Os estilos ficam no próprio bloco
 * porque o render ainda injeta os de tabela (borda na td) e os nossos, que vêm depois, valem por cima.
 * Vazio quando a Mia está desligada.
 */
export function miaEmailBlock(
  scene: MiaEmailScene,
  locale: EmailLocale,
  options: EmailVisualOptions = {},
): string {
  if (options.mia === false) return '';
  const line = escapeHtml(miaLine(scene, locale, options.lineVars));
  const imageSrc = safeImageOverride(options.imageUrl) ?? miaImageUrl(scene);
  const who = escapeHtml(options.signature?.trim() || 'Mia');
  const image = `<img src="${imageSrc}" alt="${who}" width="${MIA_IMAGE_WIDTH}" style="display:block;margin:0 auto;width:${MIA_IMAGE_WIDTH}px;max-width:100%;height:auto;border:0;border-radius:16px;">`;
  const speech = `<p style="margin:14px 0 0;font-size:16px;font-style:italic;color:#1a1a1a;line-height:1.5;text-align:center;">“${line}”</p>`;
  const signature = `<p style="margin:4px 0 0;font-size:13px;color:#999;text-align:center;">${who}</p>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;"><tr><td align="center" style="border:0;padding:0;">${image}${speech}${signature}${miaTalkLine(locale)}</td></tr></table>\n\n`;
}
