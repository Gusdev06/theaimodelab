import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { MetaEventContextDto } from './meta-event-context.dto';
import { ORIGIN_SITE_URL, originSiteUrl } from '../brand/brand';

type MetaEventName =
  | 'PageView'
  | 'ViewContent'
  | 'Lead'
  | 'InitiateCheckout'
  | 'Purchase'
  | 'Subscribe';

type MetaUser = {
  id?: string;
  email?: string | null;
  name?: string | null;
  phone?: string | null;
  country?: string | null;
  fbp?: string | null;
  fbc?: string | null;
  fbclid?: string | null;
  createdAt?: Date | string | null;
};

export type MetaRequestContext = {
  ipAddress?: string;
  userAgent?: string;
};

type TrackEventInput = {
  eventName: MetaEventName;
  eventId?: string;
  eventSourceUrl?: string;
  requestContext?: MetaRequestContext;
  user?: MetaUser | null;
  fbp?: string | null;
  fbc?: string | null;
  customData?: Record<string, unknown>;
};

@Injectable()
export class MetaConversionsService {
  private readonly logger = new Logger(MetaConversionsService.name);
  private warnedMissingConfig = false;
  private warnedNormalizedToken = false;

  constructor(private readonly configService: ConfigService) {}

  buildRequestContext(req: any): MetaRequestContext {
    const forwardedFor = this.firstHeaderValue(req?.headers?.['x-forwarded-for']);
    return {
      ipAddress:
        forwardedFor?.split(',')[0]?.trim() ||
        this.firstHeaderValue(req?.headers?.['x-real-ip']) ||
        req?.ip ||
        req?.socket?.remoteAddress,
      userAgent: this.firstHeaderValue(req?.headers?.['user-agent']),
    };
  }

  async trackBrowserEvent(
    eventName: 'PageView' | 'ViewContent' | 'Lead',
    context: MetaEventContextDto,
    requestContext: MetaRequestContext,
    customData?: Record<string, unknown>,
    user?: MetaUser | null,
  ): Promise<void> {
    await this.trackEvent({
      eventName,
      eventId: context.eventId,
      eventSourceUrl: context.eventSourceUrl,
      requestContext,
      user,
      fbp: context.fbp,
      fbc: context.fbc,
      customData,
    });
  }

  async trackLead(
    user: MetaUser,
    context?: MetaEventContextDto,
    requestContext?: MetaRequestContext,
  ): Promise<void> {
    await this.trackEvent({
      eventName: 'Lead',
      eventId: context?.eventId,
      eventSourceUrl: context?.eventSourceUrl,
      requestContext,
      user,
      fbp: context?.fbp,
      fbc: context?.fbc,
      customData: {
        content_name: 'account_signup',
        status: true,
      },
    });
  }

  async trackInitiateCheckout(input: {
    user: MetaUser;
    context?: MetaEventContextDto;
    requestContext?: MetaRequestContext;
    contentId: string;
    contentName: string;
    valueCents: number;
    currency: string;
    checkoutType: 'subscription' | 'credit_package';
  }): Promise<void> {
    await this.trackEvent({
      eventName: 'InitiateCheckout',
      eventId: input.context?.eventId,
      eventSourceUrl: input.context?.eventSourceUrl,
      requestContext: input.requestContext,
      user: input.user,
      fbp: input.context?.fbp,
      fbc: input.context?.fbc,
      customData: {
        content_ids: [input.contentId],
        content_name: input.contentName,
        content_type: 'product',
        currency: input.currency.toUpperCase(),
        value: this.centsToValue(input.valueCents),
        checkout_type: input.checkoutType,
      },
    });
  }

  async trackPurchase(input: {
    user: MetaUser;
    eventId: string;
    contentId: string;
    contentName: string;
    valueCents: number;
    currency: string;
    orderId: string;
    provider: string;
    purchaseType: 'subscription' | 'credit_package';
  }): Promise<void> {
    // Assinatura da plataforma vai como Subscribe: o Purchase do pixel é da UTMify (checkout), e
    // mandar Purchase daqui contaria a mesma venda duas vezes. Pacote de créditos segue como Purchase,
    // e só sai se 'Purchase' estiver em META_CAPI_EVENTS.
    await this.trackEvent({
      eventName: input.purchaseType === 'subscription' ? 'Subscribe' : 'Purchase',
      eventId: input.eventId,
      eventSourceUrl: this.resolveFrontendUrl('/payment/success'),
      user: input.user,
      customData: {
        content_ids: [input.contentId],
        content_name: input.contentName,
        content_type: 'product',
        currency: input.currency.toUpperCase(),
        value: this.centsToValue(input.valueCents),
        order_id: input.orderId,
        provider: input.provider,
        purchase_type: input.purchaseType,
      },
    });
  }

  // Desde 2026-07-29 o Purchase do pixel vem só da UTMify (pixel no site + webhooks
  // PerfectPay/Cakto no painel dela). Esta API só manda os eventos listados em
  // META_CAPI_EVENTS (ex.: "Lead,Subscribe"). Vazia = nada sai daqui, igual a antes.
  isEventEnabled(eventName: MetaEventName): boolean {
    const raw = this.configService.get<string>('META_CAPI_EVENTS') || '';
    return raw
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
      .includes(eventName.toLowerCase());
  }

  private async trackEvent(input: TrackEventInput): Promise<void> {
    if (!this.isEventEnabled(input.eventName)) return;

    // META_PIXEL_ID aceita vários pixels separados por vírgula: o mesmo evento (mesmo event_id) vai a cada um.
    const pixelIds = this.resolvePixelIds();
    const accessToken = this.getMetaAccessToken();

    if (pixelIds.length === 0 || !accessToken) {
      if (!this.warnedMissingConfig) {
        this.warnedMissingConfig = true;
        this.logger.warn('Meta CAPI disabled: configure META_PIXEL_ID and META_ACCESS_TOKEN');
      }
      return;
    }

    const graphVersion = this.configService.get<string>('META_GRAPH_API_VERSION') || 'v23.0';
    const eventId = input.eventId || `${input.eventName.toLowerCase()}-${Date.now()}`;

    const payload: Record<string, unknown> = {
      data: [
        {
          event_name: input.eventName,
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId,
          action_source: 'website',
          event_source_url: input.eventSourceUrl || this.resolveFrontendUrl('/'),
          user_data: this.buildUserData(input),
          ...(input.customData ? { custom_data: this.stripEmpty(input.customData) } : {}),
        },
      ],
    };

    const testEventCode = this.configService.get<string>('META_TEST_EVENT_CODE');
    if (testEventCode) payload.test_event_code = testEventCode;

    await Promise.all(
      pixelIds.map((pixelId) =>
        this.postEvent(`https://graph.facebook.com/${graphVersion}/${pixelId}/events`, pixelId, input.eventName, payload, accessToken),
      ),
    );
  }

  private resolvePixelIds(): string[] {
    const raw =
      this.configService.get<string>('META_PIXEL_ID') ||
      this.configService.get<string>('NEXT_PUBLIC_META_PIXEL_ID') ||
      '1327084455720433';
    return [...new Set(raw.split(',').map((id) => id.trim()).filter((id) => /^\d+$/.test(id)))];
  }

  private async postEvent(
    endpoint: string,
    pixelId: string,
    eventName: MetaEventName,
    payload: Record<string, unknown>,
    accessToken: string,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    try {
      const response = await fetch(`${endpoint}?access_token=${encodeURIComponent(accessToken)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const responseBody = await response.text();

      if (!response.ok) {
        this.logger.error(
          `Meta CAPI ${eventName} → ${pixelId} failed (${response.status}): ${this.redactMetaResponse(responseBody, accessToken).slice(0, 500)}`,
        );
        return;
      }

      this.logger.debug(`Meta CAPI ${eventName} → ${pixelId} accepted: ${responseBody.slice(0, 300)}`);
    } catch (error) {
      this.logger.error(
        `Meta CAPI ${eventName} → ${pixelId} error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  buildUserData(input: TrackEventInput): Record<string, unknown> {
    const nameParts = this.splitName(input.user?.name);
    const phone = this.normalizePhone(input.user?.phone);
    const country = this.normalizeCountry(input.user?.country);
    return this.stripEmpty({
      em: input.user?.email ? [this.hash(input.user.email)] : undefined,
      ph: phone ? [this.hash(phone)] : undefined,
      fn: nameParts.firstName ? [this.hash(nameParts.firstName)] : undefined,
      ln: nameParts.lastName ? [this.hash(nameParts.lastName)] : undefined,
      country: country ? [this.hash(country)] : undefined,
      external_id: input.user?.id ? [this.hash(input.user.id)] : undefined,
      client_ip_address: input.requestContext?.ipAddress,
      client_user_agent: input.requestContext?.userAgent,
      fbp: input.fbp || input.user?.fbp,
      fbc: input.fbc || input.user?.fbc || this.fbcFromClickId(input.user?.fbclid, input.user?.createdAt),
    });
  }

  // Meta pede telefone só com dígitos e DDI (sem +, espaço ou traço). Menos de 8 dígitos = lixo.
  private normalizePhone(phone?: string | null): string | undefined {
    const digits = (phone || '').replace(/\D+/g, '').replace(/^00/, '');
    return digits.length >= 8 ? digits : undefined;
  }

  // Meta pede país em ISO 3166-1 alfa-2. Qualquer outro formato sairia como hash inútil.
  private normalizeCountry(country?: string | null): string | undefined {
    const code = (country || '').trim().toLowerCase();
    return /^[a-z]{2}$/.test(code) ? code : undefined;
  }

  // Sem o cookie _fbc, monta o fbc a partir do fbclid guardado no cadastro (formato fb.1.<ms>.<fbclid>).
  private fbcFromClickId(fbclid?: string | null, createdAt?: Date | string | null): string | undefined {
    const clickId = (fbclid || '').trim();
    if (!clickId) return undefined;
    const capturedAt = createdAt ? new Date(createdAt).getTime() : NaN;
    return `fb.1.${Number.isFinite(capturedAt) ? capturedAt : Date.now()}.${clickId}`;
  }

  private splitName(name?: string | null): { firstName?: string; lastName?: string } {
    if (!name) return {};
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return {};
    return {
      firstName: parts[0],
      lastName: parts.length > 1 ? parts.slice(1).join(' ') : undefined,
    };
  }

  private hash(value: string): string {
    return createHash('sha256')
      .update(value.trim().toLowerCase())
      .digest('hex');
  }

  private stripEmpty(data: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(data).filter(([, value]) => {
        if (value === undefined || value === null || value === '') return false;
        if (Array.isArray(value) && value.length === 0) return false;
        return true;
      }),
    );
  }

  private centsToValue(valueCents: number): number {
    return Math.max(0, Math.round(valueCents)) / 100;
  }

  private resolveFrontendUrl(path: string): string {
    const base = originSiteUrl(this.configService.get<string>('FRONTEND_URL'));
    try {
      return new URL(path, base).toString();
    } catch {
      return `${ORIGIN_SITE_URL}${path}`;
    }
  }

  private firstHeaderValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }

  private getMetaAccessToken(): string | undefined {
    const rawToken = this.configService.get<string>('META_ACCESS_TOKEN')?.trim();
    if (!rawToken) return undefined;

    const token = rawToken.replace(/^["']|["']$/g, '').trim();
    const compactToken = token.replace(/\s+/g, '');
    const halfLength = compactToken.length / 2;

    if (
      compactToken.length > 0 &&
      compactToken.length % 2 === 0 &&
      compactToken.slice(0, halfLength) === compactToken.slice(halfLength)
    ) {
      if (!this.warnedNormalizedToken) {
        this.warnedNormalizedToken = true;
        this.logger.warn(
          'META_ACCESS_TOKEN appears to be duplicated. Using the first half for Meta CAPI; fix the environment variable to contain only one token.',
        );
      }
      return compactToken.slice(0, halfLength);
    }

    return compactToken;
  }

  private redactMetaResponse(responseBody: string, accessToken: string): string {
    return responseBody
      .replaceAll(accessToken, '[redacted]')
      .replace(/(Malformed access token )[^"]+/g, '$1[redacted]');
  }
}
