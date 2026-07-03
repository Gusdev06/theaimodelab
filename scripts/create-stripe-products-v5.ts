/**
 * Creates new Stripe products + prices for v5 pricing (2026-04).
 *
 * Run with:
 *   cd theaimodelab-api && npx ts-node scripts/create-stripe-products-v5.ts
 *
 * Does NOT touch the database. Outputs price IDs to stdout and writes a
 * summary file at scripts/stripe-v5-output.json.
 *
 * Authorized creations:
 *   - Free (R$12.90 / 700cr) — was free R$0
 *   - Basic (R$59.90 / 7,000cr) — NEW
 *   - Advanced (R$249.90 / 50,000cr) — NEW
 *   - Boost P v2 (R$16.90 / 550cr) — was R$14.90 / 700cr
 *   - Boost XG (R$69.90 / 6,500cr) — NEW
 *   - Boost XXG (R$149.90 / 14,000cr) — NEW
 *
 * Old products/prices are NOT archived.
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import Stripe from 'stripe';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  console.error('❌ STRIPE_SECRET_KEY not set in .env');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2026-02-25.clover',
});

type CurrencyCents = { BRL: number; USD: number; EUR: number };

interface ProductSpec {
  key: string; // used for env var naming
  name: string; // Stripe product name
  description: string;
  credits: number;
  prices: CurrencyCents; // in cents of each currency
  recurring: boolean; // true => subscription; false => one-time
  metadata?: Record<string, string>;
}

const specs: ProductSpec[] = [
  // ── Plans (recurring monthly) ──
  {
    key: 'PLAN_ULTRABASIC',
    name: 'Ultra Basic',
    description: 'Plano Ultra Basic The AI Model Lab — 700 créditos/mês + 2 vídeos grátis no primeiro acesso',
    credits: 700,
    prices: { BRL: 1290, USD: 290, EUR: 290 },
    recurring: true,
    metadata: { slug: 'ultra-basic', pricing_version: 'v5', credits_per_month: '700' },
  },
  {
    key: 'PLAN_BASIC',
    name: 'Basic',
    description: 'Plano Basic The AI Model Lab — 7.000 créditos/mês',
    credits: 7000,
    prices: { BRL: 5990, USD: 1290, EUR: 1290 },
    recurring: true,
    metadata: { slug: 'basic', pricing_version: 'v5', credits_per_month: '7000' },
  },
  {
    key: 'PLAN_ADVANCED',
    name: 'Advanced',
    description: 'Plano Advanced The AI Model Lab — 50.000 créditos/mês',
    credits: 50000,
    prices: { BRL: 24990, USD: 5490, EUR: 5490 },
    recurring: true,
    metadata: { slug: 'advanced', pricing_version: 'v5', credits_per_month: '50000' },
  },
  // ── Boost packages (one-time) ──
  {
    key: 'BOOST_P_V2',
    name: 'Boost P',
    description: 'Pacote Boost P — 550 créditos',
    credits: 550,
    prices: { BRL: 1690, USD: 390, EUR: 390 },
    recurring: false,
    metadata: { slug: 'boost-p', pricing_version: 'v5', credits: '550' },
  },
  {
    key: 'BOOST_XG',
    name: 'Boost XG',
    description: 'Pacote Boost XG — 6.500 créditos',
    credits: 6500,
    prices: { BRL: 6990, USD: 1890, EUR: 1890 },
    recurring: false,
    metadata: { slug: 'boost-xg', pricing_version: 'v5', credits: '6500' },
  },
  {
    key: 'BOOST_XXG',
    name: 'Boost XXG',
    description: 'Pacote Boost XXG — 14.000 créditos',
    credits: 14000,
    prices: { BRL: 14990, USD: 3990, EUR: 3990 },
    recurring: false,
    metadata: { slug: 'boost-xxg', pricing_version: 'v5', credits: '14000' },
  },
];

interface Result {
  key: string;
  name: string;
  productId: string;
  prices: { currency: string; priceId: string; amount: number }[];
}

async function createOne(spec: ProductSpec): Promise<Result> {
  console.log(`\n→ Creating product "${spec.name}"…`);

  const product = await stripe.products.create({
    name: spec.name,
    description: spec.description,
    metadata: spec.metadata ?? {},
  });
  console.log(`  product.id = ${product.id}`);

  const priceResults: Result['prices'] = [];
  for (const currency of ['BRL', 'USD', 'EUR'] as const) {
    const amount = spec.prices[currency];
    const priceParams: Stripe.PriceCreateParams = {
      product: product.id,
      currency: currency.toLowerCase(),
      unit_amount: amount,
      metadata: { ...(spec.metadata ?? {}), currency },
    };
    if (spec.recurring) {
      priceParams.recurring = { interval: 'month' };
    }
    const price = await stripe.prices.create(priceParams);
    console.log(`  ${currency} ${(amount / 100).toFixed(2)} → ${price.id}`);
    priceResults.push({ currency, priceId: price.id, amount });
  }

  return {
    key: spec.key,
    name: spec.name,
    productId: product.id,
    prices: priceResults,
  };
}

async function main() {
  console.log(`🚀 Creating Stripe v5 products on ${STRIPE_SECRET_KEY!.startsWith('sk_live') ? 'LIVE' : 'TEST'} mode…`);

  const results: Result[] = [];
  for (const spec of specs) {
    results.push(await createOne(spec));
  }

  // Write summary JSON (separate file for live vs test)
  const isLive = STRIPE_SECRET_KEY!.startsWith('sk_live');
  const outPath = path.resolve(
    __dirname,
    isLive ? 'stripe-v5-output-live.json' : 'stripe-v5-output.json',
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { createdAt: new Date().toISOString(), mode: isLive ? 'live' : 'test', results },
      null,
      2,
    ),
  );

  // Print env-ready block
  console.log('\n\n========== ENV VARS (v5) ==========');
  for (const r of results) {
    const brl = r.prices.find((p) => p.currency === 'BRL')!;
    const usd = r.prices.find((p) => p.currency === 'USD')!;
    const eur = r.prices.find((p) => p.currency === 'EUR')!;
    console.log(`STRIPE_PRICE_${r.key}=${brl.priceId}`);
    console.log(`STRIPE_PRICE_${r.key}_USD=${usd.priceId}`);
    console.log(`STRIPE_PRICE_${r.key}_EUR=${eur.priceId}`);
  }
  console.log('====================================');
  console.log(`\n✅ Summary written to ${outPath}`);
}

main().catch((err) => {
  console.error('❌ Script failed:', err);
  process.exit(1);
});
