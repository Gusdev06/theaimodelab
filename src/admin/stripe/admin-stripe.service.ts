import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

export interface ListParams {
  limit?: number;
  startingAfter?: string;
  endingBefore?: string;
}

export interface ChargeListParams extends ListParams {
  customer?: string;
}

export interface CustomerListParams extends ListParams {
  email?: string;
}

export interface ProductListParams extends ListParams {
  active?: boolean;
}

export interface PriceListParams extends ListParams {
  product?: string;
  active?: boolean;
}

export interface SubscriptionListParams extends ListParams {
  customer?: string;
  status?: Stripe.SubscriptionListParams.Status;
  priceId?: string;
}

export interface InvoiceListParams extends ListParams {
  customer?: string;
  status?: Stripe.InvoiceListParams.Status;
}

export interface PromotionCodeListParams extends ListParams {
  code?: string;
  active?: boolean;
  coupon?: string;
}

@Injectable()
export class AdminStripeService {
  private readonly logger = new Logger(AdminStripeService.name);
  private readonly stripe: Stripe;

  constructor(private readonly configService: ConfigService) {
    this.stripe = new Stripe(
      this.configService.getOrThrow<string>('STRIPE_SECRET_KEY'),
      { apiVersion: '2026-02-25.clover' },
    );
  }

  private sanitizeLimit(limit?: number): number {
    if (!limit || limit <= 0) return 20;
    return Math.min(limit, 100);
  }

  async getOverview() {
    const summarize = (list: Stripe.ApiList<Stripe.Subscription>) => ({
      count: list.data.length,
      hasMore: list.has_more,
    });

    const [activeSubs, pastDue, canceled, trialing, balance] = await Promise.all([
      this.stripe.subscriptions.list({ status: 'active', limit: 100 }),
      this.stripe.subscriptions.list({ status: 'past_due', limit: 100 }),
      this.stripe.subscriptions.list({ status: 'canceled', limit: 100 }),
      this.stripe.subscriptions.list({ status: 'trialing', limit: 100 }),
      this.stripe.balance.retrieve(),
    ]);

    return {
      balance: {
        available: balance.available.map((b) => ({ amount: b.amount, currency: b.currency })),
        pending: balance.pending.map((b) => ({ amount: b.amount, currency: b.currency })),
      },
      subscriptions: {
        active: summarize(activeSubs),
        pastDue: summarize(pastDue),
        canceled: summarize(canceled),
        trialing: summarize(trialing),
      },
    };
  }

  async listCharges(params: ChargeListParams) {
    return this.stripe.charges.list({
      limit: this.sanitizeLimit(params.limit),
      starting_after: params.startingAfter,
      ending_before: params.endingBefore,
      customer: params.customer,
    });
  }

  async getCharge(id: string) {
    try {
      return await this.stripe.charges.retrieve(id, { expand: ['customer', 'invoice'] });
    } catch {
      throw new NotFoundException(`Charge ${id} não encontrada`);
    }
  }

  async refundCharge(id: string, amount?: number, reason?: Stripe.RefundCreateParams.Reason) {
    return this.stripe.refunds.create({
      charge: id,
      ...(amount ? { amount } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  async listCustomers(params: CustomerListParams) {
    if (params.email) {
      return this.stripe.customers.list({
        email: params.email,
        limit: this.sanitizeLimit(params.limit),
        starting_after: params.startingAfter,
        ending_before: params.endingBefore,
      });
    }
    return this.stripe.customers.list({
      limit: this.sanitizeLimit(params.limit),
      starting_after: params.startingAfter,
      ending_before: params.endingBefore,
    });
  }

  async searchCustomers(query: string, limit?: number) {
    return this.stripe.customers.search({
      query,
      limit: this.sanitizeLimit(limit),
    });
  }

  async getCustomer(id: string) {
    try {
      const customer = await this.stripe.customers.retrieve(id);
      if ((customer as Stripe.DeletedCustomer).deleted) {
        throw new NotFoundException(`Customer ${id} foi deletado`);
      }

      const [subscriptions, charges, invoices, paymentMethods] = await Promise.all([
        this.stripe.subscriptions.list({
          customer: id,
          limit: 20,
          status: 'all',
          expand: ['data.items.data.price'],
        }),
        this.stripe.charges.list({ customer: id, limit: 20 }),
        this.stripe.invoices.list({ customer: id, limit: 20 }),
        this.stripe.paymentMethods.list({ customer: id, limit: 20 }),
      ]);

      await this.hydrateSubscriptionProducts(subscriptions.data);

      return {
        customer,
        subscriptions: subscriptions.data,
        charges: charges.data,
        invoices: invoices.data,
        paymentMethods: paymentMethods.data,
      };
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      throw new NotFoundException(`Customer ${id} não encontrado`);
    }
  }

  async listProducts(params: ProductListParams) {
    return this.stripe.products.list({
      limit: this.sanitizeLimit(params.limit),
      starting_after: params.startingAfter,
      ending_before: params.endingBefore,
      ...(params.active !== undefined ? { active: params.active } : {}),
    });
  }

  async getProduct(id: string) {
    try {
      return await this.stripe.products.retrieve(id);
    } catch {
      throw new NotFoundException(`Product ${id} não encontrado`);
    }
  }

  async createProduct(data: {
    name: string;
    description?: string;
    active?: boolean;
    metadata?: Record<string, string>;
  }) {
    return this.stripe.products.create(data);
  }

  async updateProduct(
    id: string,
    data: {
      name?: string;
      description?: string;
      active?: boolean;
      metadata?: Record<string, string>;
    },
  ) {
    return this.stripe.products.update(id, data);
  }

  async archiveProduct(id: string) {
    return this.stripe.products.update(id, { active: false });
  }

  async deleteProduct(id: string) {
    return this.stripe.products.del(id);
  }

  async listPrices(params: PriceListParams) {
    return this.stripe.prices.list({
      limit: this.sanitizeLimit(params.limit),
      starting_after: params.startingAfter,
      ending_before: params.endingBefore,
      ...(params.product ? { product: params.product } : {}),
      ...(params.active !== undefined ? { active: params.active } : {}),
      expand: ['data.product'],
    });
  }

  async getPrice(id: string) {
    try {
      return await this.stripe.prices.retrieve(id, { expand: ['product'] });
    } catch {
      throw new NotFoundException(`Price ${id} não encontrado`);
    }
  }

  async createPrice(data: {
    product: string;
    unitAmount: number;
    currency: string;
    nickname?: string;
    recurring?: { interval: 'day' | 'week' | 'month' | 'year'; intervalCount?: number };
    metadata?: Record<string, string>;
  }) {
    return this.stripe.prices.create({
      product: data.product,
      unit_amount: data.unitAmount,
      currency: data.currency.toLowerCase(),
      ...(data.nickname ? { nickname: data.nickname } : {}),
      ...(data.recurring
        ? {
            recurring: {
              interval: data.recurring.interval,
              ...(data.recurring.intervalCount
                ? { interval_count: data.recurring.intervalCount }
                : {}),
            },
          }
        : {}),
      ...(data.metadata ? { metadata: data.metadata } : {}),
    });
  }

  async archivePrice(id: string) {
    return this.stripe.prices.update(id, { active: false });
  }

  async activatePrice(id: string) {
    return this.stripe.prices.update(id, { active: true });
  }

  async listCoupons(params: ListParams) {
    return this.stripe.coupons.list({
      limit: this.sanitizeLimit(params.limit),
      starting_after: params.startingAfter,
      ending_before: params.endingBefore,
    });
  }

  async getCoupon(id: string) {
    try {
      return await this.stripe.coupons.retrieve(id);
    } catch {
      throw new NotFoundException(`Coupon ${id} não encontrado`);
    }
  }

  async createCoupon(data: {
    id?: string;
    name?: string;
    percentOff?: number;
    amountOff?: number;
    currency?: string;
    duration: 'once' | 'repeating' | 'forever';
    durationInMonths?: number;
    maxRedemptions?: number;
    redeemBy?: number;
    metadata?: Record<string, string>;
  }) {
    return this.stripe.coupons.create({
      ...(data.id ? { id: data.id } : {}),
      ...(data.name ? { name: data.name } : {}),
      ...(data.percentOff ? { percent_off: data.percentOff } : {}),
      ...(data.amountOff ? { amount_off: data.amountOff } : {}),
      ...(data.currency ? { currency: data.currency.toLowerCase() } : {}),
      duration: data.duration,
      ...(data.durationInMonths ? { duration_in_months: data.durationInMonths } : {}),
      ...(data.maxRedemptions ? { max_redemptions: data.maxRedemptions } : {}),
      ...(data.redeemBy ? { redeem_by: data.redeemBy } : {}),
      ...(data.metadata ? { metadata: data.metadata } : {}),
    });
  }

  async deleteCoupon(id: string) {
    return this.stripe.coupons.del(id);
  }

  async listPromotionCodes(params: PromotionCodeListParams) {
    return this.stripe.promotionCodes.list({
      limit: this.sanitizeLimit(params.limit),
      starting_after: params.startingAfter,
      ending_before: params.endingBefore,
      ...(params.code ? { code: params.code } : {}),
      ...(params.active !== undefined ? { active: params.active } : {}),
      ...(params.coupon ? { coupon: params.coupon } : {}),
    });
  }

  async createPromotionCode(data: {
    coupon: string;
    code?: string;
    active?: boolean;
    maxRedemptions?: number;
    expiresAt?: number;
    firstTimeTransaction?: boolean;
    minimumAmount?: number;
    minimumAmountCurrency?: string;
    metadata?: Record<string, string>;
  }) {
    const restrictions: Stripe.PromotionCodeCreateParams.Restrictions = {};
    if (data.firstTimeTransaction) restrictions.first_time_transaction = true;
    if (data.minimumAmount) {
      restrictions.minimum_amount = data.minimumAmount;
      restrictions.minimum_amount_currency = (data.minimumAmountCurrency ?? 'brl').toLowerCase();
    }

    return this.stripe.promotionCodes.create({
      promotion: { type: 'coupon', coupon: data.coupon },
      ...(data.code ? { code: data.code } : {}),
      ...(data.active !== undefined ? { active: data.active } : {}),
      ...(data.maxRedemptions ? { max_redemptions: data.maxRedemptions } : {}),
      ...(data.expiresAt ? { expires_at: data.expiresAt } : {}),
      ...(Object.keys(restrictions).length ? { restrictions } : {}),
      ...(data.metadata ? { metadata: data.metadata } : {}),
    });
  }

  async setPromotionCodeActive(id: string, active: boolean) {
    return this.stripe.promotionCodes.update(id, { active });
  }

  async listSubscriptions(params: SubscriptionListParams) {
    const list = await this.stripe.subscriptions.list({
      limit: this.sanitizeLimit(params.limit),
      starting_after: params.startingAfter,
      ending_before: params.endingBefore,
      ...(params.customer ? { customer: params.customer } : {}),
      ...(params.status ? { status: params.status } : { status: 'all' }),
      ...(params.priceId ? { price: params.priceId } : {}),
      expand: ['data.customer', 'data.items.data.price'],
    });

    await this.hydrateSubscriptionProducts(list.data);
    return list;
  }

  private async hydrateSubscriptionProducts(subs: Stripe.Subscription[]): Promise<void> {
    const productIds = new Set<string>();
    for (const sub of subs) {
      for (const item of sub.items.data) {
        const product = item.price.product;
        if (typeof product === 'string') productIds.add(product);
      }
    }
    if (productIds.size === 0) return;

    const products = await Promise.all(
      [...productIds].map((id) => this.stripe.products.retrieve(id).catch(() => null)),
    );
    const productMap = new Map<string, Stripe.Product>();
    for (const p of products) {
      if (p && !('deleted' in p && p.deleted)) productMap.set(p.id, p as Stripe.Product);
    }

    for (const sub of subs) {
      for (const item of sub.items.data) {
        if (typeof item.price.product === 'string') {
          const full = productMap.get(item.price.product);
          if (full) item.price.product = full;
        }
      }
    }
  }

  async getSubscription(id: string) {
    try {
      return await this.stripe.subscriptions.retrieve(id, {
        expand: ['customer', 'items.data.price.product', 'latest_invoice', 'discounts.coupon'],
      });
    } catch {
      throw new NotFoundException(`Subscription ${id} não encontrada`);
    }
  }

  async cancelSubscription(id: string, atPeriodEnd = true) {
    if (atPeriodEnd) {
      return this.stripe.subscriptions.update(id, { cancel_at_period_end: true });
    }
    return this.stripe.subscriptions.cancel(id);
  }

  async reactivateSubscription(id: string) {
    return this.stripe.subscriptions.update(id, { cancel_at_period_end: false });
  }

  async listInvoices(params: InvoiceListParams) {
    return this.stripe.invoices.list({
      limit: this.sanitizeLimit(params.limit),
      starting_after: params.startingAfter,
      ending_before: params.endingBefore,
      ...(params.customer ? { customer: params.customer } : {}),
      ...(params.status ? { status: params.status } : {}),
    });
  }

  async getInvoice(id: string) {
    try {
      return await this.stripe.invoices.retrieve(id, {
        expand: ['customer', 'lines.data', 'parent.subscription_details'],
      });
    } catch {
      throw new NotFoundException(`Invoice ${id} não encontrada`);
    }
  }
}
