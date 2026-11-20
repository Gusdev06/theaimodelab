import { isX1LinksEnabled, recoveryPlanFromName, withX1Footer, x1LocaleFrom, x1TelegramUrl, x1WhatsAppUrl } from '../x1-footer';

describe('x1-footer', () => {
  const original = process.env.EMAIL_X1_LINKS;
  afterEach(() => {
    if (original === undefined) delete process.env.EMAIL_X1_LINKS;
    else process.env.EMAIL_X1_LINKS = original;
  });

  it('põe WhatsApp e Telegram antes do </body>, no idioma pedido', () => {
    const out = withX1Footer('<html><body><p>oi</p></body></html>', 'es');
    expect(out).toContain('https://wa.me/5511922198321?text=MIA%20%C2%B7%20');
    expect(out).toContain('https://t.me/heaimodelab_bot?start=x1_es');
    expect(out).toContain('¿Prefieres hablar conmigo directo?');
    expect(out.indexOf('data-x1-footer')).toBeLessThan(out.indexOf('</body>'));
  });

  it('é idempotente e anexa ao fim quando não há </body>', () => {
    const once = withX1Footer('<p>oi</p>', 'en');
    expect(once.endsWith('</table>')).toBe(true);
    expect(withX1Footer(once, 'en')).toBe(once);
  });

  it('EMAIL_X1_LINKS=off desliga', () => {
    process.env.EMAIL_X1_LINKS = 'off';
    expect(isX1LinksEnabled()).toBe(false);
    expect(withX1Footer('<p>oi</p>', 'pt')).toBe('<p>oi</p>');
  });

  it('recuperação usa o payload rec_{plano}_{idioma}', () => {
    expect(x1TelegramUrl('pt', { recoveryPlan: 'pro' })).toBe('https://t.me/heaimodelab_bot?start=rec_pro_pt');
    expect(recoveryPlanFromName('Plano Creator mensal')).toBe('creator');
    expect(recoveryPlanFromName('Outro')).toBeNull();
  });

  it('resolve idioma e texto pré-preenchido por idioma', () => {
    expect(x1LocaleFrom('pt-BR')).toBe('pt');
    expect(x1LocaleFrom('es-MX')).toBe('es');
    expect(x1LocaleFrom(null)).toBe('en');
    expect(decodeURIComponent(x1WhatsAppUrl('pt').split('text=')[1])).toBe('MIA · Oi, Mia! Quero conversar com você.');
  });
});
