/**
 * Textos do pacote candy-retencao (24/11/2026), nos 3 idiomas: e-mail (Markdown, mesmo pipeline do lifecycle) e
 * frase do sino. A Mia abre cada e-mail (foto + fala submissa, mia-email.ts); conta de outra marca recebe sem ela.
 *
 * - L04 renovação recusada (Perfect Pay/Cakto): D0, D3 e D7. Molde Baremetrics Q3/2026 (203.756 cobranças: e-mail D0
 *   recupera 32%, D3 33%, D7 24%; mediana de recuperação 29,4%).
 * - L10 "sua modelo está esperando": a última criação da própria cliente, sem gerar nada novo (molde Candy, toggle
 *   "Proactive Media").
 * - L17 lembrete 3 dias antes de renovar, com o nome na fatura (molde Candy: "Charge shown as EverAI").
 * Números só reais (saldo, preço pago, créditos usados): nada inventado.
 */

import type { EmailLocale } from './onboarding-sequence-templates';
import { miaEmailBlock, type EmailVisualOptions } from './mia-email';
import { descriptorSentence } from '../payments/billing-descriptor';

const NUMBER_LOCALE: Record<EmailLocale, string> = { 'pt-BR': 'pt-BR', en: 'en-US', es: 'es-419' };

export function formatCredits(value: number, locale: EmailLocale): string {
  return Math.max(0, Math.floor(value)).toLocaleString(NUMBER_LOCALE[locale]);
}

/** Dia e mês por extenso curto no idioma da conta, no fuso de Brasília (a régua é da operação). */
export function formatShortDate(date: Date, locale: EmailLocale): string {
  return new Intl.DateTimeFormat(NUMBER_LOCALE[locale], {
    day: 'numeric',
    month: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(date);
}

/** Valor pago na moeda da cobrança: R$ 49,90 / US$ 19.90. */
export function formatMoney(amountCents: number, currency: string, locale: EmailLocale): string {
  const code = (currency || 'USD').toUpperCase();
  try {
    return new Intl.NumberFormat(code === 'BRL' ? 'pt-BR' : NUMBER_LOCALE[locale], {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 2,
    }).format(amountCents / 100);
  } catch {
    return `${code} ${(amountCents / 100).toFixed(2)}`;
  }
}

function button(label: string, url: string): string {
  return `[${label} →](${url})`;
}

// ────────────────────────────────────────────────────────
// L04 · Renovação recusada (D0 · D3 · D7)
// ────────────────────────────────────────────────────────

export type RenewalRecoveryStep = 'd0' | 'd3' | 'd7';

export interface RenewalDeclinedData {
  planName: string;
  /** Saldo guardado na conta (plano + bônus) na hora do envio. 0 = a frase fala só das criações. */
  savedCredits: number;
  /** Link de pagar em 1 toque (pré-pago de 30 d do mesmo plano, ou a vitrine). */
  payUrl: string;
  /** Bônus de volta (só D7): créditos e prazo. 0 = sem bônus, o D7 não sai. */
  bonusCredits: number;
  bonusDeadline: Date | null;
}

function savedLine(data: RenewalDeclinedData, locale: EmailLocale): string {
  const credits = formatCredits(data.savedCredits, locale);
  if (locale === 'en') {
    return data.savedCredits > 0
      ? `Your **${credits} credits** and your creations are saved.`
      : 'Your creations are saved.';
  }
  if (locale === 'es') {
    return data.savedCredits > 0
      ? `Tus **${credits} créditos** y tus creaciones siguen guardados.`
      : 'Tus creaciones siguen guardadas.';
  }
  return data.savedCredits > 0
    ? `Seus **${credits} créditos** e suas criações estão guardados.`
    : 'Suas criações estão guardadas.';
}

export function buildRenewalDeclinedEmail(
  step: RenewalRecoveryStep,
  data: RenewalDeclinedData,
  locale: EmailLocale = 'pt-BR',
  options: EmailVisualOptions = {},
): { subject: string; body: string } {
  const deadline = data.bonusDeadline ? formatShortDate(data.bonusDeadline, locale) : '';
  const bonus = formatCredits(data.bonusCredits, locale);
  const mia =
    step === 'd7'
      ? miaEmailBlock('renewal_bonus', locale, { ...options, lineVars: { date: deadline, bonus } })
      : miaEmailBlock('renewal_failed', locale, options);
  const saved = savedLine(data, locale);
  const plan = data.planName;

  if (locale === 'en') {
    const cta = button('Renew now', data.payUrl);
    if (step === 'd7') {
      return {
        subject: `+${bonus} credits if you come back by ${deadline}`,
        body: `${mia}{{firstName}}, your ${plan} renewal is still pending. ${saved}

Come back by **${deadline}** and get **+${bonus} credits** on top of your plan.

${cta}

— The AI Model Lab team`,
      };
    }
    const extra = step === 'd3' ? '\n\nIf the card keeps failing, pay with **Google Pay or another card**: it takes 1 minute.' : '';
    return {
      subject: step === 'd3' ? `Your ${plan} is still waiting, {{firstName}}` : `Your bank declined the ${plan} renewal`,
      body: `${mia}{{firstName}}, your bank declined the **${plan}** renewal. ${saved} Pay in 1 tap and keep going.${extra}

${cta}

— The AI Model Lab team`,
    };
  }

  if (locale === 'es') {
    const cta = button('Renovar ahora', data.payUrl);
    if (step === 'd7') {
      return {
        subject: `+${bonus} créditos si vuelves antes del ${deadline}`,
        body: `${mia}{{firstName}}, la renovación de tu ${plan} sigue pendiente. ${saved}

Vuelve antes del **${deadline}** y gana **+${bonus} créditos** además de tu plan.

${cta}

— Equipo AI Model Lab`,
      };
    }
    const extra = step === 'd3' ? '\n\nSi la tarjeta sigue fallando, paga con **Google Pay u otra tarjeta**: es 1 minuto.' : '';
    return {
      subject: step === 'd3' ? `Tu ${plan} te sigue esperando, {{firstName}}` : `Tu banco rechazó la renovación de ${plan}`,
      body: `${mia}{{firstName}}, tu banco rechazó la renovación de **${plan}**. ${saved} Paga en 1 toque y sigue.${extra}

${cta}

— Equipo AI Model Lab`,
    };
  }

  const cta = button('Renovar agora', data.payUrl);
  if (step === 'd7') {
    return {
      subject: `+${bonus} créditos se você voltar até ${deadline}`,
      body: `${mia}{{firstName}}, a renovação do seu ${plan} ainda está pendente. ${saved}

Volte até **${deadline}** e ganhe **+${bonus} créditos** além do seu plano.

${cta}

— Equipe AI Model Lab`,
    };
  }
  const extra = step === 'd3' ? '\n\nSe o cartão continuar falhando, pague pelo **Google Pay ou outro cartão**: leva 1 minuto.' : '';
  return {
    subject: step === 'd3' ? `Seu ${plan} continua te esperando, {{firstName}}` : `Seu banco recusou a renovação do ${plan}`,
    body: `${mia}{{firstName}}, seu banco recusou a renovação do **${plan}**. ${saved} Pague em 1 toque e continue.${extra}

${cta}

— Equipe AI Model Lab`,
  };
}

/** Frase do sino da recusa (o botão vem do `ctaLabel`). */
export function renewalDeclinedBellText(step: RenewalRecoveryStep, data: RenewalDeclinedData, locale: EmailLocale): string {
  const deadline = data.bonusDeadline ? formatShortDate(data.bonusDeadline, locale) : '';
  const bonus = formatCredits(data.bonusCredits, locale);
  if (step === 'd7') {
    if (locale === 'en') return `Come back by ${deadline} and get +${bonus} credits.`;
    if (locale === 'es') return `Vuelve antes del ${deadline} y gana +${bonus} créditos.`;
    return `Volte até ${deadline} e ganhe +${bonus} créditos.`;
  }
  const saved = savedLine(data, locale).replace(/\*\*/g, '');
  if (locale === 'en') return `Your bank declined the ${data.planName} renewal. ${saved} Pay in 1 tap and keep going.`;
  if (locale === 'es') return `Tu banco rechazó la renovación de ${data.planName}. ${saved} Paga en 1 toque y sigue.`;
  return `Seu banco recusou a renovação do ${data.planName}. ${saved} Pague em 1 toque e continue.`;
}

export function renewCtaLabel(locale: EmailLocale): string {
  if (locale === 'en') return 'Renew now';
  if (locale === 'es') return 'Renovar ahora';
  return 'Renovar agora';
}

/** Sino quando ela volta dentro do prazo e o bônus cai. */
export function recoveryBonusBellText(bonusCredits: number, locale: EmailLocale): string {
  const bonus = formatCredits(bonusCredits, locale);
  if (locale === 'en') return `Welcome back 😏 +${bonus} credits are already in your account.`;
  if (locale === 'es') return `Bienvenido de vuelta 😏 +${bonus} créditos ya están en tu cuenta.`;
  return `Que bom que você voltou 😏 +${bonus} créditos já estão na sua conta.`;
}

// ────────────────────────────────────────────────────────
// L10 · Sua modelo está esperando
// ────────────────────────────────────────────────────────

export interface ModelWaitingData {
  modelName: string;
  /** Última criação dela (https). */
  imageUrl: string;
  /** Abre o gerador já com a mesma receita. */
  ctaUrl: string;
  /** Créditos que a mesma receita custa (o que ela pagou da última vez). 0 = o botão não mostra o valor. */
  cost: number;
}

export function modelWaitingTitle(modelName: string, locale: EmailLocale): string {
  if (locale === 'en') return `${modelName} is waiting for you · Want more like this?`;
  if (locale === 'es') return `${modelName} te está esperando · ¿Quieres más como esta?`;
  return `${modelName} está esperando você · Quer mais como esta?`;
}

export function modelWaitingCtaLabel(cost: number, locale: EmailLocale): string {
  const value = formatCredits(cost, locale);
  if (locale === 'en') return cost > 0 ? `Make more like this · ${value} credits` : 'Make more like this';
  if (locale === 'es') return cost > 0 ? `Generar más como esta · ${value} créditos` : 'Generar más como esta';
  return cost > 0 ? `Gerar mais como esta · ${value} créditos` : 'Gerar mais como esta';
}

export function buildModelWaitingEmail(
  data: ModelWaitingData,
  locale: EmailLocale = 'pt-BR',
  options: EmailVisualOptions = {},
): { subject: string; body: string } {
  // a foto é a dela mesmo com a Mia desligada (conta de outra marca): é o conteúdo do e-mail, não a persona
  const visual =
    options.mia === false
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;"><tr><td align="center" style="border:0;padding:0;"><img src="${data.imageUrl}" alt="" width="300" style="display:block;margin:0 auto;width:300px;max-width:100%;height:auto;border:0;border-radius:16px;"></td></tr></table>\n\n`
      : miaEmailBlock('model_waiting', locale, { ...options, imageUrl: data.imageUrl, signature: data.modelName });
  const cta = button(modelWaitingCtaLabel(data.cost, locale), data.ctaUrl);
  const unsubscribe =
    locale === 'en'
      ? 'Rather not get these? Turn off "Get photos from my model" in your account.'
      : locale === 'es'
        ? '¿Prefieres no recibir esto? Apaga "Recibir fotos de mi modelo" en tu cuenta.'
        : 'Prefere não receber? Desligue "Receber fotos da minha modelo" na sua conta.';
  return {
    subject: modelWaitingTitle(data.modelName, locale),
    body: `${visual}${cta}

<p style="margin:24px 0 0;font-size:12px;color:#999;">${unsubscribe}</p>`,
  };
}

// ────────────────────────────────────────────────────────
// L17 · Lembrete 3 dias antes de renovar
// ────────────────────────────────────────────────────────

export interface RenewalReminderData {
  planName: string;
  renewAt: Date;
  /** Valor da última cobrança desta assinatura (o que vai ser cobrado de novo). */
  amountCents: number;
  currency: string;
  /** Nome na fatura; null = a frase não sai. */
  descriptor: string | null;
  /** Créditos usados neste ciclo (creditBalance.planCreditsUsed). */
  creditsUsed: number;
  manageUrl: string;
}

export function buildRenewalReminderEmail(
  data: RenewalReminderData,
  locale: EmailLocale = 'pt-BR',
  options: EmailVisualOptions = {},
): { subject: string; body: string } {
  const mia = miaEmailBlock('renewal_reminder', locale, options);
  const date = formatShortDate(data.renewAt, locale);
  const price = formatMoney(data.amountCents, data.currency, locale);
  const used = formatCredits(data.creditsUsed, locale);

  if (locale === 'en') {
    const desc = data.descriptor ? ` It shows on your statement as **${data.descriptor}**.` : '';
    return {
      subject: `Your ${data.planName} renews on ${date}`,
      body: `${mia}{{firstName}}, your **${data.planName}** renews on **${date}** for **${price}**.${desc} You used **${used} credits** this month.

${button('Manage subscription', data.manageUrl)}

— The AI Model Lab team`,
    };
  }
  if (locale === 'es') {
    const desc = data.descriptor ? ` En tu estado de cuenta aparece como **${data.descriptor}**.` : '';
    return {
      subject: `Tu ${data.planName} se renueva el ${date}`,
      body: `${mia}{{firstName}}, tu **${data.planName}** se renueva el **${date}** por **${price}**.${desc} Usaste **${used} créditos** este mes.

${button('Gestionar suscripción', data.manageUrl)}

— Equipo AI Model Lab`,
    };
  }
  const desc = data.descriptor ? ` Na fatura aparece **${data.descriptor}**.` : '';
  return {
    subject: `Seu ${data.planName} renova em ${date}`,
    body: `${mia}{{firstName}}, seu **${data.planName}** renova em **${date}** por **${price}**.${desc} Você usou **${used} créditos** este mês.

${button('Gerenciar assinatura', data.manageUrl)}

— Equipe AI Model Lab`,
  };
}

/**
 * L17: frase do nome na fatura no fim do e-mail de ativação (antes da assinatura "— Equipe"). Sem descritor, o texto
 * volta idêntico.
 */
export function withDescriptorLine(body: string, locale: EmailLocale, descriptor: string | null): string {
  if (!descriptor) return body;
  const line = `_${descriptorSentence(locale, descriptor)}_`;
  const signatureAt = body.lastIndexOf('\n\n— ');
  if (signatureAt === -1) return `${body}\n\n${line}`;
  return `${body.slice(0, signatureAt)}\n\n${line}${body.slice(signatureAt)}`;
}
