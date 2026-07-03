import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../../prisma/prisma.service';

const MS_DAY = 86_400_000;
const MS_MONTH = MS_DAY * 30;

const INTERVAL_TO_MONTHS: Record<string, number> = {
  day: 1 / 30,
  week: 1 / 4.345,
  month: 1,
  year: 12,
};

const DEFAULT_BLENDED_COST_PER_CREDIT_BRL = 0.0026;

export interface FinanceSummary {
  generatedAt: number;
  currency: string;
  mrrCents: number;
  arrCents: number;
  netRevenueLast30dCents: number;
  grossRevenueLast30dCents: number;
  refundedLast30dCents: number;
  payingCustomers: number;
  trialingCustomers: number;
  pastDueCustomers: number;
  arpuCents: number;
  churnRateMonthly: number;
  churnedLast30d: number;
  newCustomersLast30d: number;
  netGrowthLast30d: number;
  ltvCents: number;
  ltvMonths: number;
  costLast30dBrlCents: number;
  marginLast30d: number;
  ltvCacRatioHint: string;
  forecast: {
    nextMonthMrrCents: number;
    in3MonthsMrrCents: number;
    in6MonthsMrrCents: number;
    monthlyGrowthRate: number;
  };
  cohorts: {
    activeByPlan: { priceId: string; productName: string | null; nickname: string | null; intervalMonths: number; unitAmountCents: number; subscribers: number; mrrCents: number }[];
  };
  risk: {
    pastDuePayingCustomers: number;
    pastDueAtRiskMrrCents: number;
    cancelAtPeriodEnd: number;
    cancelAtPeriodEndMrrCents: number;
  };
}

export interface MrrHistoryPoint {
  month: string;
  startMs: number;
  newMrrCents: number;
  expansionMrrCents: number;
  churnMrrCents: number;
  netMrrCents: number;
  paidInvoiceCents: number;
  refundCents: number;
  uniquePayingCustomers: number;
}

export interface PayingCustomerRow {
  customerId: string;
  email: string | null;
  name: string | null;
  createdMs: number;
  status: string;
  currentPlan: string | null;
  currentMrrCents: number;
  totalPaidCents: number;
  invoiceCount: number;
  firstPaymentMs: number | null;
  lastPaymentMs: number | null;
  tenureMonths: number;
  estimatedLtvCents: number;
}

interface CacheEntry<T> {
  expires: number;
  value: T;
}

@Injectable()
export class AdminFinanceService {
  private readonly logger = new Logger(AdminFinanceService.name);
  private readonly stripe: Stripe;
  private readonly costPerCreditBrl: number;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly CACHE_TTL_MS = 5 * 60_000;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.stripe = new Stripe(this.config.getOrThrow<string>('STRIPE_SECRET_KEY'), {
      apiVersion: '2026-02-25.clover',
      maxNetworkRetries: 2,
    });
    const cfg = Number(
      this.config.get<string>('BLENDED_COST_PER_CREDIT_BRL') ?? DEFAULT_BLENDED_COST_PER_CREDIT_BRL,
    );
    this.costPerCreditBrl = Number.isFinite(cfg) ? cfg : DEFAULT_BLENDED_COST_PER_CREDIT_BRL;
  }

  invalidateCache() {
    this.cache.clear();
  }

  private async memo<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expires > now) return hit.value as T;

    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;

    const promise = (async () => {
      try {
        const value = await loader();
        this.cache.set(key, { expires: Date.now() + ttlMs, value });
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  private async runWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]);
      }
    });
    await Promise.all(workers);
    return results;
  }

  async getSummary(): Promise<FinanceSummary> {
    return this.memo('summary', this.CACHE_TTL_MS, () => this.computeSummary());
  }

  private async computeSummary(): Promise<FinanceSummary> {
    const now = Date.now();
    const since30d = Math.floor((now - MS_MONTH) / 1000);
    const since60d = Math.floor((now - MS_MONTH * 2) / 1000);

    const allSubs = await this.fetchAllSubscriptions({ status: 'all' });
    const charges30d = await this.fetchAllCharges({ created: { gte: since30d } });
    const history = await this.getMrrHistory(6);

    const MRR_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);
    const mrrSubs = allSubs.filter((s) => MRR_STATUSES.has(s.status));
    const activeSubs = allSubs.filter((s) => s.status === 'active');
    const trialingSubs = allSubs.filter((s) => s.status === 'trialing');
    const pastDueSubs = allSubs.filter((s) => s.status === 'past_due');
    const canceledRecently = allSubs.filter(
      (s) => s.status === 'canceled' && s.created >= since60d,
    );

    const mrrCents = mrrSubs.reduce((acc, s) => acc + this.subscriptionMonthlyCents(s), 0);
    const pastDueMrrCents = pastDueSubs.reduce(
      (acc, s) => acc + this.subscriptionMonthlyCents(s),
      0,
    );

    const payingCustomers = this.uniqueCustomerCount(mrrSubs);
    const trialingCustomers = this.uniqueCustomerCount(trialingSubs);
    const pastDueCustomers = this.uniqueCustomerCount(pastDueSubs);

    const grossRevenueLast30dCents = charges30d
      .filter((c) => c.status === 'succeeded')
      .reduce((acc, c) => acc + c.amount, 0);
    const refundedLast30dCents = charges30d.reduce((acc, c) => acc + c.amount_refunded, 0);
    const netRevenueLast30dCents = grossRevenueLast30dCents - refundedLast30dCents;

    const cancelAtPeriodEnd = activeSubs.filter((s) => s.cancel_at_period_end).length;
    const cancelAtPeriodEndMrrCents = activeSubs
      .filter((s) => s.cancel_at_period_end)
      .reduce((acc, s) => acc + this.subscriptionMonthlyCents(s), 0);

    const pastDueAtRiskMrrCents = pastDueMrrCents;

    const churnedLast30d = canceledRecently.filter((s) => {
      const ts = (s.canceled_at ?? s.ended_at ?? 0) * 1000;
      return ts >= now - MS_MONTH;
    }).length;

    const startActive = payingCustomers + churnedLast30d;
    const churnRateMonthly = startActive > 0 ? churnedLast30d / startActive : 0;

    const newCustomersLast30d = activeSubs.filter((s) => s.created * 1000 >= now - MS_MONTH).length;
    const netGrowthLast30d = newCustomersLast30d - churnedLast30d;

    const arpuCents = payingCustomers > 0 ? Math.round(mrrCents / payingCustomers) : 0;

    const costLast30dBrlCents = await this.computeCostLast30d();
    const marginLast30d =
      netRevenueLast30dCents > 0
        ? (netRevenueLast30dCents - costLast30dBrlCents) / netRevenueLast30dCents
        : 0;

    const grossMargin = Math.max(0.1, Math.min(0.95, marginLast30d || 0.5));
    const ltvMonths = churnRateMonthly > 0 ? 1 / churnRateMonthly : 24;
    const ltvCents = Math.round(arpuCents * grossMargin * ltvMonths);

    const completedHistory = history.slice(0, -1);
    const monthlyGrowthRate = this.computeAvgGrowthRate(
      completedHistory.map((h) => h.paidInvoiceCents).filter((v) => v > 0),
    );
    const nextMonthMrrCents = Math.round(mrrCents * (1 + monthlyGrowthRate));
    const in3MonthsMrrCents = Math.round(mrrCents * Math.pow(1 + monthlyGrowthRate, 3));
    const in6MonthsMrrCents = Math.round(mrrCents * Math.pow(1 + monthlyGrowthRate, 6));

    const cohorts = this.buildPlanCohorts(mrrSubs);

    return {
      generatedAt: now,
      currency: this.guessCurrency(mrrSubs) ?? 'brl',
      mrrCents,
      arrCents: mrrCents * 12,
      netRevenueLast30dCents,
      grossRevenueLast30dCents,
      refundedLast30dCents,
      payingCustomers,
      trialingCustomers,
      pastDueCustomers,
      arpuCents,
      churnRateMonthly,
      churnedLast30d,
      newCustomersLast30d,
      netGrowthLast30d,
      ltvCents,
      ltvMonths,
      costLast30dBrlCents,
      marginLast30d,
      ltvCacRatioHint:
        'Defina o CAC por canal para calcular LTV/CAC. Saudável: ≥ 3x. Payback: < 12 meses.',
      forecast: {
        nextMonthMrrCents,
        in3MonthsMrrCents,
        in6MonthsMrrCents,
        monthlyGrowthRate,
      },
      cohorts: { activeByPlan: cohorts },
      risk: {
        pastDuePayingCustomers: pastDueCustomers,
        pastDueAtRiskMrrCents,
        cancelAtPeriodEnd,
        cancelAtPeriodEndMrrCents,
      },
    };
  }

  async getMrrHistory(months: number): Promise<MrrHistoryPoint[]> {
    return this.memo(`mrr-history:${months}`, this.CACHE_TTL_MS, () =>
      this.computeMrrHistory(months),
    );
  }

  private async computeMrrHistory(months: number): Promise<MrrHistoryPoint[]> {
    const safeMonths = Math.min(Math.max(months, 1), 24);
    const now = new Date();
    const buckets: MrrHistoryPoint[] = [];
    for (let i = safeMonths - 1; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      buckets.push({
        month: start.toISOString().slice(0, 7),
        startMs: start.getTime(),
        newMrrCents: 0,
        expansionMrrCents: 0,
        churnMrrCents: 0,
        netMrrCents: 0,
        paidInvoiceCents: 0,
        refundCents: 0,
        uniquePayingCustomers: 0,
      });
    }
    if (buckets.length === 0) return buckets;

    const startSec = Math.floor(buckets[0].startMs / 1000);
    const invoices = await this.fetchAllInvoices({ created: { gte: startSec } });
    const refunds = await this.fetchAllCharges({ created: { gte: startSec } });
    const subsCreated = await this.fetchAllSubscriptions({ created: { gte: startSec } });
    const subsCanceled = await this.fetchAllSubscriptions({
      status: 'canceled',
      created: { gte: startSec - 60 * 60 * 24 * 365 },
    });

    const findBucket = (ts: number) => {
      for (let i = buckets.length - 1; i >= 0; i--) {
        if (ts >= buckets[i].startMs) return buckets[i];
      }
      return null;
    };

    const seenCustomers = new Map<string, Set<string>>();
    for (const inv of invoices) {
      if (inv.status !== 'paid') continue;
      const ts = (inv.status_transitions?.paid_at ?? inv.created) * 1000;
      const bucket = findBucket(ts);
      if (!bucket) continue;
      bucket.paidInvoiceCents += inv.amount_paid;
      const cid = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id ?? null;
      if (cid) {
        const set = seenCustomers.get(bucket.month) ?? new Set<string>();
        set.add(cid);
        seenCustomers.set(bucket.month, set);
      }
    }

    for (const r of refunds) {
      if (!r.amount_refunded) continue;
      const bucket = findBucket(r.created * 1000);
      if (!bucket) continue;
      bucket.refundCents += r.amount_refunded;
    }

    for (const sub of subsCreated) {
      const bucket = findBucket(sub.created * 1000);
      if (!bucket) continue;
      bucket.newMrrCents += this.subscriptionMonthlyCents(sub);
    }

    for (const sub of subsCanceled) {
      const ts = (sub.canceled_at ?? sub.ended_at ?? 0) * 1000;
      if (!ts) continue;
      const bucket = findBucket(ts);
      if (!bucket) continue;
      bucket.churnMrrCents += this.subscriptionMonthlyCents(sub);
    }

    for (const b of buckets) {
      b.netMrrCents = b.newMrrCents + b.expansionMrrCents - b.churnMrrCents;
      b.uniquePayingCustomers = seenCustomers.get(b.month)?.size ?? 0;
    }

    return buckets;
  }

  async getMrrDiagnostic() {
    return this.memo('mrr-diagnostic', this.CACHE_TTL_MS, async () => {
      const allSubs = await this.fetchAllSubscriptions({ status: 'all' });
      const breakdown: Record<string, { count: number; mrrCents: number }> = {};
      const subsList = allSubs.map((sub) => {
        const monthly = this.subscriptionMonthlyCents(sub);
        const status = sub.status;
        if (!breakdown[status]) breakdown[status] = { count: 0, mrrCents: 0 };
        breakdown[status].count += 1;
        if (
          ['active', 'trialing', 'past_due', 'unpaid', 'paused'].includes(status)
        ) {
          breakdown[status].mrrCents += monthly;
        }
        const customer =
          typeof sub.customer === 'string' ? null : (sub.customer as Stripe.Customer);
        return {
          id: sub.id,
          status,
          customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
          email: customer?.email ?? null,
          plan: this.subscriptionPlanLabel(sub),
          monthlyCents: monthly,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          created: sub.created,
          discount: sub.discounts && (sub.discounts as unknown[]).length > 0,
        };
      });
      const totalMrrCents = Object.entries(breakdown)
        .filter(([s]) => ['active', 'trialing', 'past_due', 'unpaid', 'paused'].includes(s))
        .reduce((acc, [, v]) => acc + v.mrrCents, 0);
      return {
        totalSubscriptions: allSubs.length,
        totalMrrCents,
        breakdownByStatus: breakdown,
        subscriptions: subsList.sort((a, b) => b.monthlyCents - a.monthlyCents),
      };
    });
  }

  async listPayingCustomers(opts: {
    limit?: number;
    onlyActive?: boolean;
    search?: string;
  } = {}): Promise<{ rows: PayingCustomerRow[]; total: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 250);
    const cacheKey = `customers:${opts.onlyActive ? 'active' : 'all'}:${limit}:${opts.search ?? ''}`;
    return this.memo(cacheKey, this.CACHE_TTL_MS, () => this.computePayingCustomers(opts, limit));
  }

  private async computePayingCustomers(
    opts: { onlyActive?: boolean; search?: string },
    limit: number,
  ): Promise<{ rows: PayingCustomerRow[]; total: number }> {
    const subs = await this.fetchAllSubscriptions(
      opts.onlyActive ? { status: 'active' } : { status: 'all' },
    );

    const byCustomer = new Map<string, Stripe.Subscription>();
    for (const sub of subs) {
      const cid = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      const prev = byCustomer.get(cid);
      const score = (s: Stripe.Subscription) => {
        if (s.status === 'active') return 4;
        if (s.status === 'trialing') return 3;
        if (s.status === 'past_due') return 2;
        if (s.status === 'canceled') return 1;
        return 0;
      };
      if (!prev || score(sub) > score(prev)) byCustomer.set(cid, sub);
    }

    const customerIds = [...byCustomer.keys()];
    const rows: PayingCustomerRow[] = [];

    for (const cid of customerIds) {
      const sub = byCustomer.get(cid)!;
      const customer = typeof sub.customer === 'string' ? null : (sub.customer as Stripe.Customer);
      const email = customer?.email ?? null;
      const name = customer?.name ?? null;
      const createdMs = (customer?.created ?? sub.created) * 1000;

      if (opts.search && opts.search.trim()) {
        const q = opts.search.trim().toLowerCase();
        if (
          !(email ?? '').toLowerCase().includes(q) &&
          !(name ?? '').toLowerCase().includes(q) &&
          !cid.toLowerCase().includes(q)
        ) {
          continue;
        }
      }

      rows.push({
        customerId: cid,
        email,
        name,
        createdMs,
        status: sub.status,
        currentPlan: this.subscriptionPlanLabel(sub),
        currentMrrCents:
          sub.status === 'active' || sub.status === 'trialing'
            ? this.subscriptionMonthlyCents(sub)
            : 0,
        totalPaidCents: 0,
        invoiceCount: 0,
        firstPaymentMs: null,
        lastPaymentMs: null,
        tenureMonths: 0,
        estimatedLtvCents: 0,
      });
    }

    rows.sort((a, b) => b.currentMrrCents - a.currentMrrCents);
    const top = rows.slice(0, limit);

    await this.runWithConcurrency(top, 4, async (row) => {
      const invs = await this.fetchAllInvoices({ customer: row.customerId, status: 'paid' });
      if (!invs.length) return;
      let total = 0;
      let first = Number.POSITIVE_INFINITY;
      let last = 0;
      for (const i of invs) {
        total += i.amount_paid;
        const ts = (i.status_transitions?.paid_at ?? i.created) * 1000;
        if (ts < first) first = ts;
        if (ts > last) last = ts;
      }
      row.totalPaidCents = total;
      row.invoiceCount = invs.length;
      row.firstPaymentMs = Number.isFinite(first) ? first : null;
      row.lastPaymentMs = last || null;
      if (row.firstPaymentMs) {
        row.tenureMonths = Math.max(1, Math.round((Date.now() - row.firstPaymentMs) / MS_MONTH));
        row.estimatedLtvCents =
          row.totalPaidCents +
          (row.status === 'active' || row.status === 'trialing'
            ? Math.round(row.currentMrrCents * 6)
            : 0);
      }
    });

    return { rows: top, total: rows.length };
  }

  private async computeCostLast30d(): Promise<number> {
    const since = new Date(Date.now() - MS_MONTH);
    const res = await this.prisma.generation.aggregate({
      _sum: { creditsConsumed: true },
      where: { createdAt: { gte: since }, status: 'COMPLETED' },
    });
    const credits = res._sum.creditsConsumed ?? 0;
    return Math.round(credits * this.costPerCreditBrl * 100);
  }

  private subscriptionMonthlyCents(sub: Stripe.Subscription): number {
    let total = 0;
    for (const item of sub.items.data) {
      const price = item.price;
      if (!price.unit_amount) continue;
      const qty = item.quantity ?? 1;
      const interval = price.recurring?.interval ?? 'month';
      const intervalCount = price.recurring?.interval_count ?? 1;
      const intervalMonths = (INTERVAL_TO_MONTHS[interval] ?? 1) * intervalCount;
      if (intervalMonths <= 0) continue;
      total += (price.unit_amount * qty) / intervalMonths;
    }
    return Math.round(total);
  }

  private subscriptionPlanLabel(sub: Stripe.Subscription): string | null {
    const item = sub.items.data[0];
    if (!item) return null;
    const product = item.price.product;
    if (typeof product !== 'string' && product && !product.deleted) {
      return product.name;
    }
    return item.price.nickname ?? null;
  }

  private uniqueCustomerCount(subs: Stripe.Subscription[]): number {
    const set = new Set<string>();
    for (const s of subs) {
      const id = typeof s.customer === 'string' ? s.customer : s.customer.id;
      set.add(id);
    }
    return set.size;
  }

  private guessCurrency(subs: Stripe.Subscription[]): string | null {
    for (const s of subs) {
      const c = s.items.data[0]?.price.currency;
      if (c) return c;
    }
    return null;
  }

  private buildPlanCohorts(subs: Stripe.Subscription[]) {
    const map = new Map<
      string,
      {
        priceId: string;
        productName: string | null;
        nickname: string | null;
        intervalMonths: number;
        unitAmountCents: number;
        subscribers: number;
        mrrCents: number;
      }
    >();
    for (const sub of subs) {
      for (const item of sub.items.data) {
        const price = item.price;
        const interval = price.recurring?.interval ?? 'month';
        const intervalCount = price.recurring?.interval_count ?? 1;
        const intervalMonths = (INTERVAL_TO_MONTHS[interval] ?? 1) * intervalCount;
        const product = price.product;
        const productName =
          typeof product !== 'string' && product && !product.deleted ? product.name : null;
        const key = price.id;
        const existing = map.get(key);
        const mrrIncrement = this.subscriptionMonthlyCents({
          ...sub,
          items: { ...sub.items, data: [item] },
        } as Stripe.Subscription);
        if (existing) {
          existing.subscribers += 1;
          existing.mrrCents += mrrIncrement;
        } else {
          map.set(key, {
            priceId: price.id,
            productName,
            nickname: price.nickname ?? null,
            intervalMonths,
            unitAmountCents: price.unit_amount ?? 0,
            subscribers: 1,
            mrrCents: mrrIncrement,
          });
        }
      }
    }
    return [...map.values()].sort((a, b) => b.mrrCents - a.mrrCents);
  }

  private computeAvgGrowthRate(series: number[]): number {
    const filtered = series.filter((v) => Number.isFinite(v));
    if (filtered.length < 2) return 0;
    const rates: number[] = [];
    for (let i = 1; i < filtered.length; i++) {
      const prev = filtered[i - 1];
      const curr = filtered[i];
      if (prev <= 0) continue;
      rates.push((curr - prev) / prev);
    }
    if (!rates.length) return 0;
    const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
    return Math.max(-0.5, Math.min(1, avg));
  }

  private async fetchAllSubscriptions(
    params: Stripe.SubscriptionListParams,
  ): Promise<Stripe.Subscription[]> {
    const out: Stripe.Subscription[] = [];
    for await (const sub of this.stripe.subscriptions.list({
      ...params,
      limit: 100,
      expand: ['data.customer', 'data.items.data.price'],
    })) {
      out.push(sub);
      if (out.length >= 1000) break;
    }
    await this.hydrateProducts(out);
    return out;
  }

  private async hydrateProducts(subs: Stripe.Subscription[]): Promise<void> {
    const productIds = new Set<string>();
    for (const sub of subs) {
      for (const item of sub.items.data) {
        const p = item.price.product;
        if (typeof p === 'string') productIds.add(p);
      }
    }
    if (productIds.size === 0) return;

    const products = await this.runWithConcurrency([...productIds], 4, (id) =>
      this.stripe.products.retrieve(id).catch(() => null),
    );
    const map = new Map<string, Stripe.Product>();
    for (const p of products) {
      if (p && !('deleted' in p && p.deleted)) map.set(p.id, p as Stripe.Product);
    }

    for (const sub of subs) {
      for (const item of sub.items.data) {
        if (typeof item.price.product === 'string') {
          const full = map.get(item.price.product);
          if (full) item.price.product = full;
        }
      }
    }
  }

  private async fetchAllCharges(params: Stripe.ChargeListParams): Promise<Stripe.Charge[]> {
    const out: Stripe.Charge[] = [];
    for await (const c of this.stripe.charges.list({ ...params, limit: 100 })) {
      out.push(c);
      if (out.length >= 1000) break;
    }
    return out;
  }

  private async fetchAllInvoices(params: Stripe.InvoiceListParams): Promise<Stripe.Invoice[]> {
    const out: Stripe.Invoice[] = [];
    for await (const i of this.stripe.invoices.list({ ...params, limit: 100 })) {
      out.push(i);
      if (out.length >= 1000) break;
    }
    return out;
  }
}
