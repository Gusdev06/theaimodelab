/**
 * Cria (de forma idempotente) o cupom RECOVERY20 no Stripe.
 *
 * - 20% OFF
 * - duration: once (aplica só na primeira fatura após reativação)
 * - aplicável a TODOS os planos pagos (Starter, Creator, Pro, Studio, etc)
 * - PromotionCode RECOVERY20 (digitável + usado pelo backend pra auto-apply)
 *
 * Roda:
 *   cd theaimodelab-api && npx ts-node scripts/create-recovery-coupon.ts
 *
 * Idempotente: se cupom ou promo code já existir, reaproveita.
 *
 * Após rodar, configurar no .env:
 *   RECOVERY_COUPON_CODE=RECOVERY20
 *   RECOVERY_COUPON_DISCOUNT=20%
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import Stripe from 'stripe';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('❌ STRIPE_SECRET_KEY not set');
  process.exit(1);
}
const stripe = new Stripe(key, { apiVersion: '2026-02-25.clover' });

const COUPON_CODE = 'RECOVERY20';
const PERCENT_OFF = 20;
const PAID_PLAN_SLUGS = ['ultra-basic', 'starter', 'basic', 'creator', 'pro', 'advanced', 'studio'];

async function listActiveProducts(): Promise<Stripe.Product[]> {
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

async function main() {
  const mode = key!.startsWith('sk_live') ? 'LIVE' : 'TEST';
  console.log(`\n🎟️  Criando cupom ${COUPON_CODE} (${PERCENT_OFF}% off) no Stripe — ${mode}\n`);

  // 1. Resolver product IDs dos planos pagos (aqueles que existem no Stripe)
  console.log('🔎 Buscando produtos no Stripe…');
  const products = await listActiveProducts();
  const productIds: string[] = [];
  for (const product of products) {
    const slug = (product.metadata?.slug as string | undefined) ||
      (product.name?.toLowerCase().includes('starter') ? 'starter' : undefined) ||
      (product.name?.toLowerCase().includes('creator') ? 'creator' : undefined) ||
      (product.name?.toLowerCase().includes('pro') ? 'pro' : undefined) ||
      (product.name?.toLowerCase().includes('studio') ? 'studio' : undefined);
    if (slug && PAID_PLAN_SLUGS.includes(slug)) {
      productIds.push(product.id);
      console.log(`   ✓ ${product.name} (${product.id}) → slug "${slug}"`);
    }
  }
  if (productIds.length === 0) {
    console.error('❌ Nenhum produto pago encontrado no Stripe. Rode create-stripe-products-v5.ts primeiro.');
    process.exit(1);
  }
  console.log(`   Total: ${productIds.length} planos pagos\n`);

  // 2. Upsert do Coupon
  let coupon = await findCouponByName(COUPON_CODE);
  if (coupon) {
    console.log(`↻ Coupon já existe: ${coupon.id} (${coupon.name})`);
  } else {
    coupon = await stripe.coupons.create({
      name: COUPON_CODE,
      percent_off: PERCENT_OFF,
      duration: 'once',
      applies_to: { products: productIds },
      metadata: {
        source: 'recovery-campaign',
        purpose: 'reactivate-canceled-subscriptions',
      },
    });
    console.log(`✓ Coupon criado: ${coupon.id} (${PERCENT_OFF}% OFF, duration=once)`);
  }

  // 3. Upsert do PromotionCode (o que o usuário digita ou o backend aplica)
  let promo = await findPromotionCode(COUPON_CODE);
  if (promo) {
    console.log(`↻ PromotionCode já existe: ${promo.id} (${promo.code})`);
  } else {
    promo = await stripe.promotionCodes.create({
      promotion: { type: 'coupon', coupon: coupon.id },
      code: COUPON_CODE,
      active: true,
      metadata: {
        source: 'recovery-campaign',
      },
    });
    console.log(`✓ PromotionCode criado: ${promo.id} (${promo.code})`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('✅ Cupom RECOVERY20 pronto pra uso.');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   Coupon ID:        ${coupon.id}`);
  console.log(`   PromotionCode ID: ${promo.id}`);
  console.log(`   Code (digitável): ${promo.code}`);
  console.log(`   Aplica em:        ${productIds.length} planos`);
  console.log('\n🔧 Adicione ao .env:');
  console.log(`   RECOVERY_COUPON_CODE=${COUPON_CODE}`);
  console.log(`   RECOVERY_COUPON_DISCOUNT=${PERCENT_OFF}%`);
  console.log(`   RECOVERY_PROMOTION_CODE_ID=${promo.id}\n`);
}

main().catch((err) => {
  console.error('\n❌', err);
  process.exit(1);
});
