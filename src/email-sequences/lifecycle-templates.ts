/**
 * Templates dos emails de lifecycle de monetização.
 *
 * Diferente das sequências de onboarding (day-based, corpo estático), estes são
 * emails GATILHADOS por estado da conta (saldo, ciclo, cancelamento) e o corpo
 * depende de números dinâmicos (créditos restantes, gerações possíveis, preço do
 * tier acima, dias restantes do ciclo). Por isso cada template é uma função que
 * recebe os dados já calculados pelo cron + o idioma do destinatário
 * (`resolveEmailLocale(user.locale)`).
 *
 * Corpo em Markdown — passa pelo mesmo pipeline dos broadcasts do admin
 * (renderMarkdownToEmailHtml + wrapInBroadcastTemplate + merge tags
 * {{firstName}}, {{name}}, {{plan}}).
 *
 * Assuntos curtos, tom direto, sem urgência falsa nem dark pattern.
 * O CTA sempre aponta pra /creditos (upgrade / compra de pacote).
 *
 * Custos de referência (aprox., ver CLAUDE.md — tabela credit_costs):
 *   - Imagem Full HD: ~90 créditos (arredondamos "imagem" pra ~60–90 conforme
 *     resolução; usamos 90 como base conservadora pra não prometer a mais).
 *   - Vídeo Veo 8s: a partir de ~600 créditos.
 * Esses valores só alimentam a copy ("quanto ainda rende") — o débito real
 * continua vindo da tabela credit_costs.
 */

import type { EmailLocale } from './onboarding-sequence-templates';

export type LifecycleSequenceName = 'lifecycle';

/** Custos de referência p/ traduzir créditos em "quantas gerações ainda dá". */
export const CREDITS_PER_IMAGE = 90;
export const CREDITS_PER_VIDEO = 600;

/** Intl locale usado pra formatar números na copy de cada idioma. */
const NUMBER_LOCALE: Record<EmailLocale, string> = {
  'pt-BR': 'pt-BR',
  en: 'en-US',
  es: 'es-419',
};

function fmt(n: number, locale: EmailLocale): string {
  return n.toLocaleString(NUMBER_LOCALE[locale]);
}

function formatUsd(value: number, locale: EmailLocale): string {
  const fixed = value.toFixed(2);
  return locale === 'pt-BR' ? `$${fixed.replace('.', ',')}` : `$${fixed}`;
}

// ────────────────────────────────────────────────────────
// Email 1 — Saldo baixo
// ────────────────────────────────────────────────────────

export interface LowBalanceData {
  appUrl: string;
  /** Saldo total disponível (plano + bônus). */
  totalCredits: number;
  /** Cota mensal do plano atual (plan.creditsPerMonth). */
  monthlyCredits: number;
}

/**
 * Traduz um saldo de créditos em quantas gerações ainda dá, em linguagem natural.
 */
function creditsToGenerations(totalCredits: number, locale: EmailLocale): string {
  const images = Math.floor(totalCredits / CREDITS_PER_IMAGE);
  const canDoVideo = totalCredits >= CREDITS_PER_VIDEO;

  if (locale === 'en') {
    if (images <= 0 && !canDoVideo) return 'no longer cover a full generation';
    const imgPart =
      images > 0
        ? `still cover about **${images} ${images === 1 ? 'image' : 'images'}**`
        : 'no longer cover a Full HD image';
    const videoPart = canDoVideo ? ', or one short video' : ", but no longer cover a video";
    return `${imgPart}${videoPart}`;
  }

  if (locale === 'es') {
    if (images <= 0 && !canDoVideo) return 'ya no cubren una generación completa';
    const imgPart =
      images > 0
        ? `todavía alcanzan para unas **${images} ${images === 1 ? 'imagen' : 'imágenes'}**`
        : 'ya no cubren una imagen en Full HD';
    const videoPart = canDoVideo ? ', o un video corto' : ', pero ya no cubren un video';
    return `${imgPart}${videoPart}`;
  }

  if (images <= 0 && !canDoVideo) {
    return 'já não cobrem uma geração completa';
  }
  const imgPart =
    images > 0
      ? `ainda rendem cerca de **${images} ${images === 1 ? 'imagem' : 'imagens'}**`
      : 'já não cobrem uma imagem em Full HD';
  const videoPart = canDoVideo ? ', ou um vídeo curto' : ', mas já não cobrem mais 1 vídeo';
  return `${imgPart}${videoPart}`;
}

export function buildLowBalanceEmail(
  data: LowBalanceData,
  locale: EmailLocale = 'pt-BR',
): {
  subject: string;
  body: string;
} {
  const gens = creditsToGenerations(data.totalCredits, locale);
  const credits = fmt(data.totalCredits, locale);

  if (locale === 'en') {
    return {
      subject: 'Your credits are running low, {{firstName}}',
      body: `{{firstName}}, your credits for this month are almost gone.

You have **${credits} credits** left — they ${gens}.

If you still have content to produce this cycle, there are two ways to solve it:

- **Upgrade your plan** — more credits per month, lower cost per generation
- **Buy a credit pack** — one-off credits that **never expire** and stack on top of your balance

[See plans and packs →](${data.appUrl}/creditos)

Your plan credits renew automatically next cycle — so if you'd rather wait, just pick up where you left off when they renew.

— The AI Model Lab team`,
    };
  }

  if (locale === 'es') {
    return {
      subject: 'Tus créditos se están acabando, {{firstName}}',
      body: `{{firstName}}, tus créditos del mes están llegando al final.

Tienes **${credits} créditos** disponibles — ${gens}.

Si todavía tienes contenido por producir en este ciclo, hay dos formas de resolverlo:

- **Subir de plan** — más créditos por mes, menor costo por generación
- **Comprar un pack de créditos** — créditos sueltos que **nunca expiran** y se suman a tu saldo

[Ver planes y packs →](${data.appUrl}/creditos)

Tus créditos del plan se renuevan automáticamente en el próximo ciclo — si prefieres esperar, solo continúa donde quedaste cuando se renueven.

— Equipo AI Model Lab`,
    };
  }

  return {
    subject: 'Seus créditos estão acabando, {{firstName}}',
    body: `{{firstName}}, seus créditos do mês estão chegando ao fim.

Você tem **${credits} créditos** disponíveis — eles ${gens}.

Se você ainda tem conteúdo pra produzir neste ciclo, dá pra resolver de dois jeitos:

- **Fazer upgrade de plano** — mais créditos por mês, custo por geração menor
- **Comprar um pacote de créditos** — créditos avulsos que **nunca expiram** e se somam ao seu saldo

[Ver planos e pacotes →](${data.appUrl}/creditos)

Seus créditos do plano renovam automaticamente no próximo ciclo — então se preferir esperar, é só continuar de onde parou quando renovar.

— Equipe AI Model Lab`,
  };
}

// ────────────────────────────────────────────────────────
// Email 2 — Créditos esgotados no meio do ciclo
// ────────────────────────────────────────────────────────

export interface CreditsDepletedData {
  appUrl: string;
  /** Cota mensal do plano atual (plan.creditsPerMonth). */
  monthlyCredits: number;
  /** Dias entre o início do ciclo e hoje (quanto tempo levou pra zerar). */
  daysUsed: number;
  /** Dias restantes até a renovação do plano. */
  daysUntilRenewal: number;
  /** Tier imediatamente acima, se existir. */
  upgrade: {
    name: string;
    creditsPerMonth: number;
    /** Preço em USD (priceCents / 100), lido do Plan no banco. */
    priceUsd: number;
  } | null;
}

export function buildCreditsDepletedEmail(
  data: CreditsDepletedData,
  locale: EmailLocale = 'pt-BR',
): {
  subject: string;
  body: string;
} {
  const monthly = fmt(data.monthlyCredits, locale);

  if (locale === 'en') {
    const usedLine =
      data.daysUsed <= 1
        ? `You went through your **${monthly} credits** for the month in less than a day`
        : `You went through your **${monthly} credits** for the month in **${data.daysUsed} days**`;

    const upgradeBlock = data.upgrade
      ? `**Upgrade now** — the ${data.upgrade.name} plan gives you **${fmt(
          data.upgrade.creditsPerMonth,
          locale,
        )} credits/month** for ${formatUsd(
          data.upgrade.priceUsd,
          locale,
        )}. If you burned through your current plan before mid-cycle, the next tier usually works out cheaper per generation.

`
      : '';

    return {
      subject: `You've used everything, and there are still ${data.daysUntilRenewal} days left`,
      body: `{{firstName}}, ${usedLine} — and there are still **${data.daysUntilRenewal} days** until your plan renews.

That's usually a good sign: it means you're producing at pace. To avoid sitting idle until next cycle, you have two options:

${upgradeBlock}**Buy a credit pack** — one-off credits that **never expire**. Use them whenever you want, without touching your plan.

[See options →](${data.appUrl}/creditos)

Or just wait it out: your plan credits renew in ${data.daysUntilRenewal} days.

— The AI Model Lab team`,
    };
  }

  if (locale === 'es') {
    const usedLine =
      data.daysUsed <= 1
        ? `Usaste tus **${monthly} créditos** del mes en menos de un día`
        : `Usaste tus **${monthly} créditos** del mes en **${data.daysUsed} días**`;

    const upgradeBlock = data.upgrade
      ? `**Subir de plan ahora** — el plan ${data.upgrade.name} te da **${fmt(
          data.upgrade.creditsPerMonth,
          locale,
        )} créditos/mes** por ${formatUsd(
          data.upgrade.priceUsd,
          locale,
        )}. Si agotaste tu plan actual antes de la mitad del ciclo, el siguiente tier suele salir más barato por generación.

`
      : '';

    return {
      subject: `Usaste todo, y todavía faltan ${data.daysUntilRenewal} días`,
      body: `{{firstName}}, ${usedLine} — y todavía faltan **${data.daysUntilRenewal} días** para la renovación de tu plan.

Normalmente es buena señal: significa que estás produciendo con ritmo. Para no quedarte parado hasta el próximo ciclo, tienes dos opciones:

${upgradeBlock}**Comprar un pack de créditos** — créditos sueltos que **nunca expiran**. Los usas cuando quieras, sin tocar tu plan.

[Ver opciones →](${data.appUrl}/creditos)

Si prefieres, solo espera: tus créditos del plan se renuevan en ${data.daysUntilRenewal} días.

— Equipo AI Model Lab`,
    };
  }

  const usedLine =
    data.daysUsed <= 1
      ? `Você usou seus **${monthly} créditos** do mês em menos de um dia`
      : `Você usou seus **${monthly} créditos** do mês em **${data.daysUsed} dias**`;

  const upgradeBlock = data.upgrade
    ? `**Fazer upgrade agora** — o plano ${data.upgrade.name} te dá **${fmt(
        data.upgrade.creditsPerMonth,
        locale,
      )} créditos/mês** por ${formatUsd(
        data.upgrade.priceUsd,
        locale,
      )}. Se você já esgotou o plano atual antes da metade do ciclo, o próximo tier costuma sair mais barato por geração.

`
    : '';

  return {
    subject: `Você usou tudo, e ainda faltam ${data.daysUntilRenewal} dias`,
    body: `{{firstName}}, ${usedLine} — e ainda faltam **${data.daysUntilRenewal} dias** até a renovação do seu plano.

Isso normalmente é um bom sinal: significa que você está produzindo em ritmo. Pra não ficar parado até o próximo ciclo, você tem duas opções:

${upgradeBlock}**Comprar um pacote de créditos** — créditos avulsos que **nunca expiram**. Você usa quando quiser, sem mexer no seu plano.

[Ver opções →](${data.appUrl}/creditos)

Se preferir, é só aguardar: seus créditos do plano renovam em ${data.daysUntilRenewal} dias.

— Equipe AI Model Lab`,
  };
}

// ────────────────────────────────────────────────────────
// Email 3 — Winback pós-cancelamento / expiração
// ────────────────────────────────────────────────────────

export interface WinbackData {
  appUrl: string;
  /** Nº de gerações concluídas pelo usuário, se disponível. */
  generationsCount: number;
}

export function buildWinbackEmail(
  data: WinbackData,
  locale: EmailLocale = 'pt-BR',
): {
  subject: string;
  body: string;
} {
  const count = fmt(data.generationsCount, locale);

  if (locale === 'en') {
    const createdLine =
      data.generationsCount > 0
        ? `During your time here you created **${count} ${
            data.generationsCount === 1 ? 'generation' : 'generations'
          }** — your persona, your photos, your content.`
        : "Your account is still here, with everything you've already set up.";

    return {
      subject: 'Your account is still here, {{firstName}}',
      body: `{{firstName}}, it's been a week since your plan expired.

${createdLine}

None of it is lost — your account and your history are safe. Whenever you want to produce again, just reactivate a plan and your credits are available instantly.

[Reactivate my plan →](${data.appUrl}/creditos)

If it doesn't make sense right now, that's okay. The door stays open.

— The AI Model Lab team`,
    };
  }

  if (locale === 'es') {
    const createdLine =
      data.generationsCount > 0
        ? `En tu paso por aquí creaste **${count} ${
            data.generationsCount === 1 ? 'generación' : 'generaciones'
          }** — tu persona, tus fotos, tu contenido.`
        : 'Tu cuenta sigue aquí, con todo lo que ya configuraste.';

    return {
      subject: 'Tu cuenta sigue aquí, {{firstName}}',
      body: `{{firstName}}, hace una semana que tu plan expiró.

${createdLine}

Nada de eso se pierde — tu cuenta y tu historial siguen guardados. Cuando quieras volver a producir, solo reactiva un plan y tus créditos quedan disponibles al instante.

[Reactivar mi plan →](${data.appUrl}/creditos)

Si por ahora no tiene sentido, está bien. La puerta queda abierta.

— Equipo AI Model Lab`,
    };
  }

  const createdLine =
    data.generationsCount > 0
      ? `Na sua passagem por aqui você criou **${count} ${
          data.generationsCount === 1 ? 'geração' : 'gerações'
        }** — sua persona, suas fotos, seu conteúdo.`
      : 'Sua conta continua aqui, com tudo que você já configurou.';

  return {
    subject: 'Sua conta continua aqui, {{firstName}}',
    body: `{{firstName}}, faz uma semana que seu plano expirou.

${createdLine}

Nada disso se perde — sua conta e seu histórico continuam salvos. Quando quiser voltar a produzir, é só reativar um plano e seus créditos ficam disponíveis na hora.

[Reativar meu plano →](${data.appUrl}/creditos)

Se por enquanto não faz sentido, tudo bem. A porta fica aberta.

— Equipe AI Model Lab`,
  };
}
