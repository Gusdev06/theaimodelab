import type { MiaChatterConfig } from './mia-chatter.config';

/**
 * Cliente da API oficial da Fanvue (OAuth 2 com PKCE; escopos read:chat e write:chat). Fala só o que a Mia precisa:
 * trocar o código por token, renovar, saber quem é a criadora, ler as conversas, ler as mensagens de um fã e responder.
 *
 * As respostas passam por normalizadores tolerantes (campos com nomes alternativos, `data` ou lista crua, preço em
 * centavos ou dólar): se a Fanvue mudar um nome, o pior caso é a Mia não ver a conversa, nunca responder errado.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FanvueTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scope: string | null;
}

export interface FanvueCreator {
  uuid: string;
  handle: string | null;
  displayName: string | null;
}

export interface FanvueChat {
  fanUuid: string;
  handle: string | null;
  displayName: string | null;
  unread: number;
  lastMessageAt: Date | null;
  /** gasto total do fã com a criadora, quando a API informa (US$) */
  spentUsd: number | null;
}

export interface FanvueMessage {
  uuid: string;
  text: string;
  sentAt: Date | null;
  fromFan: boolean;
  /** preço do PPV em US$ quando a mensagem é paga */
  priceUsd: number | null;
  purchased: boolean;
}

export class FanvueApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function asString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function asDate(...values: unknown[]): Date | null {
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function listOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const object = asObject(payload);
  if (!object) return [];
  for (const key of ['data', 'items', 'results', 'chats', 'messages']) {
    if (Array.isArray(object[key])) return object[key] as unknown[];
  }
  return [];
}

/** Centavos → dólar quando a unidade é centavos; números não finitos viram null. */
export function moneyToUsd(value: unknown, unit: 'cents' | 'usd'): number | null {
  const raw = typeof value === 'string' ? Number(value) : value;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return unit === 'cents' ? Math.round(raw) / 100 : Math.round(raw * 100) / 100;
}

export function normalizeChats(payload: unknown, unit: 'cents' | 'usd'): FanvueChat[] {
  const chats: FanvueChat[] = [];
  for (const item of listOf(payload)) {
    const chat = asObject(item);
    if (!chat) continue;
    const user = asObject(chat.user) ?? asObject(chat.fan) ?? asObject(chat.otherUser) ?? chat;
    const fanUuid = asString(user.uuid, user.userUuid, chat.userUuid, chat.fanUuid);
    if (!fanUuid) continue;
    const lastMessage = asObject(chat.lastMessage);
    const spent = moneyToUsd(user.totalSpent ?? user.spent ?? chat.totalSpent ?? chat.fanSpend ?? null, unit);
    chats.push({
      fanUuid,
      handle: asString(user.handle, user.username),
      displayName: asString(user.displayName, user.nickname, user.name),
      unread: Number(chat.unreadMessagesCount ?? chat.unreadCount ?? chat.unread ?? 0) || 0,
      lastMessageAt: asDate(lastMessage?.sentAt, lastMessage?.createdAt, chat.lastMessageAt, chat.updatedAt),
      spentUsd: spent,
    });
  }
  return chats;
}

export function normalizeMessages(payload: unknown, fanUuid: string, unit: 'cents' | 'usd'): FanvueMessage[] {
  const messages: FanvueMessage[] = [];
  for (const item of listOf(payload)) {
    const message = asObject(item);
    if (!message) continue;
    const uuid = asString(message.uuid, message.id);
    if (!uuid) continue;
    const sender = asObject(message.sender) ?? asObject(message.from);
    const senderUuid = asString(sender?.uuid, message.senderUuid, message.senderId);
    const price = moneyToUsd(message.price ?? message.priceCents ?? null, unit);
    const purchased = Boolean(message.purchasedAt ?? message.isPurchased ?? message.hasBeenPurchased ?? message.unlockedAt ?? false);
    messages.push({
      uuid,
      text: asString(message.text, message.content, message.body) ?? '',
      sentAt: asDate(message.sentAt, message.createdAt),
      fromFan: senderUuid === fanUuid,
      priceUsd: price,
      purchased: price !== null && purchased,
    });
  }
  // mais antiga primeiro: o roteiro lê na ordem da conversa
  return messages.sort((a, b) => (a.sentAt?.getTime() ?? 0) - (b.sentAt?.getTime() ?? 0));
}

export function buildAuthorizeUrl(
  config: MiaChatterConfig['fanvue'],
  params: { state: string; codeChallenge: string },
): string {
  const url = new URL(config.authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scopes);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export class FanvueClient {
  constructor(
    private readonly config: MiaChatterConfig['fanvue'],
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly timeoutMs = 20_000,
  ) {}

  private async call(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { ...init, signal: controller.signal });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const object = asObject(body);
        const message = asString(object?.error_description, object?.message, object?.error) ?? `HTTP ${res.status}`;
        throw new FanvueApiError(res.status, message.slice(0, 200));
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  private async token(form: Record<string, string>): Promise<FanvueTokens> {
    const body = new URLSearchParams(form);
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (this.config.tokenAuth === 'basic') {
      headers.Authorization = `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`;
    } else {
      body.set('client_id', this.config.clientId);
      body.set('client_secret', this.config.clientSecret);
    }
    const payload = asObject(await this.call(this.config.tokenUrl, { method: 'POST', headers, body: body.toString() })) ?? {};
    const accessToken = asString(payload.access_token);
    if (!accessToken) throw new FanvueApiError(502, 'token sem access_token');
    const expiresIn = Number(payload.expires_in);
    return {
      accessToken,
      refreshToken: asString(payload.refresh_token),
      expiresAt: new Date(Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000),
      scope: asString(payload.scope),
    };
  }

  exchangeCode(code: string, verifier: string): Promise<FanvueTokens> {
    return this.token({ grant_type: 'authorization_code', code, redirect_uri: this.config.redirectUri, code_verifier: verifier });
  }

  refresh(refreshToken: string): Promise<FanvueTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  private headers(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      'X-Fanvue-API-Version': this.config.apiVersion,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  async getCreator(accessToken: string): Promise<FanvueCreator> {
    const payload = asObject(await this.call(`${this.config.apiBase}/users/me`, { method: 'GET', headers: this.headers(accessToken) })) ?? {};
    const user = asObject(payload.data) ?? payload;
    const uuid = asString(user.uuid, user.id);
    if (!uuid) throw new FanvueApiError(502, 'perfil sem uuid');
    return { uuid, handle: asString(user.handle, user.username), displayName: asString(user.displayName, user.name) };
  }

  async listChats(accessToken: string, size = 50): Promise<FanvueChat[]> {
    const payload = await this.call(`${this.config.apiBase}/chats?page=1&size=${size}`, { method: 'GET', headers: this.headers(accessToken) });
    return normalizeChats(payload, this.config.priceUnit);
  }

  async listMessages(accessToken: string, fanUuid: string, size = 30): Promise<FanvueMessage[]> {
    const payload = await this.call(`${this.config.apiBase}/chats/${encodeURIComponent(fanUuid)}/messages?page=1&size=${size}`, {
      method: 'GET',
      headers: this.headers(accessToken),
    });
    return normalizeMessages(payload, fanUuid, this.config.priceUnit);
  }

  async sendMessage(accessToken: string, fanUuid: string, message: { text: string; mediaUuids?: string[]; priceUsd?: number | null }): Promise<string | null> {
    const body: Json = { text: message.text };
    if (message.mediaUuids?.length) {
      body.mediaUuids = message.mediaUuids;
      if (message.priceUsd && message.priceUsd > 0) {
        body.price = this.config.priceUnit === 'cents' ? Math.round(message.priceUsd * 100) : message.priceUsd;
      }
    }
    const payload = asObject(
      await this.call(`${this.config.apiBase}/chats/${encodeURIComponent(fanUuid)}/message`, {
        method: 'POST',
        headers: this.headers(accessToken),
        body: JSON.stringify(body),
      }),
    );
    return asString(payload?.messageUuid, payload?.uuid, asObject(payload?.data)?.uuid);
  }
}
