import { EmailService } from '../email.service';

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: jest.fn() } })),
}));

/** TKT-004: e-mail de acesso da isca no idioma do comprador, com o link do site no mesmo idioma. */
function buildService() {
  const config = {
    get: (key: string) =>
      ({
        RESEND_API_KEY: 'test-key',
        RESEND_FROM_EMAIL: 'noreply@theaimodelab.com',
        FRONTEND_URL: 'https://www.theaimodelab.com',
        LOGO_URL: '',
      })[key],
  } as any;
  const service = new EmailService(config);
  service.onModuleInit();
  const send = jest.fn(async () => ({ error: null }));
  (service as any).client = { emails: { send } };
  return { service, send };
}

function lastEmail(send: jest.Mock): { subject: string; html: string; to: string[] } {
  return send.mock.calls[send.mock.calls.length - 1][0];
}

describe('EmailService.sendPendingGrantsEmail', () => {
  it('es: assunto e texto em espanhol, botão para /es/login', async () => {
    const { service, send } = buildService();
    await service.sendPendingGrantsEmail('maria@mail.com', 'María', 'es');

    const mail = lastEmail(send);
    expect(mail.to).toEqual(['maria@mail.com']);
    expect(mail.subject).toBe('¡Ganaste generaciones gratis en The AI Model Lab! 🎉');
    expect(mail.html).toContain('¡Hola, María!');
    expect(mail.html).toContain('https://www.theaimodelab.com/es/login');
    expect(mail.html).toContain('Crear mi cuenta y activar');
    expect(mail.html).not.toContain('Create my account');
  });

  it('pt: texto em português, botão para /pt-br/login', async () => {
    const { service, send } = buildService();
    await service.sendPendingGrantsEmail('joao@mail.com', null, 'pt');

    const mail = lastEmail(send);
    expect(mail.subject).toBe('Você ganhou gerações grátis no The AI Model Lab! 🎉');
    expect(mail.html).toContain('Oi! Você ganhou gerações grátis');
    expect(mail.html).toContain('https://www.theaimodelab.com/pt-br/login');
  });

  it('en (padrão): texto em inglês, botão para /en/login', async () => {
    const { service, send } = buildService();
    await service.sendPendingGrantsEmail('john@mail.com', 'John');

    const mail = lastEmail(send);
    expect(mail.subject).toBe('You earned free generations on The AI Model Lab! 🎉');
    expect(mail.html).toContain('Hi, John!');
    expect(mail.html).toContain('https://www.theaimodelab.com/en/login');
  });

  it('sendPendingGrantsEmailEs (nome antigo) continua mandando em inglês', async () => {
    const { service, send } = buildService();
    await service.sendPendingGrantsEmailEs('x@mail.com', 'Ana');

    const mail = lastEmail(send);
    expect(mail.subject).toBe('You earned free generations on The AI Model Lab! 🎉');
    expect(mail.html).toContain('Hi, Ana!');
  });

  it('sem cliente configurado não manda nem explode', async () => {
    const { service, send } = buildService();
    (service as any).client = null;
    await expect(service.sendPendingGrantsEmail('x@mail.com', null, 'es')).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});
