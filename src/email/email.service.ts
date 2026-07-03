import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

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
    this.frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173';
    this.logoUrl = this.configService.get<string>('LOGO_URL') || '';

    if (!apiKey || !this.fromEmail) {
      this.logger.warn('Resend credentials not configured — email sending will be unavailable');
      return;
    }

    this.client = new Resend(apiKey);
    this.logger.log('Resend email service initialized');
  }

  async sendVerificationEmail(to: string, name: string, code: string): Promise<void> {
    if (!this.client) {
      this.logger.warn('Email service not configured — skipping verification email');
      return;
    }

    try {
      const { error } = await this.client.emails.send({
        from: this.fromEmail,
        to: [to],
        subject: 'Seu código de verificação — The AI Model Lab',
        html: this.getVerificationTemplate(name, code),
      });

      if (error) {
        this.logger.error(`Failed to send verification email to ${to}: ${JSON.stringify(error)}`);
        return;
      }

      this.logger.log(`Verification email sent to ${to}`);
    } catch (error: any) {
      this.logger.error(`Failed to send verification email: ${error.message}`);
    }
  }

  async sendPasswordResetEmail(to: string, name: string, resetToken: string): Promise<void> {
    if (!this.client) {
      this.logger.warn('Email service not configured — skipping password reset email');
      return;
    }

    const resetUrl = `${this.frontendUrl}/reset-password?token=${resetToken}`;

    try {
      const { error } = await this.client.emails.send({
        from: this.fromEmail,
        to: [to],
        subject: 'Redefinição de senha — The AI Model Lab',
        html: this.getPasswordResetTemplate(name, resetUrl),
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
  async sendOAuthLoginInfoEmail(to: string, name: string): Promise<void> {
    if (!this.client) {
      this.logger.warn('Email service not configured — skipping OAuth login info email');
      return;
    }

    try {
      const { error } = await this.client.emails.send({
        from: this.fromEmail,
        to: [to],
        subject: 'Sua conta usa login com Google — The AI Model Lab',
        html: this.getOAuthLoginInfoTemplate(name),
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

  async sendWelcomeEmail(to: string, name: string): Promise<void> {
    if (!this.client) {
      this.logger.warn('Email service not configured — skipping welcome email');
      return;
    }

    try {
      const { error } = await this.client.emails.send({
        from: this.fromEmail,
        to: [to],
        subject: 'Bem-vindo ao The AI Model Lab!',
        html: this.getWelcomeTemplate(name),
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
  ): Promise<void> {
    if (!this.client) {
      this.logger.warn('Email service not configured — skipping subscription email');
      return;
    }

    try {
      const { error } = await this.client.emails.send({
        from: this.fromEmail,
        to: [to],
        subject: `Sua assinatura ${planName} está ativa — The AI Model Lab`,
        html: this.getSubscriptionTemplate(name, planName, credits),
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

  async sendPendingGrantsEmailEs(to: string, name?: string | null): Promise<void> {
    if (!this.client) {
      this.logger.warn('Email service not configured — skipping pending grants email');
      return;
    }

    try {
      const { error } = await this.client.emails.send({
        from: this.fromEmail,
        to: [to],
        subject: '¡Ganaste generaciones gratis en The AI Model Lab! 🎉',
        html: this.getPendingGrantsTemplateEs(name ?? null),
      });

      if (error) {
        this.logger.error(`Failed to send pending grants email to ${to}: ${JSON.stringify(error)}`);
        return;
      }

      this.logger.log(`Pending grants email (ES) sent to ${to}`);
    } catch (error: any) {
      this.logger.error(`Failed to send pending grants email: ${error.message}`);
    }
  }

  async sendCreditPurchaseEmail(
    to: string,
    name: string,
    credits: number,
    packageName?: string,
  ): Promise<void> {
    if (!this.client) {
      this.logger.warn('Email service not configured — skipping credit purchase email');
      return;
    }

    try {
      const { error } = await this.client.emails.send({
        from: this.fromEmail,
        to: [to],
        subject: 'Créditos adicionados à sua conta — The AI Model Lab',
        html: this.getCreditPurchaseTemplate(name, credits, packageName),
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
        from: this.fromEmail,
        to: [to],
        subject,
        html: this.getPaymentFailedTemplate(name, planName, attemptNumber, maxAttempts, canceled),
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
        html: this.getAffiliatePaymentTemplate(params.name, params.totalCents, params.earningsCount),
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
  }): Promise<{ id: string | null }> {
    if (!this.client) {
      this.logger.warn('Email service not configured — skipping raw email');
      return { id: null };
    }
    const { data, error } = await this.client.emails.send({
      from: this.fromEmail,
      to: [params.to],
      subject: params.subject,
      html: params.html,
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

  private getVerificationTemplate(_name: string, code: string): string {
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
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #1a1a1a; line-height: 1.3;">Código de verificação</h1>
              <p style="margin: 0 0 28px; font-size: 15px; color: #666; line-height: 1.6;">Insira o código de verificação abaixo para confirmar seu email:</p>
              <p style="margin: 0 0 28px; font-size: 36px; font-weight: 700; color: #1a1a1a; letter-spacing: 6px; line-height: 1;">${code}</p>
              <p style="margin: 0 0 0; font-size: 15px; color: #666; line-height: 1.6;">Para proteger sua conta, não compartilhe este código.</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 40px;">
              <hr style="border: none; border-top: 1px solid #eee; margin: 0 0 24px;">
              <p style="margin: 0 0 6px; font-size: 13px; font-weight: 600; color: #1a1a1a;">Não solicitou este código?</p>
              <p style="margin: 0; font-size: 13px; color: #999; line-height: 1.5;">Se você não criou uma conta no AI Model Lab, ignore este email.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
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
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #1a1a1a; line-height: 1.3;">Redefinição de senha</h1>
              <p style="margin: 0 0 28px; font-size: 15px; color: #666; line-height: 1.6;">Recebemos uma solicitação para redefinir sua senha. Clique no botão abaixo para criar uma nova senha:</p>
              <div style="margin: 0 0 28px;">
                <a href="${resetUrl}"
                   style="display: inline-block; background-color: #1a1a1a; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 600;">
                  Redefinir Senha
                </a>
              </div>
              <p style="margin: 0; font-size: 15px; color: #666; line-height: 1.6;">Este link é válido por <strong>15 minutos</strong>.</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 40px;">
              <hr style="border: none; border-top: 1px solid #eee; margin: 0 0 24px;">
              <p style="margin: 0 0 6px; font-size: 13px; font-weight: 600; color: #1a1a1a;">Não solicitou esta alteração?</p>
              <p style="margin: 0; font-size: 13px; color: #999; line-height: 1.5;">Ignore este email. Sua senha permanecerá a mesma.</p>
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
    const greeting = name ? `Olá, ${name}!` : 'Olá!';

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
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #1a1a1a; line-height: 1.3;">Sua conta usa login com Google</h1>
              <p style="margin: 0 0 20px; font-size: 15px; color: #666; line-height: 1.6;">${greeting} Recebemos uma solicitação para redefinir sua senha, mas sua conta no AI Model Lab foi criada com <strong>login do Google</strong> e não tem uma senha para redefinir.</p>
              <p style="margin: 0 0 28px; font-size: 15px; color: #666; line-height: 1.6;">Para acessar, é só entrar novamente usando o botão "Continuar com Google":</p>
              <div style="margin: 0 0 28px;">
                <a href="${loginUrl}"
                   style="display: inline-block; background-color: #1a1a1a; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 600;">
                  Entrar com Google
                </a>
              </div>
              <p style="margin: 0; font-size: 15px; color: #666; line-height: 1.6;">Assim você não precisa lembrar de nenhuma senha.</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 40px;">
              <hr style="border: none; border-top: 1px solid #eee; margin: 0 0 24px;">
              <p style="margin: 0 0 6px; font-size: 13px; font-weight: 600; color: #1a1a1a;">Não solicitou isto?</p>
              <p style="margin: 0; font-size: 13px; color: #999; line-height: 1.5;">Pode ignorar este email com segurança. Nada na sua conta foi alterado.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  private getWelcomeTemplate(name: string): string {
    const dashboardUrl = `${this.frontendUrl}`;
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
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #1a1a1a; line-height: 1.3;">Bem-vindo ao The AI Model Lab!</h1>
              <p style="margin: 0 0 28px; font-size: 15px; color: #666; line-height: 1.6;">Olá, ${name}! Seu email foi confirmado e sua conta está pronta.</p>
              <div style="margin: 0 0 0;">
                <a href="${dashboardUrl}"
                   style="display: inline-block; background-color: #1a1a1a; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 600;">
                  Começar a Criar
                </a>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  private getPendingGrantsTemplateEs(name: string | null): string {
    const signupUrl = `${this.frontendUrl}/login`;
    const logoHtml = this.logoUrl
      ? `<img src="${this.logoUrl}" alt="The AI Model Lab" width="80" height="80" style="display: block; border-radius: 12px;">`
      : '';
    const greeting = name ? `¡Hola, ${name}!` : '¡Hola!';

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
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #1a1a1a; line-height: 1.3;">${greeting} Ganaste generaciones gratis 🎁</h1>
              <p style="margin: 0 0 20px; font-size: 15px; color: #666; line-height: 1.6;">Gracias por tu compra. Reservamos un paquete de <strong>generaciones gratis</strong> para tu cuenta en The AI Model Lab.</p>
              <div style="margin: 0 0 28px; padding: 20px; background-color: #f5f5f5; border-radius: 8px;">
                <p style="margin: 0 0 8px; font-size: 13px; color: #999; text-transform: uppercase; letter-spacing: 1px;">Incluye</p>
                <ul style="margin: 0; padding-left: 18px; font-size: 14px; color: #1a1a1a; line-height: 1.8;">
                  <li>1 generación Nano Banana 2</li>
                  <li>1 generación Nano Banana Pro</li>
                  <li>1 Face Swap</li>
                  <li>1 Virtual Try-On</li>
                  <li>1 Veo 3.1 Fast</li>
                  <li>1 Upscale</li>
                </ul>
              </div>
              <p style="margin: 0 0 28px; font-size: 15px; color: #666; line-height: 1.6;">Para canjearlas, crea tu cuenta ahora mismo usando <strong>este mismo correo</strong>. Los créditos se acreditarán automáticamente después del registro.</p>
              <div style="margin: 0 0 28px;">
                <a href="${signupUrl}"
                   style="display: inline-block; background-color: #1a1a1a; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 600;">
                  Crear mi cuenta y reclamar
                </a>
              </div>
              <p style="margin: 0; font-size: 13px; color: #999; line-height: 1.6;">Importante: regístrate con el mismo correo al que llegó este mensaje; de lo contrario, las generaciones no podrán ser acreditadas.</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 40px;">
              <hr style="border: none; border-top: 1px solid #eee; margin: 0 0 24px;">
              <p style="margin: 0; font-size: 13px; color: #999; line-height: 1.5;">Si tienes alguna duda, solo responde a este correo y te ayudaremos.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  private getCreditPurchaseTemplate(name: string, credits: number, packageName?: string): string {
    const dashboardUrl = `${this.frontendUrl}`;
    const logoHtml = this.logoUrl
      ? `<img src="${this.logoUrl}" alt="The AI Model Lab" width="80" height="80" style="display: block; border-radius: 12px;">`
      : '';
    const creditsFormatted = credits.toLocaleString('pt-BR');
    const packageLine = packageName
      ? `<p style="margin: 0 0 20px; font-size: 15px; color: #666; line-height: 1.6;">Pacote adquirido: <strong>${packageName}</strong>.</p>`
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
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #1a1a1a; line-height: 1.3;">Parabéns pela sua compra, ${name}!</h1>
              <p style="margin: 0 0 20px; font-size: 15px; color: #666; line-height: 1.6;">Sua compra foi confirmada e seus créditos já estão disponíveis para uso.</p>
              ${packageLine}
              <div style="margin: 0 0 28px; padding: 20px; background-color: #f5f5f5; border-radius: 8px; text-align: center;">
                <p style="margin: 0 0 4px; font-size: 13px; color: #999; text-transform: uppercase; letter-spacing: 1px;">Créditos adicionados</p>
                <p style="margin: 0; font-size: 32px; font-weight: 700; color: #1a1a1a; line-height: 1;">+${creditsFormatted}</p>
              </div>
              <p style="margin: 0 0 28px; font-size: 15px; color: #666; line-height: 1.6;">É só acessar a plataforma e começar a criar agora mesmo.</p>
              <div style="margin: 0 0 0;">
                <a href="${dashboardUrl}"
                   style="display: inline-block; background-color: #1a1a1a; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 600;">
                  Usar meus créditos
                </a>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 40px;">
              <hr style="border: none; border-top: 1px solid #eee; margin: 0 0 24px;">
              <p style="margin: 0; font-size: 13px; color: #999; line-height: 1.5;">Este email é a confirmação da sua compra. Guarde-o para seus registros.</p>
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
    const creditsFormatted = credits.toLocaleString('pt-BR');

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
              <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #1a1a1a; line-height: 1.3;">Bem-vindo ao plano ${planName}, ${name}!</h1>
              <p style="margin: 0 0 28px; font-size: 15px; color: #666; line-height: 1.6;">Sua assinatura está ativa e todos os recursos do seu plano já estão liberados.</p>
              <div style="margin: 0 0 28px; padding: 20px; background-color: #f5f5f5; border-radius: 8px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding: 0 0 12px; border-bottom: 1px solid #e5e5e5;">
                      <p style="margin: 0 0 4px; font-size: 12px; color: #999; text-transform: uppercase; letter-spacing: 1px;">Plano</p>
                      <p style="margin: 0; font-size: 16px; font-weight: 600; color: #1a1a1a;">${planName}</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 12px 0 0;">
                      <p style="margin: 0 0 4px; font-size: 12px; color: #999; text-transform: uppercase; letter-spacing: 1px;">Créditos mensais</p>
                      <p style="margin: 0; font-size: 16px; font-weight: 600; color: #1a1a1a;">${creditsFormatted}</p>
                    </td>
                  </tr>
                </table>
              </div>
              <p style="margin: 0 0 28px; font-size: 15px; color: #666; line-height: 1.6;">Você pode gerenciar sua assinatura a qualquer momento pelo painel. Cancele quando quiser, sem burocracia.</p>
              <div style="margin: 0 0 0;">
                <a href="${dashboardUrl}"
                   style="display: inline-block; background-color: #1a1a1a; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 600;">
                  Acessar minha conta
                </a>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 40px;">
              <hr style="border: none; border-top: 1px solid #eee; margin: 0 0 24px;">
              <p style="margin: 0; font-size: 13px; color: #999; line-height: 1.5;">Este email é a confirmação da sua assinatura. Guarde-o para seus registros.</p>
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
  ): string {
    const dashboardUrl = `${this.frontendUrl}/painel-afiliado`;
    const logoHtml = this.logoUrl
      ? `<img src="${this.logoUrl}" alt="The AI Model Lab" width="80" height="80" style="display: block; border-radius: 12px;">`
      : '';
    const totalFormatted = (totalCents / 100).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });
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
              <p style="margin: 0 0 28px; font-size: 15px; color: #666; line-height: 1.6;">Suas comissões do programa de afiliados foram pagas e já estão a caminho da sua chave Pix cadastrada.</p>
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
