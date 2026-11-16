import { createHash } from 'crypto';
import { MetaConversionsService } from '../meta-conversions.service';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function buildService(env: Record<string, string | undefined>) {
  const config = { get: (key: string) => env[key] } as never;
  return new MetaConversionsService(config);
}

const baseEnv = {
  META_PIXEL_ID: '123',
  META_ACCESS_TOKEN: 'token-abc',
  FRONTEND_URL: 'https://www.theaimodelab.com',
};

const purchaseInput = (purchaseType: 'subscription' | 'credit_package') => ({
  user: {
    id: 'user-1',
    email: 'Cliente@Exemplo.com',
    name: 'Ana Souza',
    phone: '+1 (555) 010-2030',
    country: 'US',
    fbclid: 'IwAR123',
    createdAt: new Date('2026-11-10T12:00:00Z'),
  },
  eventId: 'PPV123',
  contentId: 'pro',
  contentName: 'Pro',
  valueCents: 2990,
  currency: 'usd',
  orderId: 'PPV123',
  provider: 'perfectpay',
  purchaseType,
});

describe('MetaConversionsService', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, text: async () => '{"events_received":1}' });
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  it('não manda nada quando META_CAPI_EVENTS está vazia (comportamento desde 29/07)', async () => {
    const service = buildService(baseEnv);
    await service.trackPurchase(purchaseInput('subscription'));
    await service.trackLead({ id: 'user-1', email: 'a@b.com' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('assinatura sai como Subscribe e pacote não sai sem Purchase na lista', async () => {
    const service = buildService({ ...baseEnv, META_CAPI_EVENTS: 'Lead, Subscribe' });
    await service.trackPurchase(purchaseInput('credit_package'));
    expect(fetchMock).not.toHaveBeenCalled();

    await service.trackPurchase(purchaseInput('subscription'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const event = body.data[0];
    expect(event.event_name).toBe('Subscribe');
    expect(event.event_id).toBe('PPV123');
    expect(event.custom_data).toMatchObject({ currency: 'USD', value: 29.9 });
  });

  it('manda o mesmo evento (mesmo event_id) para cada pixel de META_PIXEL_ID', async () => {
    const service = buildService({ ...baseEnv, META_PIXEL_ID: '1223791793200733, 1327084455720433,1223791793200733', META_CAPI_EVENTS: 'Subscribe' });
    await service.trackPurchase(purchaseInput('subscription'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toContain('/1223791793200733/events');
    expect(urls[1]).toContain('/1327084455720433/events');
    const ids = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).data[0].event_id);
    expect(ids).toEqual(['PPV123', 'PPV123']);
  });

  it('normaliza telefone, país e monta fbc a partir do fbclid', () => {
    const service = buildService(baseEnv);
    const userData = service.buildUserData({
      eventName: 'Subscribe',
      user: purchaseInput('subscription').user,
    });
    expect(userData.em).toEqual([sha('cliente@exemplo.com')]);
    expect(userData.ph).toEqual([sha('15550102030')]);
    expect(userData.country).toEqual([sha('us')]);
    expect(userData.fbc).toBe(`fb.1.${new Date('2026-11-10T12:00:00Z').getTime()}.IwAR123`);
  });

  it('descarta país fora do ISO alfa-2 e telefone curto, e respeita o fbc do cookie', () => {
    const service = buildService(baseEnv);
    const userData = service.buildUserData({
      eventName: 'Lead',
      user: { id: 'u', email: 'x@y.com', country: 'Brazil', phone: '123', fbclid: 'IwAR9' },
      fbc: 'fb.1.1700000000000.COOKIE',
    });
    expect(userData.country).toBeUndefined();
    expect(userData.ph).toBeUndefined();
    expect(userData.fbc).toBe('fb.1.1700000000000.COOKIE');
  });
});
