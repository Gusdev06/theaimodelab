/**
 * Archives the OLD Boost P prices (R$14,90 / $3,90 / €3,50) on Stripe.
 *
 * Boost M (R$26,90) and Boost G (R$36,90) are KEPT active.
 * All three old boosts share the same product "The AI Model Lab.ai — Pacote de Créditos",
 * so we archive by price ID (not product).
 *
 * Run:
 *   STRIPE_SECRET_KEY=sk_live_... npx ts-node scripts/archive-old-boost-p.ts
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import Stripe from 'stripe';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const key = process.env.STRIPE_SECRET_KEY!;
const stripe = new Stripe(key, { apiVersion: '2026-02-25.clover' });

const OLD_BOOST_P_PRICE_IDS_LIVE = [
  { id: 'price_1TFgceBFQnG9Nke5CvuZNGEV', label: 'Boost P BRL R$14,90 [live]' },
  { id: 'price_1TLqkCBFQnG9Nke5Ep8ltIwZ', label: 'Boost P USD $3,90 [live]' },
  { id: 'price_1TLqkEBFQnG9Nke5hocLoWl2', label: 'Boost P EUR €3,50 [live]' },
];

const OLD_BOOST_P_PRICE_IDS_TEST = [
  { id: 'price_1TG3vMBFQnG9Nke5w5ezpbze', label: 'Boost P BRL R$14,90 [test]' },
];

const OLD_BOOST_P_PRICE_IDS = key.startsWith('sk_live')
  ? OLD_BOOST_P_PRICE_IDS_LIVE
  : OLD_BOOST_P_PRICE_IDS_TEST;

async function main() {
  const mode = key.startsWith('sk_live') ? 'LIVE' : 'TEST';
  console.log(`\n🗄️  Archiving old Boost P prices on ${mode} mode…\n`);

  for (const { id, label } of OLD_BOOST_P_PRICE_IDS) {
    try {
      const before = await stripe.prices.retrieve(id);
      if (!before.active) {
        console.log(`  · ${label} já estava inativo (${id}) — skip`);
        continue;
      }
      const updated = await stripe.prices.update(id, { active: false });
      console.log(`  ✅ ${label} → active=${updated.active}  (${id})`);
    } catch (e: any) {
      console.log(`  ⚠️  ${label} (${id}): ${e?.message ?? e}`);
    }
  }

  console.log('\n✔ Done.');
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
