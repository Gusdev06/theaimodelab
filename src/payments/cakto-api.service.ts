import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Prefixo com que o externalSubscriptionId da Cakto é salvo (ver cakto-webhook.service). */
const CAKTO_SUB_PREFIX = 'cakto-sub-';

/**
 * Cliente HTTP da API pública da Cakto (gateway BRL do Brasil). Hoje usado só para
 * CANCELAR a recorrência: quando o usuário cancela no painel, chamamos a Cakto de
 * fato — sem isso, marcar cancelAtPeriodEnd localmente não interrompia a cobrança
 * mensal, que seguia até o cliente cancelar manualmente no gateway.
 *
 * Auth: OAuth client credentials. POST /public_api/token/ (form-urlencoded com
 * client_id + client_secret) → access_token Bearer (expires_in ~36000s, sem
 * refresh). O token é cacheado em memória até perto de expirar.
 *
 * Credenciais só em env (CAKTO_CLIENT_ID / CAKTO_CLIENT_SECRET). Sem elas, o
 * service fica "não configurado" e o chamador degrada graciosamente (só marca
 * cancelAtPeriodEnd local, comportamento anterior).
 */
@Injectable()
export class CaktoApiService {
  private readonly logger = new Logger(CaktoApiService.name);
  private readonly baseUrl = 'https://api.cakto.com.br/public_api';
  private readonly clientId: string;
  private readonly clientSecret: string;

  private accessToken: string | null = null;
  private tokenExpiresAt = 0; // epoch ms

  constructor(private readonly configService: ConfigService) {
    this.clientId = this.configService.get<string>('CAKTO_CLIENT_ID', '').trim();
    this.clientSecret = this.configService
      .get<string>('CAKTO_CLIENT_SECRET', '')
      .trim();
  }

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  /**
   * Normaliza o externalSubscriptionId salvo (`cakto-sub-<uuid>`) para o UUID puro
   * que a API da Cakto espera na rota /subscriptions/{id}/cancel/.
   */
  static toCaktoSubscriptionId(externalSubscriptionId: string): string {
    return externalSubscriptionId.startsWith(CAKTO_SUB_PREFIX)
      ? externalSubscriptionId.slice(CAKTO_SUB_PREFIX.length)
      : externalSubscriptionId;
  }

  /**
   * Cancela IMEDIATAMENTE a recorrência na Cakto (interrompe as cobranças futuras).
   * O acesso do usuário no app segue até o fim do período pago — quem controla isso
   * é o cancelAtPeriodEnd/cron, não esta chamada. A Cakto ainda dispara o webhook
   * `subscription_canceled` de volta, que é idempotente com o cancelamento local.
   *
   * 404 é tratado como sucesso (assinatura já inexistente/cancelada na Cakto).
   */
  async cancelSubscription(externalSubscriptionId: string): Promise<void> {
    const id = CaktoApiService.toCaktoSubscriptionId(externalSubscriptionId);
    const token = await this.getAccessToken();
    const url = `${this.baseUrl}/subscriptions/${encodeURIComponent(id)}/cancel/`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'theaimodelab-api',
      },
    });

    if (!res.ok) {
      if (res.status === 404) {
        this.logger.warn(
          `Cakto subscription ${id} não encontrada (404) — tratando como já cancelada`,
        );
        return;
      }
      const text = await res.text().catch(() => '');
      throw new Error(
        `Cakto cancel falhou: HTTP ${res.status} ${text.slice(0, 300)}`,
      );
    }

    this.logger.log(`Cakto subscription ${id} cancelada via API`);
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiresAt) {
      return this.accessToken;
    }

    const form = new URLSearchParams();
    form.set('client_id', this.clientId);
    form.set('client_secret', this.clientSecret);

    const res = await fetch(`${this.baseUrl}/token/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': 'theaimodelab-api',
      },
      body: form.toString(),
    });

    const text = await res.text();
    let parsed: { access_token?: string; expires_in?: number } = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }

    if (!res.ok || !parsed.access_token) {
      throw new Error(
        `Cakto auth falhou: HTTP ${res.status} ${text.slice(0, 200)}`,
      );
    }

    this.accessToken = parsed.access_token;
    // Renova 60s antes de expirar por margem (default 36000s se a Cakto omitir).
    const ttlMs = (parsed.expires_in ?? 36000) * 1000;
    this.tokenExpiresAt = now + ttlMs - 60_000;
    return this.accessToken;
  }
}
