import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators';
import { EmailPreferencesService } from './email-preferences.service';

type Locale = 'en' | 'es' | 'pt-BR';

const COPY: Record<Locale, { ok: string; okSub: string; bad: string }> = {
  en: {
    ok: "You're unsubscribed",
    okSub: "You won't receive marketing emails from The AI Model Lab anymore. Account and billing emails will still be sent.",
    bad: 'This unsubscribe link is invalid or expired.',
  },
  es: {
    ok: 'Te diste de baja',
    okSub: 'Ya no recibirás correos de marketing de The AI Model Lab. Los correos de cuenta y facturación se seguirán enviando.',
    bad: 'Este enlace para darse de baja no es válido o expiró.',
  },
  'pt-BR': {
    ok: 'Você foi descadastrado',
    okSub: 'Você não vai mais receber emails de marketing da The AI Model Lab. Emails de conta e cobrança continuam sendo enviados.',
    bad: 'Este link de descadastro é inválido ou expirou.',
  },
};

function resolveLocale(l?: string): Locale {
  const v = (l || '').toLowerCase();
  if (v.startsWith('pt')) return 'pt-BR';
  if (v.startsWith('es')) return 'es';
  return 'en';
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#f9f9f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:60px 20px;"><tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;max-width:480px;"><tr><td style="padding:40px;text-align:center;">
<h1 style="margin:0 0 12px;font-size:22px;color:#1a1a1a;">${title}</h1>
<p style="margin:0;font-size:15px;color:#555;line-height:1.6;">${body}</p>
</td></tr></table></td></tr></table></body></html>`;
}

@ApiTags('email')
@Controller('api/v1/email')
export class EmailPreferencesController {
  constructor(private readonly service: EmailPreferencesService) {}

  /** Link visível no rodapé do email (clicado por humano). Mostra página de confirmação. */
  @Public()
  @Get('unsubscribe')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @ApiOperation({ summary: 'Descadastro de marketing (link do rodapé)' })
  async unsubscribeGet(
    @Query('e') email: string,
    @Query('t') token: string,
    @Query('l') locale?: string,
  ): Promise<string> {
    const c = COPY[resolveLocale(locale)];
    const ok = await this.service.unsubscribe(email, token);
    return ok ? page(c.ok, c.okSub) : page(c.bad, '');
  }

  /** One-click (RFC 8058) — chamado pelo botão nativo do Gmail/Apple via header List-Unsubscribe-Post. */
  @Public()
  @Post('unsubscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Descadastro one-click (List-Unsubscribe-Post)' })
  async unsubscribePost(
    @Query('e') email: string,
    @Query('t') token: string,
  ): Promise<{ success: boolean }> {
    const ok = await this.service.unsubscribe(email, token);
    return { success: ok };
  }
}
