import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'crypto';
import {
  base64UrlDecode,
  base64UrlEncode,
  buildVapidAuthorization,
  encryptPushPayload,
  generateVapidKeys,
  isAllowedPushEndpoint,
  isValidVapidPair,
} from './web-push.crypto';
import { buildPushMessage, pushLocaleOf } from './web-push.texts';
import { WebPushService, webPushSettingKey } from './web-push.service';
import { NotificationsService } from '../notifications/notifications.service';

/** Decifra como o navegador faria (RFC 8291), para provar que a cifra está certa. */
function decryptLikeBrowser(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const shared = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  expect(plain[plain.length - 1]).toBe(0x02);
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

function browserSubscription() {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  return {
    ua,
    auth,
    keys: { p256dh: base64UrlEncode(ua.getPublicKey()), auth: base64UrlEncode(auth) },
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  };
}

function makeService(env: Record<string, string | undefined>, stored: Record<string, string> = {}) {
  const prisma = {
    appSetting: {
      findUnique: jest.fn(async ({ where }: { where: { key: string } }) => (stored[where.key] ? { key: where.key, value: stored[where.key] } : null)),
      upsert: jest.fn(async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        stored[where.key] = create.value;
      }),
      deleteMany: jest.fn(async ({ where }: { where: { key: string } }) => {
        delete stored[where.key];
      }),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ locale: 'es' }) },
    notification: { create: jest.fn(async ({ data }: { data: unknown }) => ({ id: 'n1', ...(data as object) })) },
  };
  const config = { get: jest.fn((key: string) => env[key]) };
  return { service: new WebPushService(prisma as never, config as never), prisma, stored };
}

describe('Web Push (L16)', () => {
  const vapid = generateVapidKeys();
  const onEnv = { WEB_PUSH_ENABLED: 'on', WEB_PUSH_VAPID_PUBLIC_KEY: vapid.publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: vapid.privateKey };

  afterEach(() => jest.restoreAllMocks());

  describe('criptografia', () => {
    it('payload aes128gcm abre no navegador (RFC 8291)', () => {
      const sub = browserSubscription();
      const body = encryptPushPayload(sub.keys, Buffer.from('{"title":"Oi"}'));
      expect(body.readUInt32BE(16)).toBe(4096);
      expect(decryptLikeBrowser(body, sub.ua.getPrivateKey(), sub.ua.getPublicKey(), sub.auth)).toBe('{"title":"Oi"}');
    });

    it('JWT do VAPID é ES256 válido para a origem do endpoint', () => {
      const header = buildVapidAuthorization({
        endpoint: 'https://fcm.googleapis.com/fcm/send/x',
        publicKey: vapid.publicKey,
        privateKey: vapid.privateKey,
        subject: 'mailto:a@b.com',
        nowSeconds: 1_000,
      });
      const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
      expect(match).not.toBeNull();
      const [, h, c, s, k] = match!;
      expect(k).toBe(vapid.publicKey);
      expect(JSON.parse(base64UrlDecode(c).toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_000 + 43_200, sub: 'mailto:a@b.com' });
      const pub = base64UrlDecode(vapid.publicKey);
      const key = createPublicKey({
        key: { kty: 'EC', crv: 'P-256', x: base64UrlEncode(pub.subarray(1, 33)), y: base64UrlEncode(pub.subarray(33)) },
        format: 'jwk',
      });
      expect(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, base64UrlDecode(s))).toBe(true);
    });

    it('chaves e endpoints', () => {
      expect(isValidVapidPair(vapid.publicKey, vapid.privateKey)).toBe(true);
      expect(isValidVapidPair('', vapid.privateKey)).toBe(false);
      expect(isValidVapidPair('abc', 'def')).toBe(false);
      expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/1')).toBe(true);
      expect(isAllowedPushEndpoint('https://web.push.apple.com/abc')).toBe(true);
      expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
      expect(isAllowedPushEndpoint('https://evil.example.com/fcm.googleapis.com')).toBe(false);
      expect(isAllowedPushEndpoint('http://fcm.googleapis.com/x')).toBe(false);
    });
  });

  describe('textos', () => {
    it('usa o reason da notificação quando existe, na língua da conta', () => {
      expect(buildPushMessage('payment-declined-fallback', { reason: 'Texto pronto' }, 'pt-BR')).toEqual(
        expect.objectContaining({ title: 'Seu pagamento não passou', body: 'Texto pronto' }),
      );
      expect(buildPushMessage('tipo-novo', undefined, 'en')?.title).toBe('New on The AI Model Lab');
      expect(buildPushMessage('community-submitted', undefined, 'pt-BR')).toBeNull();
      expect(pushLocaleOf('es-MX')).toBe('es');
      expect(pushLocaleOf(null)).toBe('en');
    });
  });

  describe('flag off: nada muda', () => {
    it.each([
      [{}],
      [{ WEB_PUSH_ENABLED: 'on' }],
      [{ WEB_PUSH_ENABLED: 'off', WEB_PUSH_VAPID_PUBLIC_KEY: vapid.publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: vapid.privateKey }],
    ])('env %p = desligado, sem inscrição e sem envio', async (env) => {
      const { service, prisma } = makeService(env as Record<string, string>);
      const fetchSpy = jest.spyOn(global, 'fetch');
      expect(service.publicConfig()).toEqual({ enabled: false, publicKey: null });
      const sub = browserSubscription();
      await expect(service.subscribe('u1', { endpoint: sub.endpoint, keys: sub.keys })).resolves.toEqual({ ok: false, reason: 'disabled' });
      await expect(service.notifyFromBell('u1', 'prepaid-expired')).resolves.toBe(0);
      expect(prisma.appSetting.upsert).not.toHaveBeenCalled();
      expect(prisma.appSetting.findUnique).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('NotificationsService sem push cria a notificação igual a hoje', async () => {
      const { prisma } = makeService({});
      const plain = new NotificationsService(prisma as never);
      await expect(plain.create('u1', 'prepaid-expired', { a: 1 })).resolves.toEqual(expect.objectContaining({ id: 'n1', type: 'prepaid-expired' }));
      const { service } = makeService({});
      const withOff = new NotificationsService(prisma as never, service);
      const spy = jest.spyOn(service, 'notifyFromBell');
      await withOff.create('u1', 'prepaid-expired');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('flag on', () => {
    it('inscreve (até 5 aparelhos), recusa endpoint estranho e envia o aviso do sino', async () => {
      const { service, stored } = makeService(onEnv);
      const sub = browserSubscription();
      await expect(service.subscribe('u1', { endpoint: 'https://evil.example.com/x', keys: sub.keys })).resolves.toEqual({ ok: false, reason: 'invalid' });
      await expect(service.subscribe('u1', { endpoint: sub.endpoint, keys: sub.keys })).resolves.toEqual({ ok: true });
      expect(JSON.parse(stored[webPushSettingKey('u1')])).toHaveLength(1);

      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
      await expect(service.notifyFromBell('u1', 'prepaid-expiring', {})).resolves.toBe(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(sub.endpoint);
      expect((init.headers as Record<string, string>)['Content-Encoding']).toBe('aes128gcm');
      const text = decryptLikeBrowser(Buffer.from(init.body as Uint8Array), sub.ua.getPrivateKey(), sub.ua.getPublicKey(), sub.auth);
      expect(JSON.parse(text)).toEqual(expect.objectContaining({ title: 'Tu acceso termina pronto', url: 'https://www.theaimodelab.com/' }));
    });

    it('endpoint que morreu (410) sai da lista', async () => {
      const { service, stored } = makeService(onEnv);
      const sub = browserSubscription();
      await service.subscribe('u1', { endpoint: sub.endpoint, keys: sub.keys });
      jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 410 }));
      await expect(service.notifyFromBell('u1', 'prepaid-expired')).resolves.toBe(0);
      expect(stored[webPushSettingKey('u1')]).toBeUndefined();
    });

    it('guarda no máximo 5 aparelhos', async () => {
      const { service, stored } = makeService(onEnv);
      for (let i = 0; i < 7; i += 1) {
        const sub = browserSubscription();
        await service.subscribe('u1', { endpoint: `https://fcm.googleapis.com/fcm/send/${i}`, keys: sub.keys });
      }
      const list = JSON.parse(stored[webPushSettingKey('u1')]) as { endpoint: string }[];
      expect(list).toHaveLength(5);
      expect(list[0].endpoint).toMatch(/\/2$/);
    });

    it('falha de rede nunca lança', async () => {
      const { service } = makeService(onEnv);
      const sub = browserSubscription();
      await service.subscribe('u1', { endpoint: sub.endpoint, keys: sub.keys });
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('rede'));
      await expect(service.notifyFromBell('u1', 'prepaid-expired')).resolves.toBe(0);
    });
  });
});
