import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildVapidAuthorization,
  encryptPushPayload,
  isAllowedPushEndpoint,
  isValidVapidPair,
  type StoredPushSubscription,
} from './web-push.crypto';
import { buildPushMessage } from './web-push.texts';

/** Inscrições por conta (aparelhos). A mais velha sai quando passa disso. */
export const WEB_PUSH_MAX_SUBSCRIPTIONS = 5;
/** Chave no app_settings (chave-valor já existente: sem tabela nova nem SQL). */
export const webPushSettingKey = (userId: string) => `web_push:${userId}`;

const DEFAULT_SUBJECT = 'mailto:support@help.theaimodelab.com';
const PUSH_TTL_SECONDS = 24 * 60 * 60;
const SEND_TIMEOUT_MS = 10_000;

export interface PushSubscriptionInput {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown } | null;
}

export type SubscribeResult = { ok: true } | { ok: false; reason: 'disabled' | 'invalid' };

/**
 * Web Push (L16, molde Candy "Get App to Receive Notifications: New Messages, New Features, Sales and Discounts").
 * Desligado por padrão: WEB_PUSH_ENABLED=on E as duas chaves VAPID válidas. Sem chave = desligado, mesmo com a flag.
 * Envio sem custo por mensagem; falha de envio nunca derruba quem criou a notificação do sino.
 */
@Injectable()
export class WebPushService {
  private readonly logger = new Logger(WebPushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private vapid(): { publicKey: string; privateKey: string; subject: string } | null {
    if (!/^(on|true|1|yes)$/i.test(String(this.config.get<string>('WEB_PUSH_ENABLED') ?? '').trim())) return null;
    const publicKey = this.config.get<string>('WEB_PUSH_VAPID_PUBLIC_KEY')?.trim();
    const privateKey = this.config.get<string>('WEB_PUSH_VAPID_PRIVATE_KEY')?.trim();
    if (!isValidVapidPair(publicKey, privateKey)) return null;
    const subject = this.config.get<string>('WEB_PUSH_SUBJECT')?.trim() || DEFAULT_SUBJECT;
    return { publicKey: publicKey!, privateKey: privateKey!, subject };
  }

  isEnabled(): boolean {
    return this.vapid() !== null;
  }

  /** Chave pública para o navegador assinar. null = push desligado (o site não oferece o convite). */
  publicConfig(): { enabled: boolean; publicKey: string | null } {
    const vapid = this.vapid();
    return { enabled: !!vapid, publicKey: vapid?.publicKey ?? null };
  }

  private async read(userId: string): Promise<StoredPushSubscription[]> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: webPushSettingKey(userId) } });
    if (!row) return [];
    try {
      const parsed: unknown = JSON.parse(row.value);
      return Array.isArray(parsed) ? (parsed as StoredPushSubscription[]).filter((s) => typeof s?.endpoint === 'string') : [];
    } catch {
      return [];
    }
  }

  private async write(userId: string, subscriptions: StoredPushSubscription[]): Promise<void> {
    const key = webPushSettingKey(userId);
    if (subscriptions.length === 0) {
      await this.prisma.appSetting.deleteMany({ where: { key } });
      return;
    }
    const value = JSON.stringify(subscriptions);
    await this.prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  async subscribe(userId: string, input: PushSubscriptionInput, now: Date = new Date()): Promise<SubscribeResult> {
    if (!this.isEnabled()) return { ok: false, reason: 'disabled' };
    const endpoint = typeof input?.endpoint === 'string' ? input.endpoint.trim() : '';
    const p256dh = typeof input?.keys?.p256dh === 'string' ? input.keys.p256dh.trim() : '';
    const auth = typeof input?.keys?.auth === 'string' ? input.keys.auth.trim() : '';
    if (!endpoint || endpoint.length > 1024 || !isAllowedPushEndpoint(endpoint)) return { ok: false, reason: 'invalid' };
    if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) return { ok: false, reason: 'invalid' };

    const current = (await this.read(userId)).filter((s) => s.endpoint !== endpoint);
    current.push({ endpoint, keys: { p256dh, auth }, createdAt: now.toISOString() });
    await this.write(userId, current.slice(-WEB_PUSH_MAX_SUBSCRIPTIONS));
    return { ok: true };
  }

  async unsubscribe(userId: string, endpoint: unknown): Promise<{ ok: true }> {
    const target = typeof endpoint === 'string' ? endpoint.trim() : '';
    const current = await this.read(userId);
    const next = target ? current.filter((s) => s.endpoint !== target) : [];
    if (next.length !== current.length) await this.write(userId, next);
    return { ok: true };
  }

  /**
   * Push a partir de uma notificação do sino. Nunca lança: o chamador (NotificationsService.create) não espera.
   * Devolve quantos aparelhos aceitaram (para teste e log).
   */
  async notifyFromBell(userId: string, type: string, data?: Record<string, unknown>): Promise<number> {
    try {
      const vapid = this.vapid();
      if (!vapid) return 0;
      const subscriptions = await this.read(userId);
      if (subscriptions.length === 0) return 0;

      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { locale: true } });
      const message = buildPushMessage(type, data, user?.locale);
      if (!message) return 0;

      const site = (this.config.get<string>('FRONTEND_URL') ?? '').split(',')[0]?.trim().replace(/\/+$/, '') || 'https://www.theaimodelab.com';
      const payload = Buffer.from(
        JSON.stringify({ title: message.title, body: message.body, url: `${site}${message.path}`, tag: message.tag }),
        'utf8',
      );

      let delivered = 0;
      const gone: string[] = [];
      await Promise.all(
        subscriptions.map(async (subscription) => {
          try {
            const response = await fetch(subscription.endpoint, {
              method: 'POST',
              headers: {
                Authorization: buildVapidAuthorization({ endpoint: subscription.endpoint, ...vapid }),
                'Content-Encoding': 'aes128gcm',
                'Content-Type': 'application/octet-stream',
                TTL: String(PUSH_TTL_SECONDS),
                Urgency: 'normal',
              },
              body: new Uint8Array(encryptPushPayload(subscription.keys, payload)),
              signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
            });
            if (response.status === 404 || response.status === 410) gone.push(subscription.endpoint);
            else if (response.ok) delivered += 1;
            else this.logger.warn(`push recusado (${response.status}) para user ${userId}`);
          } catch (error) {
            this.logger.warn(`push falhou para user ${userId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }),
      );
      if (gone.length > 0) await this.write(userId, subscriptions.filter((s) => !gone.includes(s.endpoint)));
      return delivered;
    } catch (error) {
      this.logger.warn(`push do sino falhou (user ${userId}, ${type}): ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }
}
