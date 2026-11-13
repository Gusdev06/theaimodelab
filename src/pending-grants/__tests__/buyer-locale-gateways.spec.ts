import { localeFromCurrency, resolveBuyerLocale } from '../buyer-locale';
import { HotmartWebhookService } from '../hotmart-webhook.service';

/** B-08: Greenn, Hotmart e Cartpanda mandavam o e-mail de acesso sempre em inglês. */
describe('resolveBuyerLocale', () => {
  it('país decide antes da moeda', () => {
    expect(resolveBuyerLocale({ countries: ['BR'], currencies: ['USD'] })).toBe('pt');
    expect(resolveBuyerLocale({ countries: [undefined, 'Colombia'], currencies: [] })).toBe('es');
  });

  it('sem país, a moeda decide; USD/EUR não decidem', () => {
    expect(resolveBuyerLocale({ countries: [], currencies: ['MXN'] })).toBe('es');
    expect(resolveBuyerLocale({ countries: [], currencies: ['brl'] })).toBe('pt');
    expect(resolveBuyerLocale({ countries: [], currencies: ['USD'] })).toBe('en');
    expect(resolveBuyerLocale({}, 'pt')).toBe('pt');
    expect(localeFromCurrency('EUR')).toBeNull();
  });
});

describe('Hotmart · e-mail de acesso no idioma da compradora', () => {
  it('compra do Brasil sai em português com o pacote básico', async () => {
    const email = { sendPendingGrantsEmail: jest.fn(async () => undefined) };
    const service = new HotmartWebhookService(
      { get: jest.fn(() => undefined) } as any,
      { createPending: jest.fn(async () => ({ created: true })) } as any,
      { create: jest.fn(async () => ({ id: 'log-1' })) } as any,
      email as any,
    );
    jest.spyOn(service as any, 'verifyHottok').mockImplementation(() => undefined);

    await service.handle({
      event: 'PURCHASE_APPROVED',
      id: 'evt-1',
      data: {
        buyer: { email: 'joao@mail.com', name: 'João Silva', address: { country_iso: 'BR' } },
        purchase: { status: 'APPROVED', transaction: 'HP1', price: { currency_value: 'BRL' } },
      },
    } as any);

    expect(email.sendPendingGrantsEmail).toHaveBeenCalledWith('joao@mail.com', 'João', 'pt', 'basic');
  });
});
