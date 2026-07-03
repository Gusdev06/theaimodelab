/**
 * Lists all active one-time prices (credit packages) on Stripe.
 *
 * Run:
 *   npx ts-node scripts/list-stripe-packages.ts           # test mode (.env)
 *   STRIPE_SECRET_KEY=sk_live_... npx ts-node scripts/list-stripe-packages.ts
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import Stripe from 'stripe';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const key = process.env.STRIPE_SECRET_KEY!;
const stripe = new Stripe(key, { apiVersion: '2026-02-25.clover' });

async function main() {
  const mode = key.startsWith('sk_live') ? 'LIVE' : 'TEST';
  console.log(`\n🔎 Listing Stripe prices in ${mode} mode…\n`);

  // Pull all active prices (one-time + recurring)
  const prices: Stripe.Price[] = [];
  let cursor: string | undefined;
  while (true) {
    const page = await stripe.prices.list({
      active: true,
      limit: 100,
      starting_after: cursor,
      expand: ['data.product'],
    });
    prices.push(...page.data);
    if (!page.has_more) break;
    cursor = page.data[page.data.length - 1].id;
  }

  // Filter: one-time prices (no recurring) with active product = credit packages
  const oneTime = prices.filter((p) => {
    if (p.recurring) return false;
    const prod = p.product as Stripe.Product;
    return prod && prod.active !== false;
  });

  // Group by product
  const byProduct = new Map<string, { product: Stripe.Product; prices: Stripe.Price[] }>();
  for (const p of oneTime) {
    const prod = p.product as Stripe.Product;
    const key = prod.id;
    if (!byProduct.has(key)) byProduct.set(key, { product: prod, prices: [] });
    byProduct.get(key)!.prices.push(p);
  }

  console.log(`Total one-time prices ativos: ${oneTime.length}`);
  console.log(`Total produtos (pacotes) ativos: ${byProduct.size}\n`);

  const sorted = [...byProduct.values()].sort((a, b) =>
    a.product.name.localeCompare(b.product.name),
  );

  for (const { product, prices } of sorted) {
    console.log(`📦 ${product.name}  (product_id: ${product.id})`);
    if (product.description) console.log(`   ${product.description}`);
    for (const p of prices.sort((x, y) => x.currency.localeCompare(y.currency))) {
      const amt = ((p.unit_amount ?? 0) / 100).toFixed(2);
      console.log(
        `   ${p.currency.toUpperCase()} ${amt}  →  ${p.id}  (created ${new Date(p.created * 1000).toISOString().slice(0, 10)})`,
      );
    }
    console.log('');
  }

  // Also list recurring (plans) for context
  const recurring = prices.filter((p) => p.recurring);
  const byRecurringProduct = new Map<string, { product: Stripe.Product; prices: Stripe.Price[] }>();
  for (const p of recurring) {
    const prod = p.product as Stripe.Product;
    if (!prod || prod.active === false) continue;
    const key = prod.id;
    if (!byRecurringProduct.has(key)) byRecurringProduct.set(key, { product: prod, prices: [] });
    byRecurringProduct.get(key)!.prices.push(p);
  }

  console.log(`\n────────────────────────────────\n`);
  console.log(`ℹ️  Planos recorrentes ativos: ${byRecurringProduct.size}  (${recurring.length} prices)`);
  for (const { product, prices } of [...byRecurringProduct.values()].sort((a, b) =>
    a.product.name.localeCompare(b.product.name),
  )) {
    console.log(`   · ${product.name}  (${prices.length} moedas)`);
  }
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
