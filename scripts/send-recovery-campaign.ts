/**
 * ONDA 1 — DISPARO DA CAMPANHA DE RECUPERAÇÃO
 *
 * Lê o CSV gerado por recover-failed-payments.ts e dispara 1 email da sequência
 * (D+0, D+3 ou D+7) via Resend em batch.
 *
 * Mantém log de envios em scripts/output/recovery-sent-log.json pra evitar
 * disparar o mesmo email 2x pro mesmo lead.
 *
 * Uso:
 *   # Preview no terminal (não envia) — sempre rode primeiro
 *   npx ts-node scripts/send-recovery-campaign.ts \
 *     --csv=scripts/output/recovery-campaign-2026-05-26-with-portals.csv \
 *     --email=1 --dry-run
 *
 *   # Disparo real (D+0 = primeira onda)
 *   npx ts-node scripts/send-recovery-campaign.ts \
 *     --csv=scripts/output/recovery-campaign-2026-05-26-with-portals.csv \
 *     --email=1 --send
 *
 *   # Testar 1 envio só pra você antes de mandar pra todos
 *   npx ts-node scripts/send-recovery-campaign.ts \
 *     --csv=... --email=1 --send --only=seu@email.com
 *
 *   # 3 dias depois, re-rodar recover-failed-payments e disparar Email 2
 *   npm run recovery:export:portals
 *   npx ts-node scripts/send-recovery-campaign.ts --csv=<novo csv> --email=2 --send
 *
 * Env vars necessárias (puxa do .env):
 *   RESEND_API_KEY              (obrigatório)
 *   RESEND_FROM_EMAIL           (obrigatório, ex: "The AI Model Lab <ola@theaimodelab.ai>")
 *   FRONTEND_URL                (default: https://theaimodelab.ai)
 *   LOGO_URL                    (opcional, URL pública do logo)
 *   SUPPORT_EMAIL               (default: ola@theaimodelab.ai)
 *   RECOVERY_COUPON_CODE        (opcional, ex: RECOVERY20 — só usado no email 3)
 *   RECOVERY_COUPON_DISCOUNT    (opcional, ex: "20%" — só usado no email 3)
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { Resend } from 'resend';
import { PrismaClient } from '@prisma/client';
import {
  buildRecoveryEmail,
  type EmailNumber,
  type RecoveryLead,
  type BrandConfig,
} from '../src/payments/recovery/recovery-templates';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
const prisma = new PrismaClient();

// ─────────────────────────────────────────
// ARGS
// ─────────────────────────────────────────
const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : undefined;
}

const CSV_PATH = getArg('csv');
const EMAIL_NUM = parseInt(getArg('email') || '0', 10) as EmailNumber;
const DRY_RUN = args.includes('--dry-run') || !args.includes('--send');
const ONLY_EMAIL = getArg('only'); // testar enviando apenas para 1 email específico
const FORCE = args.includes('--force'); // ignora log e re-envia
const BATCH_SIZE = 90; // Resend aceita até 100 por chamada batch; deixo 90 por segurança

if (!CSV_PATH) {
  console.error('❌ --csv=<caminho> é obrigatório');
  process.exit(1);
}
if (![1, 2, 3].includes(EMAIL_NUM)) {
  console.error('❌ --email=1|2|3 é obrigatório');
  process.exit(1);
}
if (!fs.existsSync(CSV_PATH)) {
  console.error(`❌ CSV não encontrado: ${CSV_PATH}`);
  process.exit(1);
}

// ─────────────────────────────────────────
// CONFIG / BRAND
// ─────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY!;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL!;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://theaimodelab.ai';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'ola@theaimodelab.ai';
const RECOVERY_COUPON_CODE = process.env.RECOVERY_COUPON_CODE;
const RECOVERY_COUPON_DISCOUNT = process.env.RECOVERY_COUPON_DISCOUNT;
const RECOVERY_BONUS_CREDITS = parseInt(process.env.RECOVERY_BONUS_CREDITS || '2000', 10);

if (!RESEND_API_KEY || !FROM_EMAIL) {
  console.error('❌ RESEND_API_KEY e RESEND_FROM_EMAIL precisam estar no .env');
  process.exit(1);
}

if (EMAIL_NUM === 3 && !RECOVERY_COUPON_CODE) {
  console.warn('⚠️  Email 3 sem cupom configurado. Vai mandar versão sem desconto.');
  console.warn('   Para incluir cupom, crie no Stripe e configure no .env:');
  console.warn('     RECOVERY_COUPON_CODE=RECOVERY20');
  console.warn('     RECOVERY_COUPON_DISCOUNT=20%');
}

const brand: BrandConfig = {
  frontendUrl: FRONTEND_URL,
  supportEmail: SUPPORT_EMAIL,
  recoveryCouponCode: RECOVERY_COUPON_CODE,
  recoveryCouponDiscount: RECOVERY_COUPON_DISCOUNT,
  bonusCredits: RECOVERY_BONUS_CREDITS,
};

// ─────────────────────────────────────────
// CSV PARSER (RFC 4180 — suporta aspas duplas e vírgulas dentro de campo)
// ─────────────────────────────────────────
function parseCsv(content: string): Record<string, string>[] {
  const lines: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    const next = content[i + 1];

    if (inQuotes) {
      if (c === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cell += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(cell);
        cell = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && next === '\n') i++;
        row.push(cell);
        lines.push(row);
        row = [];
        cell = '';
      } else {
        cell += c;
      }
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    lines.push(row);
  }

  const headers = lines[0];
  return lines.slice(1).filter((r) => r.length > 1 || (r.length === 1 && r[0] !== '')).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = r[i] ?? '';
    });
    return obj;
  });
}

// ─────────────────────────────────────────
// LOG DE ENVIOS (idempotência)
// ─────────────────────────────────────────
const LOG_PATH = path.resolve(__dirname, 'output', 'recovery-sent-log.json');

interface SentLog {
  [email: string]: { [emailNum: string]: string }; // email → { "1": "2026-05-26T...", "2": ... }
}

function loadLog(): SentLog {
  if (!fs.existsSync(LOG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(LOG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveLog(log: SentLog) {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2), 'utf-8');
}

// ─────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────
async function main() {
  console.log(`\n📧 Campanha de Recuperação — Email ${EMAIL_NUM}\n`);
  console.log(`   CSV:        ${CSV_PATH}`);
  console.log(`   From:       ${FROM_EMAIL}`);
  console.log(`   Modo:       ${DRY_RUN ? '🔬 DRY-RUN (não envia)' : '🚀 SEND REAL'}`);
  if (ONLY_EMAIL) console.log(`   Filtro:     apenas ${ONLY_EMAIL}`);
  if (FORCE) console.log(`   Force:      ignorando log de envios anteriores`);
  console.log('');

  const csvContent = fs.readFileSync(CSV_PATH!, 'utf-8');
  const rows = parseCsv(csvContent);
  console.log(`📋 ${rows.length} leads no CSV\n`);

  const log = loadLog();

  // Converter CSV rows em RecoveryLead + filtrar
  const leads: { row: Record<string, string>; lead: RecoveryLead }[] = [];
  let skippedAlreadySent = 0;
  let skippedOnlyFilter = 0;
  let skippedNoEmail = 0;

  for (const row of rows) {
    const email = row['email']?.trim().toLowerCase();
    if (!email) {
      skippedNoEmail++;
      continue;
    }
    if (ONLY_EMAIL && email !== ONLY_EMAIL.toLowerCase()) {
      skippedOnlyFilter++;
      continue;
    }
    if (!FORCE && log[email]?.[String(EMAIL_NUM)]) {
      skippedAlreadySent++;
      continue;
    }

    const planPriceCents = Math.round(parseFloat(row['plan_price_brl'] || '0') * 100);
    const lead: RecoveryLead = {
      name: row['name'] || 'amigo',
      planName: row['plan_name'] || 'Pro',
      planPriceBRL: (planPriceCents / 100).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
      }),
      daysSinceFailure: parseInt(row['days_since_failure'] || '0', 10),
      declineCode: row['decline_code'] || 'unknown',
      declineLabel: row['decline_label'] || '',
      cardBrand: row['card_brand'] || null,
      cardLast4: row['card_last4'] || null,
      billingPortalUrl: row['billing_portal_url'] || null,
      lastInvoiceUrl: row['last_invoice_url'] || null,
    };
    leads.push({ row, lead });
  }

  console.log(`✅ ${leads.length} leads serão processados`);
  if (skippedAlreadySent) console.log(`⏭️  ${skippedAlreadySent} pulados (já receberam Email ${EMAIL_NUM})`);
  if (skippedOnlyFilter) console.log(`⏭️  ${skippedOnlyFilter} pulados (filtro --only)`);
  if (skippedNoEmail) console.log(`⏭️  ${skippedNoEmail} pulados (sem email no CSV)`);
  console.log('');

  if (leads.length === 0) {
    console.log('Nada pra enviar.');
    return;
  }

  // Validação extra: avisar se algum lead não tem billing_portal_url e o CSV é "with-portals"
  if (CSV_PATH!.includes('with-portals')) {
    const semPortal = leads.filter((l) => !l.lead.billingPortalUrl).length;
    if (semPortal > 0) {
      console.warn(`⚠️  ${semPortal} leads sem billing_portal_url — cairão no link genérico ${FRONTEND_URL}/perfil\n`);
    }
  }

  // Preview do primeiro
  console.log('═══════════════════════════════════════════════════════════');
  console.log('PREVIEW DO PRIMEIRO LEAD:');
  console.log('═══════════════════════════════════════════════════════════');
  const preview = buildRecoveryEmail(EMAIL_NUM, leads[0].lead, brand);
  console.log(`To:      ${leads[0].row['email']}`);
  console.log(`Subject: ${preview.subject}`);
  console.log(`HTML size: ${preview.html.length} chars`);
  console.log('═══════════════════════════════════════════════════════════\n');

  if (DRY_RUN) {
    // Em dry-run, salva o HTML do preview pra inspeção visual
    const previewPath = path.resolve(
      __dirname,
      'output',
      `preview-email-${EMAIL_NUM}.html`,
    );
    fs.mkdirSync(path.dirname(previewPath), { recursive: true });
    fs.writeFileSync(previewPath, preview.html, 'utf-8');
    console.log(`📄 Preview HTML salvo em: ${previewPath}`);
    console.log(`   Abre no navegador pra ver: open ${previewPath}\n`);
    console.log(`ℹ️  Dry-run completo. Use --send para enviar de verdade.`);
    return;
  }

  // ─────── ENVIO REAL ───────
  const resend = new Resend(RESEND_API_KEY);

  const sentNow = new Date().toISOString();
  let sentCount = 0;
  let errorCount = 0;
  const errors: { email: string; error: string }[] = [];

  // Envio em batches de 90 via Resend batch API
  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE);
    const payload = batch.map(({ row, lead }) => {
      const built = buildRecoveryEmail(EMAIL_NUM, lead, brand);
      return {
        from: FROM_EMAIL,
        to: [row['email']],
        subject: built.subject,
        html: built.html,
      };
    });

    process.stdout.write(`   Enviando batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} emails)... `);

    try {
      const { data, error } = await resend.batch.send(payload);
      if (error) {
        console.log(`❌`);
        console.error(`   Resend batch error:`, error);
        errorCount += batch.length;
        batch.forEach(({ row }) => errors.push({ email: row['email'], error: JSON.stringify(error) }));
        continue;
      }

      console.log(`✅ ${data?.data?.length ?? batch.length} enfileirados`);
      sentCount += batch.length;

      // Marcar no log local
      batch.forEach(({ row }) => {
        const email = row['email'].toLowerCase();
        if (!log[email]) log[email] = {};
        log[email][String(EMAIL_NUM)] = sentNow;
      });
      saveLog(log);

      // Upsert PaymentRecoveryCampaign no DB — habilita o webhook a conceder
      // o bônus de retorno quando o pagamento for confirmado.
      const sentDate = new Date(sentNow);
      const emailField =
        EMAIL_NUM === 1 ? 'email1SentAt' : EMAIL_NUM === 2 ? 'email2SentAt' : 'email3SentAt';

      for (const { row } of batch) {
        const subscriptionId = row['subscription_id'];
        const userId = row['user_id'];
        if (!subscriptionId || !userId) {
          continue; // CSV antigo sem subscription_id — pula
        }
        try {
          await prisma.paymentRecoveryCampaign.upsert({
            where: { subscriptionId },
            create: {
              userId,
              subscriptionId,
              [emailField]: sentDate,
              declineCode: row['decline_code'] || null,
              cardBrand: row['card_brand'] || null,
              cardLast4: row['card_last4'] || null,
            },
            update: {
              [emailField]: sentDate,
              // Atualiza dados de cartão/decline se mudaram entre disparos
              declineCode: row['decline_code'] || null,
              cardBrand: row['card_brand'] || null,
              cardLast4: row['card_last4'] || null,
            },
          });
        } catch (err: any) {
          console.warn(`   ⚠️  Falha ao upsert campaign p/ sub ${subscriptionId}: ${err.message}`);
        }
      }
    } catch (err: any) {
      console.log(`❌`);
      console.error(`   Exception:`, err.message);
      errorCount += batch.length;
      batch.forEach(({ row }) => errors.push({ email: row['email'], error: err.message }));
    }

    // Throttle entre batches (Resend tem rate limit de ~10/s no plano free)
    if (i + BATCH_SIZE < leads.length) {
      await new Promise((r) => setTimeout(r, 1100));
    }
  }

  // ─────── RESUMO ───────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`✅ Enviados: ${sentCount}`);
  if (errorCount > 0) console.log(`❌ Falhas:   ${errorCount}`);
  console.log(`📁 Log salvo em: ${LOG_PATH}`);
  console.log('═══════════════════════════════════════════════════════════');

  if (errors.length > 0) {
    console.log('\nErros detalhados:');
    errors.slice(0, 10).forEach((e) => console.log(`   ${e.email}: ${e.error}`));
    if (errors.length > 10) console.log(`   ... e mais ${errors.length - 10}`);
  }
}

main()
  .catch((e) => {
    console.error('\n❌', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
