import { ConfigService } from '@nestjs/config';
import { resolveBrand } from '../../brand/brand';
import { EmailService } from '../email.service';
import { brandBannerUrl, mailLocaleFor } from '../brand-email';

/** Jornada anúncio → 1ª geração (13/11): código, boas-vindas, isca e compra sem conta. */
const VALUES: Record<string, string> = {
  RESEND_FROM_EMAIL: 'The AI Model Lab <noreply@theaimodelab.com>',
  FRONTEND_URL: 'https://www.theaimodelab.com',
  LOGO_URL: '',
  FUNVMAKE_FRONTEND_URL: 'https://www.funvmake.com',
};
const env = (key: string) => VALUES[key];

function makeService() {
  const config = { get: (key: string) => (key === 'RESEND_API_KEY' ? undefined : VALUES[key]) } as unknown as ConfigService;
  const service = new EmailService(config);
  service.onModuleInit();
  const send = jest.fn().mockResolvedValue({ data: { id: 'email-1' }, error: null });
  (service as unknown as { client: unknown }).client = { emails: { send } };
  return { service, send };
}

function last(send: jest.Mock): { subject: string; html: string; to: string[] } {
  return send.mock.calls[send.mock.calls.length - 1][0];
}

describe('idioma e banner', () => {
  it('país manda antes do locale gravado pelo IP', () => {
    expect(mailLocaleFor({ locale: 'en-US', country: 'MX' })).toBe('es');
    expect(mailLocaleFor({ locale: 'pt-BR', country: null })).toBe('pt');
    expect(mailLocaleFor({ locale: null, country: null })).toBe('en');
  });

  it('banner estável por destinatário, 1 de 4 no idioma', () => {
    const url = brandBannerUrl('es', 'ana@mail.com');
    expect(url).toMatch(/^https:\/\/assets\.theaimodelab\.com\/assets\/brand\/banners\/email-es-[1-4]\.jpg$/);
    expect(brandBannerUrl('es', 'ana@mail.com')).toBe(url);
  });
});

describe('e-mail do código (C-03)', () => {
  it('pt: código no assunto e no preheader, banner e promessa dos créditos', async () => {
    const { service, send } = makeService();
    const ok = await service.sendVerificationEmail('ana@mail.com', 'Ana', '483920', undefined, { locale: 'pt', bonusCredits: 150 });
    expect(ok).toBe(true);
    const mail = last(send);
    expect(mail.subject).toBe('483920 é seu código · The AI Model Lab');
    expect(mail.html).toContain('Seu código é 483920');
    expect(mail.html).toContain('+150 créditos');
    expect(mail.html).toContain('/assets/brand/banners/email-pt-');
    expect(mail.html).toContain('https://www.theaimodelab.com/pt-br/x/reels');
  });

  it('es e en traduzidos; sem bônus pendente não promete crédito', async () => {
    const { service, send } = makeService();
    await service.sendVerificationEmail('a@b.com', 'A', '111222', undefined, { locale: 'es' });
    expect(last(send).subject).toBe('111222 es tu código · The AI Model Lab');
    expect(last(send).html).not.toContain('créditos</strong>');
    await service.sendVerificationEmail('a@b.com', 'A', '111222');
    expect(last(send).subject).toBe('111222 is your code · The AI Model Lab');
  });

  it('conta de outra marca não recebe o banner da The AI Model Lab', async () => {
    const { service, send } = makeService();
    await service.sendVerificationEmail('a@b.com', 'A', '111222', resolveBrand('funvmake', env), { locale: 'pt' });
    expect(last(send).html).not.toContain('/brand/banners/');
    expect(last(send).subject).toBe('111222 é seu código · Funvmake');
  });

  it('falha do Resend devolve false', async () => {
    const { service, send } = makeService();
    send.mockResolvedValueOnce({ data: null, error: { message: 'x' } });
    await expect(service.sendVerificationEmail('a@b.com', 'A', '111222')).resolves.toBe(false);
  });
});

describe('boas-vindas (D-06)', () => {
  it('saldo de 200: 1ª foto paga e CTA para os Reels com UTM', async () => {
    const { service, send } = makeService();
    await service.sendWelcomeEmail('ana@mail.com', 'Ana', undefined, { locale: 'pt', credits: 200 });
    const mail = last(send);
    expect(mail.subject).toBe('Sua conta está pronta: a 1ª foto já está paga');
    expect(mail.html).toContain('200 créditos');
    expect(mail.html).toContain('https://www.theaimodelab.com/pt-br/x/reels?utm_source=email&utm_campaign=welcome');
    expect(mail.html).not.toContain('/checkout');
    expect(mail.html).toContain('/assets/brand/banners/email-pt-');
  });

  it('saldo abaixo de 200 não promete foto paga', async () => {
    const { service, send } = makeService();
    await service.sendWelcomeEmail('a@b.com', 'A', undefined, { locale: 'es', credits: 50 });
    expect(last(send).subject).toBe('Tu cuenta en The AI Model Lab está lista');
    expect(last(send).html).toContain('50 créditos');
  });
});

describe('isca (B-03)', () => {
  it('o botão abre o cadastro com o e-mail da compra preenchido', async () => {
    const { service, send } = makeService();
    await service.sendPendingGrantsEmail('maria+1@mail.com', 'María', 'es');
    const mail = last(send);
    expect(mail.html).toContain(
      'https://www.theaimodelab.com/es/login?modo=cadastro&email=maria%2B1%40mail.com&utm_source=email&utm_medium=acesso-isca',
    );
    expect(mail.html).toContain('38 generaciones gratis');
    expect(mail.html).toContain('/assets/brand/banners/email-es-');
  });

  it('pacote básico (Hubla/Hotmart/Cartpanda) lista os 6 itens', async () => {
    const { service, send } = makeService();
    await service.sendPendingGrantsEmail('a@b.com', null, 'pt', 'basic');
    expect(last(send).html).toContain('1 geração Nano Banana 2');
    expect(last(send).html).not.toContain('38 gerações');
  });
});

describe('compra sem conta (B-01)', () => {
  it('manda o link de cadastro com o e-mail e a UTM da compra sem conta', async () => {
    const { service, send } = makeService();
    const ok = await service.sendPurchaseWithoutAccountEmail('joao@mail.com', { locale: 'pt', productName: 'Plano Pro' });
    expect(ok).toBe(true);
    const mail = last(send);
    expect(mail.subject).toBe('Pagamento aprovado: crie sua conta para ativar');
    expect(mail.html).toContain(
      'https://www.theaimodelab.com/pt-br/login?modo=cadastro&email=joao%40mail.com&utm_source=email&utm_medium=compra-sem-conta',
    );
    expect(mail.html).toContain('Plano Pro');
  });
});
