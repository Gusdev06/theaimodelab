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
 * - A imagem não é link: o e-mail continua com um único CTA.
 */

import { resolveBrand } from '../brand/brand';
import type { EmailLocale } from './onboarding-sequence-templates';

/** Pasta pública das MIAs no funis (`funis/public/assets/mia`). */
export const MIA_ASSET_BASE_URL = 'https://assets.theaimodelab.com/assets/mia';

/** Largura em que a foto (retrato 3:4, 1080x1440) aparece no e-mail. */
const MIA_IMAGE_WIDTH = 300;

export type MiaEmailScene = 'welcome' | 'activation' | 'low_balance' | 'credits_depleted' | 'winback';

/** Opções visuais dos e-mails automáticos. Sem opção = com a Mia (a marca de origem). */
export interface EmailVisualOptions {
  mia?: boolean;
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
};

/** A Mia entra só na marca de origem (The AI Model Lab). */
export function showMiaFor(signupBrand: string | null | undefined): boolean {
  return resolveBrand(signupBrand).key === 'taml';
}

export function miaImageUrl(scene: MiaEmailScene): string {
  return `${MIA_ASSET_BASE_URL}/${MIA_SCENES[scene].image}`;
}

export function miaLine(scene: MiaEmailScene, locale: EmailLocale): string {
  return MIA_SCENES[scene].line[locale];
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
  const line = escapeHtml(miaLine(scene, locale));
  const image = `<img src="${miaImageUrl(scene)}" alt="Mia" width="${MIA_IMAGE_WIDTH}" style="display:block;margin:0 auto;width:${MIA_IMAGE_WIDTH}px;max-width:100%;height:auto;border:0;border-radius:16px;">`;
  const speech = `<p style="margin:14px 0 0;font-size:16px;font-style:italic;color:#1a1a1a;line-height:1.5;text-align:center;">“${line}”</p>`;
  const signature = `<p style="margin:4px 0 0;font-size:13px;color:#999;text-align:center;">Mia</p>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;"><tr><td align="center" style="border:0;padding:0;">${image}${speech}${signature}</td></tr></table>\n\n`;
}
