import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign, type KeyObject } from 'crypto';

/**
 * Web Push sem dependência nova (o repo não tem `web-push` e a regra é não instalar pacote no meio da PR):
 * VAPID (RFC 8292, JWT ES256) + criptografia do payload aes128gcm (RFC 8291 / RFC 8188), só com o `crypto` do Node.
 */

export interface PushSubscriptionKeys {
  /** chave pública P-256 do navegador, base64url (65 bytes descomprimida) */
  p256dh: string;
  /** segredo de autenticação, base64url (16 bytes) */
  auth: string;
}

export interface StoredPushSubscription {
  endpoint: string;
  keys: PushSubscriptionKeys;
  createdAt: string;
}

export function base64UrlEncode(input: Buffer | Uint8Array): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

/** Par VAPID novo (base64url): public = 65 bytes descomprimida, private = 32 bytes (d). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: base64UrlEncode(ecdh.getPublicKey()), privateKey: base64UrlEncode(ecdh.getPrivateKey()) };
}

/** Confere o formato das chaves da env (sem isso o push fica desligado). */
export function isValidVapidPair(publicKey: string | undefined | null, privateKey: string | undefined | null): boolean {
  if (!publicKey || !privateKey) return false;
  try {
    const pub = base64UrlDecode(publicKey);
    const priv = base64UrlDecode(privateKey);
    return pub.length === 65 && pub[0] === 0x04 && priv.length === 32;
  } catch {
    return false;
  }
}

function vapidPrivateKeyObject(publicKey: string, privateKey: string): KeyObject {
  const pub = base64UrlDecode(publicKey);
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: privateKey,
      x: base64UrlEncode(pub.subarray(1, 33)),
      y: base64UrlEncode(pub.subarray(33, 65)),
    },
    format: 'jwk',
  });
}

/** Cabeçalho Authorization do VAPID para o serviço de push do endpoint. Validade padrão: 12 h. */
export function buildVapidAuthorization(input: {
  endpoint: string;
  publicKey: string;
  privateKey: string;
  subject: string;
  nowSeconds?: number;
  ttlSeconds?: number;
}): string {
  const audience = new URL(input.endpoint).origin;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = base64UrlEncode(
    Buffer.from(JSON.stringify({ aud: audience, exp: now + (input.ttlSeconds ?? 12 * 60 * 60), sub: input.subject })),
  );
  const signingInput = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: vapidPrivateKeyObject(input.publicKey, input.privateKey),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${signingInput}.${base64UrlEncode(signature)}, k=${input.publicKey}`;
}

const RECORD_SIZE = 4096;

/**
 * Criptografa o payload para o navegador (aes128gcm, 1 registro). `salt` e `ephemeral` só entram nos testes.
 */
export function encryptPushPayload(
  keys: PushSubscriptionKeys,
  payload: Buffer,
  testing?: { salt?: Buffer; ephemeralPrivateKey?: Buffer },
): Buffer {
  const uaPublic = base64UrlDecode(keys.p256dh);
  const authSecret = base64UrlDecode(keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('chaves da inscrição inválidas');

  const ecdh = createECDH('prime256v1');
  if (testing?.ephemeralPrivateKey) ecdh.setPrivateKey(testing.ephemeralPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const salt = testing?.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  // 1 registro só: payload + delimitador 0x02 (último registro), sem preenchimento
  if (payload.length + 1 + 16 > RECORD_SIZE) throw new Error('payload grande demais para 1 registro');
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, encrypted]);
}

/** Serviços de push conhecidos: inscrição para outro host é recusada (evita usar a API para chamar URL qualquer). */
const PUSH_SERVICE_HOSTS: readonly RegExp[] = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^[a-z0-9.-]+\.notify\.windows\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9.-]+\.push\.apple\.com$/,
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') return false;
    return PUSH_SERVICE_HOSTS.some((pattern) => pattern.test(url.hostname));
  } catch {
    return false;
  }
}
