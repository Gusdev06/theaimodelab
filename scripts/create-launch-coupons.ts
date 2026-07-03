/**
 * Cria cupons de lançamento (GUSTAGOAT) no Stripe para cada plano.
 *
 * Run:
 *   cd theaimodelab-api && npx ts-node scripts/create-launch-coupons.ts
 *
 * Idempotente: se o coupon ou promotion_code já existir, reaproveita.
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import Stripe from 'stripe';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error('STRIPE_SECRET_KEY not set'); process.exit(1); }
const stripe = new Stripe(key, { apiVersion: '2026-02-25.clover' });

type Spec = {
  code: string;
  percent: number;
  planSlugs: string[];
};

const SPECS: Spec[] = [
  { code: 'GUSTAGOAT10', percent: 10, planSlugs: ['starter', 'basic'] },
  { code: 'GUSTAGOAT15', percent: 15, planSlugs: ['creator'] },
  { code: 'GUSTAGOAT17', percent: 17, planSlugs: ['pro'] },
  { code: 'GUSTAGOAT25', percent: 25, planSlugs: ['advanced'] },
  { code: 'GUSTAGOAT30', percent: 30, planSlugs: ['studio'] },
];

async function listAllProducts(): Promise<Stripe.Product[]> {
  const all: Stripe.Product[] = [];
  let starting_after: string | undefined;
  while (true) {
    const page = await stripe.products.list({ limit: 100, active: true, starting_after });
    all.push(...page.data);
    if (!page.has_more) break;
    starting_after = page.data[page.data.length - 1].id;
  }
  return all;
}

const NAME_BY_SLUG: Record<string, string> = {
  starter: 'The AI Model Lab.ai — Plano Starter',
  basic: 'The AI Model Lab.ai — Plano Basic',
  creator: 'The AI Model Lab.ai — Plano Creator',
  pro: 'The AI Model Lab.ai — Plano Pro',
  advanced: 'The AI Model Lab.ai — Plano Advanced',
  studio: 'The AI Model Lab.ai — Plano Studio',
};

async function resolveProductIds(slugs: string[], products: Stripe.Product[]): Promise<string[]> {
  const ids: string[] = [];
  for (const slug of slugs) {
    const target = NAME_BY_SLUG[slug];
    if (!target) throw new Error(`No name mapping for slug="${slug}"`);
    const match =
      products.find((p) => p.metadata?.slug === slug) ||
      products.find((p) => p.name === target);
    if (!match) throw new Error(`No Stripe product found for slug="${slug}" (name "${target}")`);
    ids.push(match.id);
  }
  return ids;
}

async function findCouponByName(name: string): Promise<Stripe.Coupon | null> {
  let starting_after: string | undefined;
  while (true) {
    const page = await stripe.coupons.list({ limit: 100, starting_after });
    const hit = page.data.find((c) => c.name === name);
    if (hit) return hit;
    if (!page.has_more) return null;
    starting_after = page.data[page.data.length - 1].id;
  }
}

async function findPromotionCode(code: string): Promise<Stripe.PromotionCode | null> {
  const page = await stripe.promotionCodes.list({ code, limit: 1 });
  return page.data[0] || null;
}

async function upsertCoupon(spec: Spec, productIds: string[]): Promise<Stripe.Coupon> {
  const existing = await findCouponByName(spec.code);
  if (existing) {
    console.log(`  ↻ coupon already exists: ${existing.id} (${existing.name})`);
    return existing;
  }
  const coupon = await stripe.coupons.create({
    name: spec.code,
    percent_off: spec.percent,
    duration: 'once',
    applies_to: { products: productIds },
    metadata: { source: 'launch-gustagoat', plans: spec.planSlugs.join(',') },
  });
  console.log(`  ✓ coupon created: ${coupon.id}`);
  return coupon;
}

async function upsertPromotionCode(couponId: string, code: string): Promise<Stripe.PromotionCode> {
  const existing = await findPromotionCode(code);
  if (existing) {
    console.log(`  ↻ promo code already exists: ${existing.id} (${existing.code})`);
    return existing;
  }
  const promo = await stripe.promotionCodes.create({
    promotion: { type: 'coupon', coupon: couponId },
    code,
    active: true,
  });
  console.log(`  ✓ promo code created: ${promo.id}`);
  return promo;
}

async function main() {
  console.log('Fetching Stripe products…');
  const products = await listAllProducts();
  console.log(`  found ${products.length} active products`);

  const results: Array<{ code: string; couponId: string; promoId: string; productIds: string[] }> = [];

  for (const spec of SPECS) {
    console.log(`\n→ ${spec.code} (${spec.percent}% off, plans: ${spec.planSlugs.join(', ')})`);
    const productIds = await resolveProductIds(spec.planSlugs, products);
    console.log(`  products: ${productIds.join(', ')}`);
    const coupon = await upsertCoupon(spec, productIds);
    const promo = await upsertPromotionCode(coupon.id, spec.code);
    results.push({ code: spec.code, couponId: coupon.id, promoId: promo.id, productIds });
  }

  console.log('\n── Summary ──');
  console.table(results);
}

main().catch((err) => { console.error(err); process.exit(1); });
