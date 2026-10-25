import { ConfigService } from '@nestjs/config';
import { resolveBrand } from '../../brand/brand';
import { EmailService } from '../email.service';

const VALUES: Record<string, string> = {
  RESEND_FROM_EMAIL: 'The AI Model Lab <noreply@theaimodelab.com>',
  FRONTEND_URL: 'https://theaimodelab.com',
  LOGO_URL: 'https://cdn.theaimodelab.com/logo.png',
  FUNVMAKE_FRONTEND_URL: 'https://www.funvmake.com',
  FUNVMAKE_LOGO_URL: 'https://www.funvmake.com/logo-email.png',
};

function makeService() {
  const config = { get: (key: string) => (key === 'RESEND_API_KEY' ? undefined : VALUES[key]) } as unknown as ConfigService;
  const service = new EmailService(config);
  service.onModuleInit();
  const send = jest.fn().mockResolvedValue({ data: { id: 'email-1' }, error: null });
  (service as unknown as { client: unknown }).client = { emails: { send } };
  return { service, send };
}

const env = (key: string) => VALUES[key];

describe('EmailService · marca', () => {
  it('sem marca, o e-mail sai como sempre saiu', async () => {
    const { service, send } = makeService();
    await service.sendWelcomeEmail('a@b.com', 'Ana');
    const sent = send.mock.calls[0][0];
    expect(sent.from).toBe('The AI Model Lab <noreply@theaimodelab.com>');
    expect(sent.subject).toBe('Welcome to The AI Model Lab!');
    expect(sent.html).toContain('https://theaimodelab.com');
  });

  it('na Funvmake troca remetente, assunto, links e logo, sem sobrar a marca de origem', async () => {
    const { service, send } = makeService();
    await service.sendWelcomeEmail('a@b.com', 'Ana', resolveBrand('funvmake', env));
    const sent = send.mock.calls[0][0];
    expect(sent.from).toBe('Funvmake <noreply@theaimodelab.com>');
    expect(sent.subject).toBe('Welcome to Funvmake!');
    expect(sent.html).toContain('https://www.funvmake.com');
    expect(sent.html).not.toContain('The AI Model Lab');
    expect(sent.html).not.toContain('https://theaimodelab.com');
    expect(sent.to).toEqual(['a@b.com']);
  });

  it('o link de nova senha leva para o site da marca', async () => {
    const { service, send } = makeService();
    await service.sendPasswordResetEmail('a@b.com', 'Ana', 'tok123', resolveBrand('funvmake', env));
    const sent = send.mock.calls[0][0];
    expect(sent.html).toContain('https://www.funvmake.com/reset-password?token=tok123');
    expect(sent.subject).toBe('Reset your password — Funvmake');
  });

  it('o envio cru (crons) também respeita a marca', async () => {
    const { service, send } = makeService();
    await service.sendRawEmail({
      to: 'a@b.com',
      subject: 'Your credits — The AI Model Lab',
      html: '<a href="https://theaimodelab.com/pricing">The AI Model Lab</a>',
      brand: resolveBrand('funvmake', env),
    });
    const sent = send.mock.calls[0][0];
    expect(sent.subject).toBe('Your credits — Funvmake');
    expect(sent.html).toBe('<a href="https://www.funvmake.com/pricing">Funvmake</a>');
  });
});
