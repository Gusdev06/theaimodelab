import {
  applyBrand,
  brandedFrom,
  brandKeyFor,
  detectBrandFromHeaders,
  funvmakeHosts,
  resolveBrand,
} from '../brand';

const env = (values: Record<string, string>) => (key: string) => values[key];

const ON = env({
  FRONTEND_URL: 'https://theaimodelab.com',
  LOGO_URL: 'https://cdn.theaimodelab.com/logo.png',
  RESEND_FROM_EMAIL: 'The AI Model Lab <noreply@theaimodelab.com>',
  FUNVMAKE_FRONTEND_URL: 'https://www.funvmake.com/',
  FUNVMAKE_HOSTS: 'web-production-7cef71.up.railway.app',
  FUNVMAKE_LOGO_URL: 'https://www.funvmake.com/logo-email.png',
});
const OFF = env({ FRONTEND_URL: 'https://theaimodelab.com' });

describe('brand', () => {
  it('reconhece a Funvmake pelo Origin, Referer, x-brand e host extra; o resto é a origem', () => {
    expect(funvmakeHosts(ON)).toEqual(
      new Set(['www.funvmake.com', 'funvmake.com', 'web-production-7cef71.up.railway.app']),
    );
    expect(detectBrandFromHeaders({ origin: 'https://funvmake.com' }, ON)).toBe('funvmake');
    expect(detectBrandFromHeaders({ origin: 'https://www.funvmake.com' }, ON)).toBe('funvmake');
    expect(detectBrandFromHeaders({ referer: 'https://www.funvmake.com/pt-br/login' }, ON)).toBe('funvmake');
    expect(detectBrandFromHeaders({ origin: 'https://web-production-7cef71.up.railway.app' }, ON)).toBe('funvmake');
    expect(detectBrandFromHeaders({ 'x-brand': 'funvmake' }, ON)).toBe('funvmake');
    expect(detectBrandFromHeaders({ origin: 'https://www.theaimodelab.com' }, ON)).toBeNull();
    expect(detectBrandFromHeaders({ origin: 'https://funvmake.com.evil.io' }, ON)).toBeNull();
    expect(detectBrandFromHeaders({ 'x-brand': 'outra' }, ON)).toBeNull();
    expect(detectBrandFromHeaders({}, ON)).toBeNull();
  });

  it('sem FUNVMAKE_FRONTEND_URL a Funvmake não existe: tudo é a origem', () => {
    expect(detectBrandFromHeaders({ origin: 'https://funvmake.com', 'x-brand': 'funvmake' }, OFF)).toBeNull();
    expect(resolveBrand('funvmake', OFF).key).toBe('taml');
  });

  it('o site que pediu vence a marca gravada; sem pedido, vale a gravada; desconhecida = origem', () => {
    expect(brandKeyFor('funvmake', null)).toBe('funvmake');
    expect(brandKeyFor(null, 'funvmake')).toBe('funvmake');
    expect(brandKeyFor(null, null)).toBe('taml');
    expect(brandKeyFor(null, 'xyz')).toBe('taml');
  });

  it('remetente: o da marca, senão o da origem com o nome trocado', () => {
    const funvmake = resolveBrand('funvmake', ON);
    expect(brandedFrom('The AI Model Lab <noreply@theaimodelab.com>', funvmake)).toBe('Funvmake <noreply@theaimodelab.com>');
    expect(brandedFrom('noreply@theaimodelab.com', funvmake)).toBe('Funvmake <noreply@theaimodelab.com>');
    expect(brandedFrom('x@y.com', resolveBrand(null, ON))).toBe('x@y.com');
    const own = resolveBrand('funvmake', env({ FUNVMAKE_FRONTEND_URL: 'https://funvmake.com', FUNVMAKE_EMAIL_FROM: 'Funvmake <oi@funvmake.com>' }));
    expect(brandedFrom('The AI Model Lab <noreply@theaimodelab.com>', own)).toBe('Funvmake <oi@funvmake.com>');
  });

  it('troca nome, site e logo no e-mail montado; na origem não mexe', () => {
    const message = {
      subject: 'Welcome to The AI Model Lab!',
      html: '<img src="https://cdn.theaimodelab.com/logo.png"><a href="https://theaimodelab.com/login">The AI Model Lab</a>',
    };
    const origin = { frontendUrl: 'https://theaimodelab.com', logoUrl: 'https://cdn.theaimodelab.com/logo.png' };
    expect(applyBrand(message, resolveBrand(null, ON), origin)).toBe(message);
    const out = applyBrand(message, resolveBrand('funvmake', ON), origin);
    expect(out.subject).toBe('Welcome to Funvmake!');
    expect(out.html).toBe('<img src="https://www.funvmake.com/logo-email.png"><a href="https://www.funvmake.com/login">Funvmake</a>');
  });
});
