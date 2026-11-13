import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { applyBrand, Brand, brandedFrom, firstUrl, ORIGIN_SITE_URL, ORIGIN_SUPPORT_EMAIL } from '../brand/brand';
import {
  brandBannerUrl,
  escapeHtml,
  MailLocale,
  renderBrandEmail,
  sitePathFor,
  withQuery,
} from './brand-email';
import type { BuyerLocale } from '../pending-grants/buyer-locale';
import { formatAffiliatePayoutAmount } from '../affiliates/affiliate-currency';
import { describePayoutDestination } from '../affiliates/affiliate-payout';

/** Textos do e-mail de acesso da isca, por idioma do comprador (TKT-004). */
interface PendingGrantsCopy {
  htmlLang: string;
  /** Prefixo da rota do site: o /login sem prefixo cai no português. */
  sitePath: 'en' | 'es' | 'pt-br';
  subject: string;
  greeting: (name: string | null) => string;
  title: string;
  intro: string;
  includedLabel: string;
  items: string[];
  claim: string;
  button: string;
  important: string;
  footer: string;
  /** Itens do bundle do CURSO (Perfect Pay e Greenn: 2 de cada modelo, 38 no total). */
  courseItems: string[];
}

/** Qual pacote de gerações a compra libera: curso (Perfect Pay/Greenn) ou o básico (Hubla/Hotmart/Cartpanda). */
export type PendingGrantsVariant = 'course' | 'basic';

/** Saldo a partir do qual a 1ª foto já sai paga (decisão do dono, 13/11: bônus total de 200). */
export const FIRST_PHOTO_PAID_CREDITS = 200;

export const PENDING_GRANTS_COPY: Record<BuyerLocale, PendingGrantsCopy> = {
  en: {
    htmlLang: 'en',
    sitePath: 'en',
    subject: 'You earned free generations on The AI Model Lab! 🎉',
    greeting: (name) => (name ? `Hi, ${name}!` : 'Hi!'),
    title: 'You earned free generations 🎁',
    intro:
      "Thanks for your purchase. We've set aside a pack of <strong>free generations</strong> for your account on The AI Model Lab.",
    includedLabel: 'Included',
    items: [
      '1 Nano Banana 2 generation',
      '1 Nano Banana Pro generation',
      '1 Face Swap',
      '1 Virtual Try-On',
      '1 Veo 3.1 Fast',
      '1 Upscale',
    ],
    claim:
      "To claim them, create your account now using <strong>this same email</strong>. They'll be added to your account automatically after you sign up.",
    button: 'Create my account and claim',
    important:
      "Important: sign up with the same email this message was sent to — otherwise the generations can't be credited.",
    footer: "Any questions? Just reply to this email and we'll help you out.",
    courseItems: [
      '<strong>38 free generations</strong>: 2 with every model',
      'Uncensored photos and premium models',
      'Videos with Veo 3.1 and Kling',
      'Face swap, virtual try-on and Motion Control',
      'Upscale to high resolution',
    ],
  },
  es: {
    htmlLang: 'es',
    sitePath: 'es',
    subject: '¡Ganaste generaciones gratis en The AI Model Lab! 🎉',
    greeting: (name) => (name ? `¡Hola, ${name}!` : '¡Hola!'),
    title: 'Ganaste generaciones gratis 🎁',
    intro:
      'Gracias por tu compra. Reservamos un pack de <strong>generaciones gratis</strong> para tu cuenta en The AI Model Lab.',
    includedLabel: 'Incluye',
    items: [
      '1 generación Nano Banana 2',
      '1 generación Nano Banana Pro',
      '1 cambio de rostro (Face Swap)',
      '1 probador virtual (Virtual Try-On)',
      '1 video Veo 3.1 Fast',
      '1 Upscale',
    ],
    claim:
      'Para activarlas, crea tu cuenta ahora con <strong>este mismo correo</strong>. Se suman a tu cuenta automáticamente cuando te registras.',
    button: 'Crear mi cuenta y activar',
    important:
      'Importante: regístrate con el mismo correo al que llegó este mensaje. Con otro correo, las generaciones no se pueden acreditar.',
    footer: '¿Dudas? Responde este correo y te ayudamos.',
    courseItems: [
      '<strong>38 generaciones gratis</strong>: 2 con cada modelo',
      'Fotos sin censura y modelos premium',
      'Videos con Veo 3.1 y Kling',
      'Cambio de rostro, probador virtual y Motion Control',
      'Upscale a alta resolución',
    ],
  },
  pt: {
    htmlLang: 'pt-BR',
    sitePath: 'pt-br',
    subject: 'Você ganhou gerações grátis no The AI Model Lab! 🎉',
    greeting: (name) => (name ? `Oi, ${name}!` : 'Oi!'),
    title: 'Você ganhou gerações grátis 🎁',
    intro:
      'Obrigado pela compra. Reservamos um pacote de <strong>gerações grátis</strong> para a sua conta no The AI Model Lab.',
    includedLabel: 'Inclui',
    items: [
      '1 geração Nano Banana 2',
      '1 geração Nano Banana Pro',
      '1 troca de rosto (Face Swap)',
      '1 provador virtual (Virtual Try-On)',
      '1 vídeo Veo 3.1 Fast',
      '1 Upscale',
    ],
    claim:
      'Para ativar, crie sua conta agora com <strong>este mesmo e-mail</strong>. Elas entram na sua conta automaticamente depois do cadastro.',
    button: 'Criar minha conta e ativar',
    important:
      'Importante: cadastre-se com o mesmo e-mail que recebeu esta mensagem. Com outro e-mail, as gerações não podem ser creditadas.',
    footer: 'Dúvidas? Responda este e-mail e a gente ajuda.',
    courseItems: [
      '<strong>38 gerações grátis</strong>: 2 com cada modelo',
      'Fotos sem censura e modelos premium',
      'Vídeos com Veo 3.1 e Kling',
      'Troca de rosto, provador virtual e Motion Control',
      'Upscale para alta resolução',
    ],
  },
};

/** E-mail do código de confirmação (C-03): o código vai no assunto e no preheader, no idioma da conta. */
const VERIFICATION_COPY: Record<MailLocale, {
  subject: (code: string) => string;
  preheader: (code: string, bonus: number) => string;
  title: string;
  intro: string;
  bonus: (bonus: number) => string;
  button: string;
  note: string;
  footer: string;
}> = {
  pt: {
    subject: (code) => `${code} é seu código · The AI Model Lab`,
    preheader: (code, bonus) =>
      bonus > 0
        ? `Seu código é ${code}. Confirme e libere +${bonus} créditos: sua 1ª foto fica paga.`
        : `Seu código é ${code}. Vale por 15 minutos.`,
    title: 'Confirme seu e-mail',
    intro: 'Digite este código no app para confirmar seu e-mail:',
    bonus: (bonus) => `Confirmou, entram <strong>+${bonus} créditos</strong> na hora e sua 1ª foto fica paga.`,
    button: 'Abrir o app',
    note: 'Vale por 15 minutos. Não compartilhe este código com ninguém.',
    footer: 'Não criou conta na The AI Model Lab? É só ignorar este e-mail.',
  },
  es: {
    subject: (code) => `${code} es tu código · The AI Model Lab`,
    preheader: (code, bonus) =>
      bonus > 0
        ? `Tu código es ${code}. Confirma y libera +${bonus} créditos: tu 1.ª foto queda pagada.`
        : `Tu código es ${code}. Vale por 15 minutos.`,
    title: 'Confirma tu correo',
    intro: 'Escribe este código en la app para confirmar tu correo:',
    bonus: (bonus) => `Al confirmar, entran <strong>+${bonus} créditos</strong> al instante y tu 1.ª foto queda pagada.`,
    button: 'Abrir la app',
    note: 'Vale por 15 minutos. No compartas este código con nadie.',
    footer: '¿No creaste una cuenta en The AI Model Lab? Ignora este correo.',
  },
  en: {
    subject: (code) => `${code} is your code · The AI Model Lab`,
    preheader: (code, bonus) =>
      bonus > 0
        ? `Your code is ${code}. Confirm and unlock +${bonus} credits: your 1st photo is on us.`
        : `Your code is ${code}. Valid for 15 minutes.`,
    title: 'Confirm your email',
    intro: 'Enter this code in the app to confirm your email:',
    bonus: (bonus) => `Once confirmed, <strong>+${bonus} credits</strong> land instantly and your 1st photo is on us.`,
    button: 'Open the app',
    note: 'Valid for 15 minutes. Never share this code with anyone.',
    footer: "Didn't create an account on The AI Model Lab? Just ignore this email.",
  },
};

/** Boas-vindas (D-06): saldo real, "1ª foto paga" e CTA para os Reels. Sem pedir plano. */
const WELCOME_COPY: Record<MailLocale, {
  subjectPaid: string;
  subjectPlain: string;
  preheader: (credits: number) => string;
  title: string;
  creditsLine: (credits: number, paid: boolean) => string;
  plainLine: string;
  howTo: string;
  button: string;
  footer: string;
}> = {
  pt: {
    subjectPaid: 'Sua conta está pronta: a 1ª foto já está paga',
    subjectPlain: 'Sua conta na The AI Model Lab está pronta',
    preheader: (credits) => `Você já tem ${credits} créditos. Abra os Reels e gere em 1 toque.`,
    title: 'Sua conta está pronta',
    creditsLine: (credits, paid) =>
      paid
        ? `Você já tem <strong>${credits} créditos</strong>: sua 1ª foto já está paga.`
        : `Você já tem <strong>${credits} créditos</strong> na conta.`,
    plainLine: 'Seu e-mail está confirmado e sua conta está pronta.',
    howTo: 'Abra os Reels, escolha a cena e toque em gerar. O resultado sai em segundos.',
    button: 'Gerar minha 1ª foto',
    footer: `Dúvidas? Fale com a gente em ${ORIGIN_SUPPORT_EMAIL}.`,
  },
  es: {
    subjectPaid: 'Tu cuenta está lista: la 1.ª foto ya está pagada',
    subjectPlain: 'Tu cuenta en The AI Model Lab está lista',
    preheader: (credits) => `Ya tienes ${credits} créditos. Abre los Reels y genera en 1 toque.`,
    title: 'Tu cuenta está lista',
    creditsLine: (credits, paid) =>
      paid
        ? `Ya tienes <strong>${credits} créditos</strong>: tu 1.ª foto ya está pagada.`
        : `Ya tienes <strong>${credits} créditos</strong> en tu cuenta.`,
    plainLine: 'Tu correo está confirmado y tu cuenta está lista.',
    howTo: 'Abre los Reels, elige la escena y toca generar. El resultado sale en segundos.',
    button: 'Generar mi 1.ª foto',
    footer: `¿Dudas? Escríbenos a ${ORIGIN_SUPPORT_EMAIL}.`,
  },
  en: {
    subjectPaid: 'Your account is ready: your 1st photo is on us',
    subjectPlain: 'Welcome to The AI Model Lab!',
    preheader: (credits) => `You already have ${credits} credits. Open Reels and generate in 1 tap.`,
    title: 'Your account is ready',
    creditsLine: (credits, paid) =>
      paid
        ? `You already have <strong>${credits} credits</strong>: your 1st photo is on us.`
        : `You already have <strong>${credits} credits</strong> in your account.`,
    plainLine: 'Your email is confirmed and your account is ready.',
    howTo: 'Open Reels, pick a scene and tap generate. Your result is ready in seconds.',
    button: 'Generate my 1st photo',
    footer: `Questions? Write to us at ${ORIGIN_SUPPORT_EMAIL}.`,
  },
};

/** Pagamento aprovado sem conta com o e-mail da compra (B-01): o que foi comprado fica guardado até a conta existir. */
const PURCHASE_WITHOUT_ACCOUNT_COPY: Record<MailLocale, {
  subject: string;
  preheader: string;
  title: string;
  received: (product: string, email: string) => string;
  howTo: string;
  button: string;
  note: string;
  footer: string;
}> = {
  pt: {
    subject: 'Pagamento aprovado: crie sua conta para ativar',
    preheader: 'Cadastre-se com este mesmo e-mail e a compra entra na hora.',
    title: 'Seu pagamento foi aprovado',
    received: (product, email) =>
      `Recebemos sua compra de <strong>${product}</strong>, mas ainda não existe conta na The AI Model Lab com o e-mail <strong>${email}</strong>.`,
    howTo: 'Crie a conta com <strong>este mesmo e-mail</strong> e a compra entra na hora, sem falar com o suporte.',
    button: 'Criar conta e ativar',
    note: `Já tem conta com outro e-mail? Escreva para ${ORIGIN_SUPPORT_EMAIL} com os dois endereços e a gente transfere.`,
    footer: 'Sua compra fica guardada: nada se perde enquanto a conta não existir.',
  },
  es: {
    subject: 'Pago aprobado: crea tu cuenta para activarlo',
    preheader: 'Regístrate con este mismo correo y la compra entra al instante.',
    title: 'Tu pago fue aprobado',
    received: (product, email) =>
      `Recibimos tu compra de <strong>${product}</strong>, pero todavía no hay una cuenta en The AI Model Lab con el correo <strong>${email}</strong>.`,
    howTo: 'Crea la cuenta con <strong>este mismo correo</strong> y la compra entra al instante, sin hablar con soporte.',
    button: 'Crear cuenta y activar',
    note: `¿Ya tienes cuenta con otro correo? Escribe a ${ORIGIN_SUPPORT_EMAIL} con los dos correos y lo transferimos.`,
    footer: 'Tu compra queda guardada: no se pierde nada mientras la cuenta no exista.',
  },
  en: {
    subject: 'Payment approved: create your account to activate it',
    preheader: 'Sign up with this same email and your purchase lands instantly.',
    title: 'Your payment was approved',
    received: (product, email) =>
      `We received your purchase of <strong>${product}</strong>, but there is no The AI Model Lab account with <strong>${email}</strong> yet.`,
    howTo: 'Create your account with <strong>this same email</strong> and your purchase lands instantly, no need to contact support.',
    button: 'Create account and activate',
    note: `Already have an account with another email? Write to ${ORIGIN_SUPPORT_EMAIL} with both addresses and we'll move it.`,
    footer: 'Your purchase is safe: nothing is lost while the account does not exist.',
  },
};

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private client: Resend | null = null;
  private fromEmail: string = '';
  private frontendUrl: string = '';
  private logoUrl: string = '';

  constructor(private readonly configService: ConfigService) { }

  onModuleInit() {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    this.fromEmail = this.configService.get<string>('RESEND_FROM_EMAIL') || '';
    // 1º endereço da lista (FRONTEND_URL pode ter vírgula): senão o link de senha/login sai "a.com,b.com/reset…"
    const configuredUrl = firstUrl(this.configService.get<string>('FRONTEND_URL'));
    if (configuredUrl) {
      this.frontendUrl = configuredUrl;
    } else if (this.configService.get<string>('NODE_ENV') === 'production') {
      this.frontendUrl = ORIGIN_SITE_URL;
      this.logger.error(`FRONTEND_URL não configurado em produção: links de e-mail saem para ${ORIGIN_SITE_URL}`);
    } else {
      this.frontendUrl = 'http://localhost:5173';
    }
    this.logoUrl = this.configService.get<string>('LOGO_URL') || '';

    if (!apiKey || !this.fromEmail) {
      this.logger.warn('Resend credentials not configured — email sending will be unavailable');
      return;
    }

    this.client = new Resend(apiKey);
    this.logger.log('Resend email service initialized');
  }

  /**
   * Remetente, assunto e corpo na marca do destinatário (src/brand/brand.ts). Sem marca, ou na origem, sai
   * exatamente como antes.
   */
  private branded(message: { subject: string; html: string }, brand?: Brand): { from: string; subject: string; html: string } {
    if (!brand || brand.key === 'taml') return { from: this.fromEmail, ...message };
    const originUrl = this.frontendUrl.split(',')[0]?.trim() ?? '';
    const swapped = applyBrand(message, brand, { frontendUrl: originUrl, logoUrl: this.logoUrl });
    return { from: brandedFrom(this.fromEmail, brand), ...swapped };
  }

  /**
   * Aviso de denúncia de conteúdo para a equipe. Devolve true se o Resend aceitou: quem chama registra a falha
   * (a denúncia já está gravada no banco e aparece no admin de qualquer jeito).
   */
  async sendContentReportAlert(
    to: string,
    report: {
      id: string; category: string; urgent: boolean; target: string; description: string;
      reporterEmail: string | null; isDepictedPerson: boolean; createdAt: Date;
    },
  ): Promise<boolean> {
    if (!this.client) {
      this.logger.warn('Email service not configured — skipping content report alert');
      return false;
    }
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
    const subject = `${report.urgent ? '[DENÚNCIA URGENTE]' : '[Denúncia]'} ${report.category} — The AI Model Lab`;
    const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">
      <h2 style="margin:0 0 8px">${report.urgent ? 'Denúncia urgente' : 'Nova denúncia'}: ${esc(report.category)}</h2>
      <p><b>Conteúdo:</b> ${esc(report.target)}</p>
      <p><b>Relato:</b><br>${esc(report.description).replace(/\r?\n/g, '<br>')}</p>
      <p><b>Quem denuncia aparece no conteúdo:</b> ${report.isDepictedPerson ? 'sim' : 'não'}<br>
      <b>Contato:</b> ${report.reporterEmail ? esc(report.reporterEmail) : '(não informado)'}<br>
      <b>Id:</b> ${esc(report.id)} · ${report.createdAt.toISOString()}</p>
      <p style="color:#666">${report.urgent ? 'Menor ou imagem íntima sem consentimento: retirar do ar em até 24 h, preservar a evidência e, se envolver menor, comunicar às autoridades.' : 'Analisar e responder em até 5 dias úteis.'}</p>
    </div>`;
    try {
      const { error } = await this.client.emails.send({ from: this.fromEmail, to: [to], subject, html });
      if (error) {
        this.logger.error(`Failed to send content report alert ${report.id}: ${JSON.stringify(error)}`);
        return false;
      }
      return true;
    } catch (error: any) {
      this.logger.error(`Failed to send content report alert ${report.id}: ${error.message}`);
      return false;
    }
  }

  /**
   * Código de confirmação no idioma da conta, com o código no assunto e no preheader (C-03).
   * `bonusCredits` > 0 promete os créditos que caem ao confirmar. Devolve true se o Resend aceitou.
   */
  async sendVerificationEmail(
    to: string,
    name: string,
    code: string,
    brand?: Brand,
    options: { locale?: MailLocale; bonusCredits?: number } = {},
  ): Promise<boolean> {
    if (!this.client) {
      this.logger.warn('Email service not configured — skipping verification email');
      return false;
    }

    const locale = options.locale ?? 'en';
    const copy = VERIFICATION_COPY[locale];
    const bonus = Math.max(0, Math.floor(options.bonusCredits ?? 0));

    try {
      const { error } = await this.client.emails.send({
        ...this.branded({ subject: copy.subject(code), html: this.getVerificationTemplate(name, code, locale, bonus, to, brand) }, brand),
        to: [to],
      });

      if (error) {
        this.logger.error(`Failed to send verification email to ${to}: ${JSON.stringify(error)}`);
        return false;
      }

      this.logger.log(`Verification email (${locale}) sent to ${to}`);
      return true;
    } catch (error: any) {
      this.logger.error(`Failed to send verification email: ${error.message}`);
      return false;
    }
  }

  async sendPasswordResetEmail(to: string, name: string, resetToken: string, brand?: Brand): Promise<void> {
    if (!this.client) {
      this.logger.warn('Email service not configured — skipping password reset email');
      return;
    }

    const resetUrl = `${this.frontendUrl}/reset-password?token=${resetToken}`;

    try {
      const { error } = await this.client.emails.send({
        ...this.branded({ subject: 'Reset your password — The AI Model Lab', html: this.getPasswordResetTemplate(name, resetUrl) }, brand),
        to: [to],
      });

      if (error) {
        this.logger.error(`Failed to send password reset email to ${to}: ${JSON.stringify(error)}`);
        return;
      }

      this.logger.log(`Password reset email sent to ${to}`);
    } catch (error: any) {
      this.logger.error(`Failed to send password reset email: ${error.message}`);
    }
  }

  /**
   * Enviado quando alguém pede reset de senha para uma conta que foi criada
   * via Google OAuth (sem senha local). Em vez de silêncio, orienta o usuário
   * a entrar pelo login com Google.
   */
  async sendOAuthLoginInfoEmail(to: string, name: string, brand?: Brand): Promise<void> {
    if (!this.client) {
      this.logger.warn('Email service not configured — skipping OAuth login info email');
      return;
    }

    try {
      const { error } = await this.client.emails.send({
        ...this.branded({ subject: 'Your account uses Google sign-in — The AI Model Lab', html: this.getOAuthLoginInfoTemplate(name) }, brand),
        to: [to],
      });

      if (error) {
        this.logger.error(`Failed to send OAuth login info email to ${to}: ${JSON.stringify(error)}`);
        return;
      }

      this.logger.log(`OAuth login info email sent to ${to}`);
    } catch (error: any) {
      this.logger.error(`Failed to send OAuth login info email: ${error.message}`);
    }
  }

  /**
   * Boas-vindas no idioma da conta (D-06). Com `credits`, cita o saldo real e, a partir de
   * FIRST_PHOTO_PAID_CREDITS, promete a 1ª foto paga. CTA para os Reels, nunca para o checkout.
   */
  async sendWelcomeEmail(
    to: string,
    name: string,
    brand?: Brand,
    options: { locale?: MailLocale; credits?: number } = {},
  ): Promise<void> {
    if (!this.client) {
      this.logger.warn('Email service not configured — skipping welcome email');
      return;
    }

    const locale = options.locale ?? 'en';
    const copy = WELCOME_COPY[locale];
    const credits = options.credits;
    const paid = credits != null && credits >= FIRST_PHOTO_PAID_CREDITS;

    try {
      const { error } = await this.client.emails.send({
        ...this.branded({ subject: paid ? copy.subjectPaid : copy.subjectPlain, html: this.getWelcomeTemplate(name, locale, credits, to, brand) }, brand),
        to: [to],
      });

      if (error) {
        this.logger.error(`Failed to send welcome email to ${to}: ${JSON.stringify(error)}`);
        return;
      }

      this.logger.log(`Welcome email sent to ${to}`);
    } catch (error: any) {
      this.logger.error(`Failed to send welcome email: ${error.message}`);
    }
  }

  async sendSubscriptionEmail(
    to: string,
    name: string,
    planName: string,
    credits: number,
    brand?: Brand,
  ): Promise<void> {
    if (!this.client) {
      this.logger.warn('Email service not configured — skipping subscription email');
      return;
    }

    try {
      const { error } = await this.client.emails.send({
        ...this.branded({ subject: `Your ${planName} subscription is active — The AI Model Lab`, html: this.getSubscriptionTemplate(name, planName, credits) }, brand),
        to: [to],
      });

      if (error) {
        this.logger.error(`Failed to send subscription email to ${to}: ${JSON.stringify(error)}`);
        return;
      }

      this.logger.log(`Subscription email sent to ${to}`);
    } catch (error: any) {
      this.logger.error(`Failed to send subscription email: ${error.message}`);
    }
  }

  /**
   * E-mail de acesso da isca (gerações grátis) no idioma do comprador (TKT-004).
   * Antes saía num idioma só para todo mundo e o botão caía no /login em
   * português; agora texto e link seguem o `locale` (ver pending-grants/buyer-locale.ts).
   */
  async sendPendingGrantsEmail(
    to: string,
    name: string | null | undefined,
    locale: BuyerLocale = 'en',
    variant: PendingGrantsVariant = 'course',
  ): Promise<void> {
    if (!this.client) {
      this.logger.warn('Email service not configured — skipping pending grants email');
      return;
    }

    const copy = PENDING_GRANTS_COPY[locale] ?? PENDING_GRANTS_COPY.en;

    try {
      const { error } = await this.client.emails.send({
        from: this.fromEmail,
        to: [to],
        subject: copy.subject,
        html: this.getPendingGrantsTemplate(copy, name ?? null, to, locale, variant),
      });

      if (error) {
        this.logger.error(`Failed to send pending grants email to ${to}: ${JSON.stringify(error)}`);
        return;
      }

      this.logger.log(`Pending grants email (${locale}) sent to ${to}`);
    } catch (error: any) {
      this.logger.error(`Failed to send pending grants email: ${error.message}`);
    }
  }

  /**
   * @deprecated Nome histórico: apesar do "Es", sempre mandou a versão em inglês.
   * Mantido para os webhooks que ainda não resolvem o idioma do comprador
   * (Hotmart, Cartpanda, Greenn). Prefira sendPendingGrantsEmail(to, name, locale).
   */
  async sendPendingGrantsEmailEs(to: string, name?: string | null): Promise<void> {
    return this.sendPendingGrantsEmail(to, name ?? null, 'en', 'basic');
  }

  /**
   * Pagamento aprovado (plano ou pacote) sem conta com o e-mail da compra (B-01). A compra fica guardada e
   * entra sozinha no cadastro/login com este e-mail; o link já abre o cadastro com o e-mail preenchido.
   * Devolve true se o Resend aceitou.
   */
  async sendPurchaseWithoutAccountEmail(
    to: string,
    params: { locale: MailLocale; productName: string },
  ): Promise<boolean> {
    if (!this.client) {
      this.logger.warn('Email service not configured — skipping purchase-without-account email');
      return false;
    }

    const copy = PURCHASE_WITHOUT_ACCOUNT_COPY[params.locale] ?? PURCHASE_WITHOUT_ACCOUNT_COPY.en;
    const signupUrl = withQuery(`${this.frontendUrl}/${sitePathFor(params.locale)}/login`, {
      modo: 'cadastro',
      email: to,
      utm_source: 'email',
      utm_medium: 'compra-sem-conta',
    });
    const html = renderBrandEmail({
      locale: params.locale,
      preheader: copy.preheader,
      bannerUrl: brandBannerUrl(params.locale, to),
      title: copy.title,
      paragraphs: [copy.received(escapeHtml(params.productName), escapeHtml(to)), copy.howTo],
      cta: { label: copy.button, url: signupUrl },
      note: copy.note,
      footer: copy.footer,
    });

    try {
      const { error } = await this.client.emails.send({ from: this.fromEmail, to: [to], subject: copy.subject, html });
      if (error) {
        this.logger.error(`Failed to send purchase-without-account email to ${to}: ${JSON.stringify(error)}`);
        return false;
      }
      this.logger.log(`Purchase-without-account email (${params.locale}) sent to ${to}`);
      return true;
    } catch (error: any) {
      this.logger.error(`Failed to send purchase-without-account email: ${error.message}`);
      return false;
    }
  }

  async sendCreditPurchaseEmail(
    to: string,
    name: string,
    credits: number,
    packageName?: string,
    brand?: Brand,
  ): Promise<void> {
    if (!this.client) {
      this.logger.warn('Email service not configured — skipping credit purchase email');
      return;
    }

    try {
      const { error } = await this.client.emails.send({
        ...this.branded({ subject: 'Credits added to your account — The AI Model Lab', html: this.getCreditPurchaseTemplate(name, credits, packageName) }, brand),
        to: [to],
      });

      if (error) {
        this.logger.error(`Failed to send credit purchase email to ${to}: ${JSON.stringify(error)}`);
        return;
      }

      this.logger.log(`Credit purchase email sent to ${to}`);
    } catch (error: any) {
      this.logger.error(`Failed to send credit purchase email: ${error.message}`);
    }
  }

  async sendPaymentFailedEmail(
    to: string,
    name: string,
    planName: string,
    attemptNumber: number,
    maxAttempts: number,
    canceled: boolean,
    brand?: Brand,
  ): Promise<void> {
    if (!this.client) {
      this.logger.warn('Email service not configured — skipping payment failed email');
      return;
    }

    const subject = canceled
      ? `Sua assinatura ${planName} foi cancelada — The AI Model Lab`
      : `Não conseguimos cobrar sua assinatura ${planName} — The AI Model Lab`;

    try {
      const { error } = await this.client.emails.send({
        ...this.branded({ subject: subject, html: this.getPaymentFailedTemplate(name, planName, attemptNumber, maxAttempts, canceled) }, brand),
        to: [to],
      });

      if (error) {
        this.logger.error(`Failed to send payment failed email to ${to}: ${JSON.stringify(error)}`);
        return;
      }

      this.logger.log(`Payment failed email sent to ${to} (canceled=${canceled})`);
    } catch (error: any) {
      this.logger.error(`Failed to send payment failed email: ${error.message}`);
    }
  }

  async sendAffiliatePaymentEmail(params: {
    to: string;
    name: string;
    totalCents: number;
    earningsCount: number;
    /** Moeda das comissões pagas (ISO, ex.: USD). Sem ela vale o real, como sempre. */
    currency?: string;
    /** PIX, PAYPAL ou WISE: muda só a frase de destino. Sem ele, Pix, como sempre. */
    payoutMethod?: string | null;
    attachment?: { filename: string; content: string; contentType?: string };
  }): Promise<void> {
    if (!this.client) {
      this.logger.warn('Email service not configured — skipping affiliate payment email');
      return;
    }

    try {
      const { error } = await this.client.emails.send({
        from: this.fromEmail,
        to: [params.to],
        subject: 'Suas comissões foram pagas — The AI Model Lab',
        html: this.getAffiliatePaymentTemplate(
          params.name,
          params.totalCents,
          params.earningsCount,
          params.currency,
          params.payoutMethod,
        ),
        ...(params.attachment && {
          attachments: [
            {
              filename: params.attachment.filename,
              content: params.attachment.content,
              contentType: params.attachment.contentType,
            },
          ],
        }),
      });

      if (error) {
        this.logger.error(`Failed to send affiliate payment email to ${params.to}: ${JSON.stringify(error)}`);
        return;
      }

      this.logger.log(`Affiliate payment email sent to ${params.to}`);
    } catch (error: any) {
      this.logger.error(`Failed to send affiliate payment email: ${error.message}`);
    }
  }

  // --- Raw senders (usados pelo módulo admin-emails para broadcasts) ---

  /**
   * Envia 1 email avulso já com HTML pronto (sem template wrapper).
   * O caller é responsável por compor o HTML final.
   */
  async sendRawEmail(params: {
    to: string;
    subject: string;
    html: string;
    /** marca do destinatário (src/brand/brand.ts); sem ela, sai como sempre saiu */
    brand?: Brand;
  }): Promise<{ id: string | null }> {
    if (!this.client) {
      this.logger.warn('Email service not configured — skipping raw email');
      return { id: null };
    }
    const { data, error } = await this.client.emails.send({
      ...this.branded({ subject: params.subject, html: params.html }, params.brand),
      to: [params.to],
    });
    if (error) {
      throw new Error(`Resend error: ${JSON.stringify(error)}`);
    }
    return { id: data?.id ?? null };
  }

  /**
   * Envia em batch via Resend (até 100 por chamada). Retorna o array de
   * resultados na mesma ordem dos inputs.
   */
  async sendBatchEmails(
    items: Array<{ to: string; subject: string; html: string }>,
  ): Promise<Array<{ id: string | null; error: string | null }>> {
    if (!this.client) {
      this.logger.warn('Email service not configured — skipping batch');
      return items.map(() => ({ id: null, error: 'email service not configured' }));
    }
    if (!items.length) return [];

    const payload = items.map((it) => ({
      from: this.fromEmail,
      to: [it.to],
      subject: it.subject,
      html: it.html,
    }));

    try {
      const { data, error } = await this.client.batch.send(payload);
      if (error) {
        // Falha do batch inteiro — retorna erro pra cada item
        const msg = JSON.stringify(error);
        return items.map(() => ({ id: null, error: msg }));
      }
      const results = data?.data ?? [];
      return items.map((_, i) => ({
        id: results[i]?.id ?? null,
        error: results[i]?.id ? null : 'no id returned',
      }));
    } catch (error: any) {
      const msg = error?.message ?? 'unknown';
      return items.map(() => ({ id: null, error: msg }));
    }
  }

  // --- Templates ---

  /** Banner da marca só na origem: conta de outra marca (Funvmake) não recebe a arte da The AI Model Lab. */
  private bannerFor(locale: MailLocale, seed: string, brand?: Brand): string | null {
    return !brand || brand.key === 'taml' ? brandBannerUrl(locale, seed) : null;
  }

  private getVerificationTemplate(
    _name: string,
    code: string,
    locale: MailLocale = 'en',
    bonus = 0,
    seed = '',
    brand?: Brand,
  ): string {
    const copy = VERIFICATION_COPY[locale];
    const appUrl = withQuery(`${this.frontendUrl}/${sitePathFor(locale)}/x/reels`, {
      utm_source: 'email',
      utm_medium: 'codigo',
    });
    return renderBrandEmail({
      locale,
      preheader: copy.preheader(code, bonus),
      bannerUrl: this.bannerFor(locale, seed || code, brand),
      title: copy.title,
      paragraphs: [copy.intro],
      highlight: `<span style="font-size:36px;font-weight:800;letter-spacing:8px;color:#ffffff;">${code}</span>`,
      cta: { label: copy.button, url: appUrl },
      note: [bonus > 0 ? copy.bonus(bonus) : '', copy.note].filter(Boolean).join('<br>'),
      footer: copy.footer,
    });
  }

  private getPasswordResetTemplate(_name: string, resetUrl: string): string {
    const logoHtml = this.logoUrl
      ? `<img src="${this.logoUrl}" alt="The AI Model Lab" width="80" height="80" style="display: block; border-radius: 12px;">`
      : '';

    return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #f9f9f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f9f9f9; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden;">
          <tr>
            <td style="padding: 48px 40px;">
              ${logoHtml ? `<div style="margin-bottom: 32px;">${logoHtml}</div>` : ''}
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #1a1a1a; line-height: 1.3;">Reset your password</h1>
              <p style="margin: 0 0 28px; font-size: 15px; color: #666; line-height: 1.6;">We received a request to reset your password. Click the button below to create a new one:</p>
              <div style="margin: 0 0 28px;">
                <a href="${resetUrl}"
                   style="display: inline-block; background-color: #1a1a1a; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 600;">
                  Reset password
                </a>
              </div>
              <p style="margin: 0; font-size: 15px; color: #666; line-height: 1.6;">This link is valid for <strong>15 minutes</strong>.</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 40px;">
              <hr style="border: none; border-top: 1px solid #eee; margin: 0 0 24px;">
              <p style="margin: 0 0 6px; font-size: 13px; font-weight: 600; color: #1a1a1a;">Didn't request this change?</p>
              <p style="margin: 0; font-size: 13px; color: #999; line-height: 1.5;">Just ignore this email. Your password will stay the same.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  private getOAuthLoginInfoTemplate(name: string): string {
    const loginUrl = `${this.frontendUrl}/login`;
    const logoHtml = this.logoUrl
      ? `<img src="${this.logoUrl}" alt="The AI Model Lab" width="80" height="80" style="display: block; border-radius: 12px;">`
      : '';
    const greeting = name ? `Hi, ${name}!` : 'Hi!';

    return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #f9f9f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f9f9f9; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden;">
          <tr>
            <td style="padding: 48px 40px;">
              ${logoHtml ? `<div style="margin-bottom: 32px;">${logoHtml}</div>` : ''}
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #1a1a1a; line-height: 1.3;">Your account uses Google sign-in</h1>
              <p style="margin: 0 0 20px; font-size: 15px; color: #666; line-height: 1.6;">${greeting} We received a request to reset your password, but your The AI Model Lab account was created with <strong>Google sign-in</strong> and doesn't have a password to reset.</p>
              <p style="margin: 0 0 28px; font-size: 15px; color: #666; line-height: 1.6;">To get in, just sign in again using the "Continue with Google" button:</p>
              <div style="margin: 0 0 28px;">
                <a href="${loginUrl}"
                   style="display: inline-block; background-color: #1a1a1a; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 600;">
                  Sign in with Google
                </a>
              </div>
              <p style="margin: 0; font-size: 15px; color: #666; line-height: 1.6;">That way you never have to remember a password.</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 40px;">
              <hr style="border: none; border-top: 1px solid #eee; margin: 0 0 24px;">
              <p style="margin: 0 0 6px; font-size: 13px; font-weight: 600; color: #1a1a1a;">Didn't request this?</p>
              <p style="margin: 0; font-size: 13px; color: #999; line-height: 1.5;">You can safely ignore this email. Nothing in your account was changed.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  private getWelcomeTemplate(
    _name: string,
    locale: MailLocale = 'en',
    credits?: number,
    seed = '',
    brand?: Brand,
  ): string {
    const copy = WELCOME_COPY[locale];
    const paid = credits != null && credits >= FIRST_PHOTO_PAID_CREDITS;
    const reelsUrl = withQuery(`${this.frontendUrl}/${sitePathFor(locale)}/x/reels`, {
      utm_source: 'email',
      utm_campaign: 'welcome',
    });
    return renderBrandEmail({
      locale,
      preheader: credits != null ? copy.preheader(credits) : copy.plainLine,
      bannerUrl: this.bannerFor(locale, seed || 'welcome', brand),
      title: copy.title,
      paragraphs: [credits != null ? copy.creditsLine(credits, paid) : copy.plainLine, copy.howTo],
      cta: { label: copy.button, url: reelsUrl },
      footer: copy.footer,
    });
  }

  private getPendingGrantsTemplate(
    copy: PendingGrantsCopy,
    name: string | null,
    email: string,
    locale: BuyerLocale = 'en',
    variant: PendingGrantsVariant = 'course',
  ): string {
    // O site tem rota por idioma (/en, /es, /pt-br); o /login sem prefixo cai no português para todo mundo.
    // modo=cadastro abre direto no cadastro e email= já preenche o e-mail da compra (B-03): com outro e-mail o
    // bônus não cai.
    const signupUrl = withQuery(`${this.frontendUrl}/${copy.sitePath}/login`, {
      modo: 'cadastro',
      email,
      utm_source: 'email',
      utm_medium: 'acesso-isca',
    });
    const items = (variant === 'course' ? copy.courseItems : copy.items)
      .map((item) => `<li style="margin:0 0 4px;">${item}</li>`)
      .join('');
    const greeting = escapeHtml(copy.greeting(name));

    return renderBrandEmail({
      locale,
      preheader: copy.title,
      bannerUrl: brandBannerUrl(locale, email),
      title: `${greeting} ${copy.title}`,
      paragraphs: [copy.intro, copy.claim],
      highlight: `<p style="margin:0 0 8px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#8a8a99;text-align:left;">${copy.includedLabel}</p><ul style="margin:0;padding-left:18px;font-size:15px;line-height:1.6;color:#ffffff;text-align:left;">${items}</ul>`,
      cta: { label: copy.button, url: signupUrl },
      note: copy.important,
      footer: copy.footer,
    });
  }

  private getCreditPurchaseTemplate(name: string, credits: number, packageName?: string): string {
    const dashboardUrl = `${this.frontendUrl}`;
    const logoHtml = this.logoUrl
      ? `<img src="${this.logoUrl}" alt="The AI Model Lab" width="80" height="80" style="display: block; border-radius: 12px;">`
      : '';
    const creditsFormatted = credits.toLocaleString('en-US');
    const packageLine = packageName
      ? `<p style="margin: 0 0 20px; font-size: 15px; color: #666; line-height: 1.6;">Package purchased: <strong>${packageName}</strong>.</p>`
      : '';

    return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #f9f9f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f9f9f9; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden;">
          <tr>
            <td style="padding: 48px 40px;">
              ${logoHtml ? `<div style="margin-bottom: 32px;">${logoHtml}</div>` : ''}
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #1a1a1a; line-height: 1.3;">Thanks for your purchase, ${name}!</h1>
              <p style="margin: 0 0 20px; font-size: 15px; color: #666; line-height: 1.6;">Your purchase is confirmed and your credits are now available to use.</p>
              ${packageLine}
              <div style="margin: 0 0 28px; padding: 20px; background-color: #f5f5f5; border-radius: 8px; text-align: center;">
                <p style="margin: 0 0 4px; font-size: 13px; color: #999; text-transform: uppercase; letter-spacing: 1px;">Credits added</p>
                <p style="margin: 0; font-size: 32px; font-weight: 700; color: #1a1a1a; line-height: 1;">+${creditsFormatted}</p>
              </div>
              <p style="margin: 0 0 28px; font-size: 15px; color: #666; line-height: 1.6;">Jump back into the platform and start creating right now.</p>
              <div style="margin: 0 0 0;">
                <a href="${dashboardUrl}"
                   style="display: inline-block; background-color: #1a1a1a; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 600;">
                  Use my credits
                </a>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 40px;">
              <hr style="border: none; border-top: 1px solid #eee; margin: 0 0 24px;">
              <p style="margin: 0; font-size: 13px; color: #999; line-height: 1.5;">This email confirms your purchase. Keep it for your records.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  private getSubscriptionTemplate(
    name: string,
    planName: string,
    credits: number,
  ): string {
    const dashboardUrl = `${this.frontendUrl}`;
    const logoHtml = this.logoUrl
      ? `<img src="${this.logoUrl}" alt="The AI Model Lab" width="80" height="80" style="display: block; border-radius: 12px;">`
      : '';
    const creditsFormatted = credits.toLocaleString('en-US');

    return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #f9f9f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f9f9f9; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden;">
          <tr>
            <td style="padding: 48px 40px;">
              ${logoHtml ? `<div style="margin-bottom: 32px;">${logoHtml}</div>` : ''}
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #1a1a1a; line-height: 1.3;">Welcome to the ${planName} plan, ${name}!</h1>
              <p style="margin: 0 0 28px; font-size: 15px; color: #666; line-height: 1.6;">Your subscription is active and all your plan features are unlocked.</p>
              <div style="margin: 0 0 28px; padding: 20px; background-color: #f5f5f5; border-radius: 8px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding: 0 0 12px; border-bottom: 1px solid #e5e5e5;">
                      <p style="margin: 0 0 4px; font-size: 12px; color: #999; text-transform: uppercase; letter-spacing: 1px;">Plan</p>
                      <p style="margin: 0; font-size: 16px; font-weight: 600; color: #1a1a1a;">${planName}</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 12px 0 0;">
                      <p style="margin: 0 0 4px; font-size: 12px; color: #999; text-transform: uppercase; letter-spacing: 1px;">Monthly credits</p>
                      <p style="margin: 0; font-size: 16px; font-weight: 600; color: #1a1a1a;">${creditsFormatted}</p>
                    </td>
                  </tr>
                </table>
              </div>
              <p style="margin: 0 0 28px; font-size: 15px; color: #666; line-height: 1.6;">You can manage your subscription anytime from your dashboard. Cancel whenever you want, no hassle.</p>
              <div style="margin: 0 0 0;">
                <a href="${dashboardUrl}"
                   style="display: inline-block; background-color: #1a1a1a; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 600;">
                  Go to my account
                </a>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 40px;">
              <hr style="border: none; border-top: 1px solid #eee; margin: 0 0 24px;">
              <p style="margin: 0; font-size: 13px; color: #999; line-height: 1.5;">This email confirms your subscription. Keep it for your records.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  private getPaymentFailedTemplate(
    name: string,
    planName: string,
    attemptNumber: number,
    maxAttempts: number,
    canceled: boolean,
  ): string {
    const billingUrl = `${this.frontendUrl}/perfil`;
    const logoHtml = this.logoUrl
      ? `<img src="${this.logoUrl}" alt="The AI Model Lab" width="80" height="80" style="display: block; border-radius: 12px;">`
      : '';

    const headline = canceled
      ? `Sua assinatura ${planName} foi cancelada`
      : `Não conseguimos cobrar sua assinatura ${planName}`;

    const intro = canceled
      ? `Olá, ${name}. Tentamos cobrar sua assinatura <strong>${maxAttempts}</strong> vezes e em todas as tentativas o pagamento foi recusado. Por isso, sua assinatura foi cancelada e sua conta voltou para o plano gratuito.`
      : `Olá, ${name}. A cobrança da sua assinatura foi recusada (tentativa <strong>${attemptNumber} de ${maxAttempts}</strong>). Os motivos mais comuns são saldo insuficiente, cartão expirado ou bloqueio do banco.`;

    const ctaLabel = canceled ? 'Reativar minha assinatura' : 'Atualizar forma de pagamento';
    const helperText = canceled
      ? `Você pode reassinar a qualquer momento e voltar a usar todos os recursos do plano ${planName}.`
      : `Vamos tentar cobrar novamente nos próximos dias. Para evitar a perda de acesso, atualize seu cartão ou garanta saldo suficiente o quanto antes.`;

    return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #f9f9f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f9f9f9; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden;">
          <tr>
            <td style="padding: 48px 40px;">
              ${logoHtml ? `<div style="margin-bottom: 32px;">${logoHtml}</div>` : ''}
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #1a1a1a; line-height: 1.3;">${headline}</h1>
              <p style="margin: 0 0 20px; font-size: 15px; color: #666; line-height: 1.6;">${intro}</p>
              <p style="margin: 0 0 28px; font-size: 15px; color: #666; line-height: 1.6;">${helperText}</p>
              <div style="margin: 0 0 28px;">
                <a href="${billingUrl}"
                   style="display: inline-block; background-color: #1a1a1a; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 600;">
                  ${ctaLabel}
                </a>
              </div>
              <p style="margin: 0; font-size: 13px; color: #999; line-height: 1.6;">Se precisar de ajuda, é só responder este email.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  private getAffiliatePaymentTemplate(
    name: string,
    totalCents: number,
    earningsCount: number,
    currency?: string,
    payoutMethod?: string | null,
  ): string {
    const dashboardUrl = `${this.frontendUrl}/painel-afiliado`;
    const logoHtml = this.logoUrl
      ? `<img src="${this.logoUrl}" alt="The AI Model Lab" width="80" height="80" style="display: block; border-radius: 12px;">`
      : '';
    const totalFormatted = formatAffiliatePayoutAmount(totalCents, currency);
    const earningsLabel = earningsCount === 1 ? '1 comissão paga' : `${earningsCount} comissões pagas`;

    return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #f9f9f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f9f9f9; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden;">
          <tr>
            <td style="padding: 48px 40px;">
              ${logoHtml ? `<div style="margin-bottom: 32px;">${logoHtml}</div>` : ''}
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #1a1a1a; line-height: 1.3;">Pagamento enviado, ${name}! 🎉</h1>
              <p style="margin: 0 0 28px; font-size: 15px; color: #666; line-height: 1.6;">Suas comissões do programa de afiliados foram pagas e já estão a caminho da ${describePayoutDestination(payoutMethod)}.</p>
              <div style="margin: 0 0 28px; padding: 20px; background-color: #f5f5f5; border-radius: 8px; text-align: center;">
                <p style="margin: 0 0 4px; font-size: 13px; color: #999; text-transform: uppercase; letter-spacing: 1px;">Valor pago</p>
                <p style="margin: 0 0 8px; font-size: 32px; font-weight: 700; color: #1a1a1a; line-height: 1;">${totalFormatted}</p>
                <p style="margin: 0; font-size: 13px; color: #999;">${earningsLabel}</p>
              </div>
              <p style="margin: 0 0 28px; font-size: 15px; color: #666; line-height: 1.6;">O comprovante de pagamento está anexado a este email. Guarde-o para seus registros.</p>
              <div style="margin: 0 0 0;">
                <a href="${dashboardUrl}"
                   style="display: inline-block; background-color: #1a1a1a; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 600;">
                  Ver painel de afiliado
                </a>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 40px;">
              <hr style="border: none; border-top: 1px solid #eee; margin: 0 0 24px;">
              <p style="margin: 0; font-size: 13px; color: #999; line-height: 1.5;">Continue divulgando e ganhando — toda nova venda gera uma nova comissão pra você.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }
}
