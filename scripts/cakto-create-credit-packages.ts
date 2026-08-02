/**
 * Cria (idempotente) na Cakto o produto de PAGAMENTO ÚNICO
 *   "THE AI MODEL LAB — Créditos"
 * + 5 ofertas (uma por pacote de crédito avulso), com os preços BRL. Ao final,
 * imprime os offerIds e o bloco SQL `UPDATE` pronto para colar em
 * `prisma/manual/2026-08-01_cakto_credit_packages.sql` (passo 5), preenchendo
 * `credit_packages.cakto_offer_code` e `credit_package_prices.checkout_url`.
 *
 * Rodar com (NÃO toca no banco; só chama a API da Cakto):
 *   cd theaimodelab-api && npx ts-node scripts/cakto-create-credit-packages.ts
 *
 * Idempotente: antes de criar, procura o produto pelo nome e cada oferta pelo
 * nome dentro do produto; se já existir, reaproveita (não duplica).
 *
 * Env necessárias (só em .env, nunca no repo):
 *   CAKTO_CLIENT_ID, CAKTO_CLIENT_SECRET
 *
 * ⚠️ O formato exato dos bodies de criação de produto/oferta da Cakto NÃO é
 * documentado publicamente. Os campos abaixo seguem o padrão observado
 * (product único de assinatura d954f7b1-…, ofertas com preço BRL). Se a API
 * recusar algum campo, ajuste PRODUCT_BODY / offerBody conforme a resposta de
 * erro — a lógica de auth, busca e idempotência permanece válida.
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const API_BASE = 'https://api.cakto.com.br/public_api';
const CLIENT_ID = process.env.CAKTO_CLIENT_ID;
const CLIENT_SECRET = process.env.CAKTO_CLIENT_SECRET;

// Nome do produto one-off (usado para encontrar/reaproveitar de forma idempotente).
const PRODUCT_NAME = 'THE AI MODEL LAB — Créditos';

// Pacotes: FONTE DA VERDADE dos preços BRL está no seed (PACKAGE_CAKTO). Mantidos
// aqui em sincronia para o script criar as ofertas com os valores certos.
// `name` casa com CreditPackage.name no banco (usado no SQL UPDATE final).
const PACKAGES: Array<{ name: string; credits: number; priceBrl: number }> = [
  { name: 'Plus', credits: 5000, priceBrl: 24.9 },
  { name: 'Turbo', credits: 12000, priceBrl: 59.9 },
  { name: 'Mega', credits: 25000, priceBrl: 109.9 },
  { name: 'Ultra', credits: 42000, priceBrl: 199.9 },
  { name: 'Max', credits: 60000, priceBrl: 429.9 },
];

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('❌ CAKTO_CLIENT_ID / CAKTO_CLIENT_SECRET não configurados no .env');
    process.exit(1);
  }

  const token = await authenticate(CLIENT_ID, CLIENT_SECRET);
  console.log('🔑 Autenticado na Cakto.');

  const product = await findOrCreateProduct(token);
  console.log(`📦 Produto: "${product.name}" (id=${product.id})`);

  const results: Array<{ name: string; offerId: string }> = [];
  for (const pkg of PACKAGES) {
    const offer = await findOrCreateOffer(token, product.id, pkg);
    console.log(
      `  • ${pkg.name} (R$${pkg.priceBrl.toFixed(2)}, ${pkg.credits} cr) → offer ${offer.id}`,
    );
    results.push({ name: pkg.name, offerId: offer.id });
  }

  printSql(results);
}

// ────────────────────────────────────────────────────────────
// Cakto API
// ────────────────────────────────────────────────────────────

async function authenticate(clientId: string, clientSecret: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(`${API_BASE}/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Falha ao autenticar (${res.status}): ${await res.text()}`);
  }
  const json: any = await res.json();
  const token = json.access_token ?? json.accessToken ?? json.token;
  if (!token) throw new Error(`Resposta sem access_token: ${JSON.stringify(json)}`);
  return token;
}

async function apiGet(token: string, pathAndQuery: string): Promise<any> {
  const res = await fetch(`${API_BASE}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`GET ${pathAndQuery} falhou (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function apiPost(token: string, pathName: string, body: unknown): Promise<any> {
  const res = await fetch(`${API_BASE}${pathName}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${pathName} falhou (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

/** Normaliza respostas paginadas (`{results:[]}`) ou arrays crus. */
function asList(json: any): any[] {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.results)) return json.results;
  if (Array.isArray(json?.data)) return json.data;
  return [];
}

async function findOrCreateProduct(token: string): Promise<{ id: string; name: string }> {
  const existing = asList(await apiGet(token, '/products/')).find(
    (p: any) => (p?.name ?? '').trim() === PRODUCT_NAME,
  );
  if (existing) return { id: String(existing.id), name: existing.name };

  console.log(`➕ Criando produto one-off "${PRODUCT_NAME}"...`);
  const PRODUCT_BODY = {
    name: PRODUCT_NAME,
    description: 'Pacotes de crédito avulsos (bônus, não expiram) — THE AI MODEL LAB',
    // Pagamento único (não recorrente). Ajuste a chave/valor se a API exigir
    // outro enum (ex.: 'one_time' / 'single' / product_type).
    payment_type: 'one_time',
    currency: 'BRL',
  };
  const created = await apiPost(token, '/products/', PRODUCT_BODY);
  return { id: String(created.id), name: created.name ?? PRODUCT_NAME };
}

async function findOrCreateOffer(
  token: string,
  productId: string,
  pkg: { name: string; credits: number; priceBrl: number },
): Promise<{ id: string }> {
  const offerName = `${pkg.name} — ${pkg.credits.toLocaleString('pt-BR')} créditos`;
  const existing = asList(
    await apiGet(token, `/offers/?product=${encodeURIComponent(productId)}`),
  ).find((o: any) => (o?.name ?? '').trim() === offerName);
  if (existing) return { id: String(existing.id) };

  const offerBody = {
    product: productId,
    name: offerName,
    // Preço em reais (float). Se a API exigir centavos, troque por
    // Math.round(pkg.priceBrl * 100).
    price: pkg.priceBrl,
    currency: 'BRL',
  };
  const created = await apiPost(token, '/offers/', offerBody);
  return { id: String(created.id) };
}

// ────────────────────────────────────────────────────────────
// Saída
// ────────────────────────────────────────────────────────────

function printSql(results: Array<{ name: string; offerId: string }>) {
  const values = results
    .map((r) => `    ('${r.name}', '${r.offerId}')`)
    .join(',\n');

  console.log('\n────────────────────────────────────────────────────────────');
  console.log('✅ Ofertas prontas. Cole o SQL abaixo no passo 5 de');
  console.log('   prisma/manual/2026-08-01_cakto_credit_packages.sql (schema theaimodelab):\n');
  console.log('BEGIN;');
  console.log('UPDATE "theaimodelab"."credit_packages" AS cp');
  console.log('SET    "cakto_offer_code" = v.offer');
  console.log('FROM (VALUES');
  console.log(values);
  console.log(') AS v(name, offer)');
  console.log('WHERE cp."name" = v.name;\n');
  console.log('UPDATE "theaimodelab"."credit_package_prices" AS pp');
  console.log("SET    \"checkout_url\" = 'https://pay.cakto.com.br/' || v.offer");
  console.log('FROM (VALUES');
  console.log(values);
  console.log(') AS v(name, offer)');
  console.log('JOIN "theaimodelab"."credit_packages" cp ON cp."name" = v.name');
  console.log("WHERE pp.\"credit_package_id\" = cp.\"id\" AND pp.\"currency\" = 'BRL';");
  console.log('COMMIT;');
  console.log('────────────────────────────────────────────────────────────');
}

main().catch((err) => {
  console.error('❌ Erro:', err instanceof Error ? err.message : err);
  process.exit(1);
});
