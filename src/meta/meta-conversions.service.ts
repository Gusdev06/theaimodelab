import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { MetaEventContextDto } from './meta-event-context.dto';

type MetaEventName =
  | 'PageView'
  | 'ViewContent'
  | 'Lead'
  | 'InitiateCheckout'
  | 'Purchase';

type MetaUser = {
  id?: string;
  email?: string | null;
  name?: string | null;
  phone?: string | null;
  country?: string | null;
  fbp?: string | null;
  fbc?: string | null;
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
    await this.trackEvent({
      eventName: 'Purchase',
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

  private async trackEvent(input: TrackEventInput): Promise<void> {
    const pixelId = this.configService.get<string>('META_PIXEL_ID') ||
      this.configService.get<string>('NEXT_PUBLIC_META_PIXEL_ID') ||
      '1327084455720433';
    const accessToken = this.configService.get<string>('META_ACCESS_TOKEN');

    if (!pixelId || !accessToken) {
      if (!this.warnedMissingConfig) {
        this.warnedMissingConfig = true;
        this.logger.warn('Meta CAPI disabled: configure META_PIXEL_ID and META_ACCESS_TOKEN');
      }
      return;
    }

    const graphVersion = this.configService.get<string>('META_GRAPH_API_VERSION') || 'v23.0';
    const endpoint = `https://graph.facebook.com/${graphVersion}/${pixelId}/events`;
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
          `Meta CAPI ${input.eventName} failed (${response.status}): ${responseBody.slice(0, 500)}`,
        );
        return;
      }

      this.logger.debug(`Meta CAPI ${input.eventName} accepted: ${responseBody.slice(0, 300)}`);
    } catch (error) {
      this.logger.error(
        `Meta CAPI ${input.eventName} error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildUserData(input: TrackEventInput): Record<string, unknown> {
    const nameParts = this.splitName(input.user?.name);
    return this.stripEmpty({
      em: input.user?.email ? [this.hash(input.user.email)] : undefined,
      ph: input.user?.phone ? [this.hash(input.user.phone)] : undefined,
      fn: nameParts.firstName ? [this.hash(nameParts.firstName)] : undefined,
      ln: nameParts.lastName ? [this.hash(nameParts.lastName)] : undefined,
      country: input.user?.country ? [this.hash(input.user.country)] : undefined,
      external_id: input.user?.id ? [this.hash(input.user.id)] : undefined,
      client_ip_address: input.requestContext?.ipAddress,
      client_user_agent: input.requestContext?.userAgent,
      fbp: input.fbp || input.user?.fbp,
      fbc: input.fbc || input.user?.fbc,
    });
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
    const base = this.configService.get<string>('FRONTEND_URL')?.split(',')[0]?.trim() ||
      'https://theaimodelab.ai';
    try {
      return new URL(path, base).toString();
    } catch {
      return `https://theaimodelab.ai${path}`;
    }
  }

  private firstHeaderValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }
}
