/**
 * ONDA 1 — RECUPERAÇÃO DE PAGAMENTOS FALHOS
 *
 * Extrai todas as assinaturas que perderam renovação por falha de cartão
 * (PAST_DUE ou CANCELED recente com retry > 0), cruza com Stripe para pegar
 * o motivo real da falha (decline_code), e gera um CSV pronto para disparar
 * campanha de win-back via Resend/email marketing.
 *
 * Uso:
 *   # Dry-run (apenas lista no terminal, não cria arquivo)
 *   npx ts-node scripts/recover-failed-payments.ts
 *
 *   # Exporta CSV em ./scripts/output/
 *   npx ts-node scripts/recover-failed-payments.ts --export
 *
 *   # Exporta CSV + gera Billing Portal URLs (válidas por 24h)
 *   # Use APENAS se for disparar a campanha nas próximas 24h.
 *   npx ts-node scripts/recover-failed-payments.ts --export --with-portal-urls
 *
 *   # Ajusta janela de "CANCELED recente" (default: 30 dias)
 *   npx ts-node scripts/recover-failed-payments.ts --export --days=45
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const stripeKey = process.env.STRIPE_SECRET_KEY!;
const stripe = new Stripe(stripeKey, { apiVersion: '2026-02-25.clover' });
const prisma = new PrismaClient();

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://theaimodelab.ai';
const RETURN_URL = `${FRONTEND_URL}/perfil?from=recovery`;

const args = process.argv.slice(2);
const EXPORT_CSV = args.includes('--export');
const WITH_PORTAL_URLS = args.includes('--with-portal-urls');
const daysArg = args.find((a) => a.startsWith('--days='));
const RECENT_CANCEL_DAYS = daysArg ? parseInt(daysArg.split('=')[1], 10) : 30;

// Mapa de decline_code → motivo humanizado em pt-BR + estratégia sugerida
const DECLINE_REASONS: Record<string, { label: string; strategy: string }> = {
  insufficient_funds: {
    label: 'Sem saldo no cartão',
    strategy: 'Email D+0/D+3/D+7 — sugerir trocar cartão ou aguardar próxima fatura',
  },
  card_declined: {
    label: 'Cartão recusado pelo banco',
    strategy: 'Email D+0 com CTA forte para atualizar cartão',
  },
  generic_decline: {
    label: 'Recusado pelo emissor (motivo não informado)',
    strategy: 'Email D+0 — pedir para tentar outro cartão',
  },
  expired_card: {
    label: 'Cartão expirado',
    strategy: 'Email D+0 — link direto pro Billing Portal trocar cartão',
  },
  incorrect_cvc: {
    label: 'CVC incorreto',
    strategy: 'Email D+0 — pedir para revisar dados do cartão',
  },
  processing_error: {
    label: 'Erro de processamento (problema temporário)',
    strategy: 'Aguardar retry automático do Stripe; email só após 2ª falha',
  },
  lost_card: {
    label: 'Cartão perdido/bloqueado',
    strategy: 'Email D+0 — claramente precisa de novo cartão',
  },
  stolen_card: {
    label: 'Cartão reportado como roubado',
    strategy: 'Email D+0 — claramente precisa de novo cartão',
  },
  authentication_required: {
    label: 'Autenticação 3D Secure pendente',
    strategy: 'Email com link pro Billing Portal (faz challenge automático)',
  },
  do_not_honor: {
    label: 'Banco não autorizou (do_not_honor)',
    strategy: 'Email — sugerir entrar em contato com banco ou trocar cartão',
  },
};

function humanizeDecline(declineCode: string | null | undefined, failureMessage: string | null | undefined) {
  if (!declineCode) {
    return {
      code: 'unknown',
      label: failureMessage || 'Motivo desconhecido',
      strategy: 'Email genérico de falha — pedir para atualizar pagamento',
    };
  }
  const mapped = DECLINE_REASONS[declineCode];
  if (mapped) return { code: declineCode, ...mapped };
  return {
    code: declineCode,
    label: failureMessage || declineCode,
    strategy: 'Email genérico de falha — pedir para atualizar pagamento',
  };
}

interface RecoveryLead {
  userId: string;
  subscriptionId: string;
  email: string;
  name: string;
  phone: string | null;
  planSlug: string;
  planName: string;
  planPriceCents: number;
  subscriptionStatus: string;
  paymentRetryCount: number;
  currentPeriodEnd: Date;
  daysSinceFailure: number;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  declineCode: string;
  declineLabel: string;
  declineStrategy: string;
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
  lastInvoiceId: string | null;
  lastInvoiceHostedUrl: string | null;
  billingPortalUrl: string | null;
  utmSource: string | null;
  utmCampaign: string | null;
}

async function getStripeContext(customerId: string | null, subscriptionId: string | null) {
  const ctx = {
    declineCode: null as string | null,
    failureMessage: null as string | null,
    cardBrand: null as string | null,
    cardLast4: null as string | null,
    cardExpMonth: null as number | null,
    cardExpYear: null as number | null,
    lastInvoiceId: null as string | null,
    lastInvoiceHostedUrl: null as string | null,
  };

  if (!customerId) return ctx;

  try {
    // 1. Charge mais recente FALHADO (tem failure_code + failure_message direto)
    const charges = await stripe.charges.list({
      customer: customerId,
      limit: 10,
    });

    const lastFailedCharge = charges.data.find((c) => c.status === 'failed');
    if (lastFailedCharge) {
      ctx.declineCode =
        lastFailedCharge.outcome?.reason ||
        lastFailedCharge.failure_code ||
        null;
      ctx.failureMessage = lastFailedCharge.failure_message || null;
    }

    // Pega a invoice mais recente (open/unpaid de preferência) para o hosted URL
    const invoices = await stripe.invoices.list({
      customer: customerId,
      limit: 5,
      ...(subscriptionId ? { subscription: subscriptionId } : {}),
    });
    const lastInvoice =
      invoices.data.find((inv) => inv.status === 'open' || inv.status === 'uncollectible') ||
      invoices.data[0];
    if (lastInvoice) {
      ctx.lastInvoiceId = lastInvoice.id ?? null;
      ctx.lastInvoiceHostedUrl = lastInvoice.hosted_invoice_url ?? null;
    }

    // 2. Cartão atual default
    const customer = await stripe.customers.retrieve(customerId);
    if (customer && !customer.deleted) {
      const defaultPmId = (customer as Stripe.Customer).invoice_settings?.default_payment_method;
      if (defaultPmId) {
        const pmIdStr = typeof defaultPmId === 'string' ? defaultPmId : defaultPmId.id;
        try {
          const pm = await stripe.paymentMethods.retrieve(pmIdStr);
          if (pm.card) {
            ctx.cardBrand = pm.card.brand;
            ctx.cardLast4 = pm.card.last4;
            ctx.cardExpMonth = pm.card.exp_month;
            ctx.cardExpYear = pm.card.exp_year;
          }
        } catch {
          // PM pode ter sido removido, segue
        }
      }
    }
  } catch (err: any) {
    console.warn(`   ⚠️  Erro ao buscar contexto Stripe de ${customerId}: ${err.message}`);
  }

  return ctx;
}

async function createBillingPortalUrl(customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: RETURN_URL,
    });
    return session.url;
  } catch (err: any) {
    console.warn(`   ⚠️  Erro ao criar Billing Portal de ${customerId}: ${err.message}`);
    return null;
  }
}

function toCsvCell(value: any): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatBRL(cents: number) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

async function main() {
  const mode = stripeKey.startsWith('sk_live') ? 'LIVE' : 'TEST';
  console.log(`\n🔎 Buscando assinaturas com falha de pagamento (Stripe ${mode})\n`);

  // Critério: PAST_DUE (ainda em recuperação) OU CANCELED recente com retry > 0
  // (canceladas por falha de pagamento, não por escolha do usuário)
  const recentCutoff = new Date(Date.now() - RECENT_CANCEL_DAYS * 24 * 60 * 60 * 1000);

  const subscriptions = await prisma.subscription.findMany({
    where: {
      OR: [
        { status: 'PAST_DUE' },
        {
          status: 'CANCELED',
          paymentRetryCount: { gt: 0 },
          updatedAt: { gte: recentCutoff },
        },
      ],
      paymentProvider: 'stripe',
    },
    include: {
      user: true,
      plan: true,
    },
    orderBy: { updatedAt: 'desc' },
  });

  console.log(`📋 Encontradas ${subscriptions.length} assinaturas com falha de pagamento`);
  console.log(`   (PAST_DUE atual OR CANCELED nos últimos ${RECENT_CANCEL_DAYS} dias com retry > 0)\n`);

  if (subscriptions.length === 0) {
    console.log('✅ Nenhuma assinatura para recuperar. Boa!');
    return;
  }

  const leads: RecoveryLead[] = [];
  let processed = 0;

  for (const sub of subscriptions) {
    processed++;
    process.stdout.write(`\r   Processando ${processed}/${subscriptions.length}...`);

    const ctx = await getStripeContext(sub.user.stripeCustomerId, sub.externalSubscriptionId);
    const decline = humanizeDecline(ctx.declineCode, ctx.failureMessage);

    const portalUrl = WITH_PORTAL_URLS
      ? await createBillingPortalUrl(sub.user.stripeCustomerId)
      : null;

    const daysSinceFailure = Math.floor(
      (Date.now() - new Date(sub.updatedAt).getTime()) / (1000 * 60 * 60 * 24),
    );

    leads.push({
      userId: sub.userId,
      subscriptionId: sub.id,
      email: sub.user.email,
      name: sub.user.name,
      phone: sub.user.phone,
      planSlug: sub.plan.slug,
      planName: sub.plan.name,
      planPriceCents: sub.plan.priceCents,
      subscriptionStatus: sub.status,
      paymentRetryCount: sub.paymentRetryCount,
      currentPeriodEnd: sub.currentPeriodEnd,
      daysSinceFailure,
      stripeCustomerId: sub.user.stripeCustomerId,
      stripeSubscriptionId: sub.externalSubscriptionId,
      declineCode: decline.code,
      declineLabel: decline.label,
      declineStrategy: decline.strategy,
      cardBrand: ctx.cardBrand,
      cardLast4: ctx.cardLast4,
      cardExpMonth: ctx.cardExpMonth,
      cardExpYear: ctx.cardExpYear,
      lastInvoiceId: ctx.lastInvoiceId,
      lastInvoiceHostedUrl: ctx.lastInvoiceHostedUrl,
      billingPortalUrl: portalUrl,
      utmSource: sub.user.utmSource,
      utmCampaign: sub.user.utmCampaign,
    });
  }

  console.log('\n');

  // ─────────── RESUMO ───────────
  const totalMrrLost = leads.reduce((sum, l) => sum + l.planPriceCents, 0);

  const byStatus = leads.reduce<Record<string, number>>((acc, l) => {
    acc[l.subscriptionStatus] = (acc[l.subscriptionStatus] || 0) + 1;
    return acc;
  }, {});

  const byPlan = leads.reduce<Record<string, { count: number; mrr: number }>>((acc, l) => {
    if (!acc[l.planName]) acc[l.planName] = { count: 0, mrr: 0 };
    acc[l.planName].count++;
    acc[l.planName].mrr += l.planPriceCents;
    return acc;
  }, {});

  const byDecline = leads.reduce<Record<string, number>>((acc, l) => {
    acc[l.declineLabel] = (acc[l.declineLabel] || 0) + 1;
    return acc;
  }, {});

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`💰 MRR PERDIDO TOTAL:  ${formatBRL(totalMrrLost)}`);
  console.log(`📊 Recuperação esperada (40% benchmark): ${formatBRL(totalMrrLost * 0.4)}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('📂 Por status:');
  for (const [status, count] of Object.entries(byStatus)) {
    console.log(`   ${status.padEnd(12)} ${count}`);
  }

  console.log('\n📂 Por plano:');
  for (const [plan, { count, mrr }] of Object.entries(byPlan).sort((a, b) => b[1].mrr - a[1].mrr)) {
    console.log(`   ${plan.padEnd(12)} ${String(count).padEnd(3)}  ${formatBRL(mrr)}`);
  }

  console.log('\n📂 Por motivo de falha:');
  for (const [reason, count] of Object.entries(byDecline).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(count).padEnd(3)}  ${reason}`);
  }

  // ─────────── EXPORT CSV ───────────
  if (EXPORT_CSV) {
    const outDir = path.resolve(__dirname, 'output');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const today = new Date().toISOString().slice(0, 10);
    const filename = `recovery-campaign-${today}${WITH_PORTAL_URLS ? '-with-portals' : ''}.csv`;
    const filepath = path.join(outDir, filename);

    const headers = [
      'user_id',
      'subscription_id',
      'email',
      'name',
      'phone',
      'plan_slug',
      'plan_name',
      'plan_price_brl',
      'subscription_status',
      'payment_retry_count',
      'days_since_failure',
      'decline_code',
      'decline_label',
      'decline_strategy',
      'card_brand',
      'card_last4',
      'card_exp',
      'last_invoice_url',
      'billing_portal_url',
      'stripe_customer_id',
      'stripe_subscription_id',
      'utm_source',
      'utm_campaign',
    ];

    const rows = leads.map((l) =>
      [
        l.userId,
        l.subscriptionId,
        l.email,
        l.name,
        l.phone,
        l.planSlug,
        l.planName,
        (l.planPriceCents / 100).toFixed(2),
        l.subscriptionStatus,
        l.paymentRetryCount,
        l.daysSinceFailure,
        l.declineCode,
        l.declineLabel,
        l.declineStrategy,
        l.cardBrand,
        l.cardLast4,
        l.cardExpMonth && l.cardExpYear ? `${String(l.cardExpMonth).padStart(2, '0')}/${l.cardExpYear}` : '',
        l.lastInvoiceHostedUrl,
        l.billingPortalUrl,
        l.stripeCustomerId,
        l.stripeSubscriptionId,
        l.utmSource,
        l.utmCampaign,
      ]
        .map(toCsvCell)
        .join(','),
    );

    const csv = [headers.join(','), ...rows].join('\n');
    fs.writeFileSync(filepath, csv, 'utf-8');

    console.log(`\n📄 CSV exportado: ${filepath}`);
    console.log(`   ${leads.length} leads · ${headers.length} colunas`);

    if (WITH_PORTAL_URLS) {
      console.log(`\n⚠️  Billing Portal URLs expiram em 24h. Dispare a campanha hoje.`);
    } else {
      console.log(`\nℹ️  CSV sem Billing Portal URLs. Use --with-portal-urls quando for disparar.`);
      console.log(`   Alternativa: enviar link genérico ${FRONTEND_URL}/perfil — usuário cria a sessão ao clicar.`);
    }
  } else {
    console.log('\nℹ️  Dry-run. Use --export para gerar o CSV.');
  }

  // ─────────── SUGESTÃO DE PRÓXIMO PASSO ───────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('🚀 Próximo passo: disparar campanha de 3 emails (D+0, D+3, D+7)');
  console.log('   Recomendado: dividir CSV em 2 segmentos baseados em decline_code:');
  console.log('   1. "Soft" (insufficient_funds, processing_error) → tom mais leve');
  console.log('   2. "Hard" (expired/declined/lost) → CTA forte pra trocar cartão');
  console.log('═══════════════════════════════════════════════════════════\n');
}

main()
  .catch((e) => {
    console.error('\n❌ Erro:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
