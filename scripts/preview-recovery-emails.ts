/**
 * Renderiza os 3 templates da campanha de recuperação em HTML standalone
 * com dados fictícios pra você revisar visualmente antes de disparar.
 *
 * Uso:
 *   npx ts-node scripts/preview-recovery-emails.ts
 *
 * Gera: scripts/output/preview-recovery-emails.html
 *   (abre no navegador: open scripts/output/preview-recovery-emails.html)
 */
import * as path from 'path';
import * as fs from 'fs';
import {
  buildRecoveryEmail,
  type RecoveryLead,
  type BrandConfig,
} from '../src/payments/recovery/recovery-templates';

// ─────────────────────────────────────────
// DADOS DE EXEMPLO
// ─────────────────────────────────────────

const sampleLead: RecoveryLead = {
  name: 'Maria Silva',
  planName: 'Creator',
  planPriceBRL: 'R$ 89,90',
  daysSinceFailure: 3, // sobrescrito por email
  declineCode: 'insufficient_funds', // sobrescrito por exemplo
  declineLabel: 'Sem saldo no cartão',
  cardBrand: 'visa',
  cardLast4: '4242',
  billingPortalUrl: 'https://billing.stripe.com/p/session/test_12345',
  lastInvoiceUrl: null,
};

const brand: BrandConfig = {
  frontendUrl: 'https://theaimodelab.ai',
  supportEmail: 'ola@theaimodelab.ai',
  recoveryCouponCode: 'RECOVERY20',
  recoveryCouponDiscount: '20%',
  bonusCredits: 2000,
  socialProof: {
    creatorsActiveThisWeek: 847,
    imagesThisWeek: 12_430,
    videosThisWeek: 3_281,
  },
};

// ─────────────────────────────────────────
// EXEMPLOS DE MOTIVO DE FALHA (pra Email 1)
// ─────────────────────────────────────────

const declineExamples = [
  { code: 'insufficient_funds', label: 'Sem saldo' },
  { code: 'expired_card', label: 'Cartão expirado' },
  { code: 'card_declined', label: 'Recusado pelo banco' },
];

// ─────────────────────────────────────────
// RENDERIZAÇÃO
// ─────────────────────────────────────────

function renderSection(title: string, subject: string, html: string) {
  return `
  <section style="margin-bottom: 60px;">
    <div style="background: #1a1a1a; color: white; padding: 16px 24px; border-radius: 8px 8px 0 0;">
      <p style="margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: 2px; opacity: 0.6;">${title}</p>
      <p style="margin: 4px 0 0; font-size: 16px; font-weight: 600;">Subject: ${subject}</p>
    </div>
    <div style="border: 1px solid #ddd; border-top: none; border-radius: 0 0 8px 8px; overflow: hidden;">
      ${html}
    </div>
  </section>`;
}

function main() {
  const sections: string[] = [];

  // ──── Email 1 — 3 variações por motivo de falha ────
  sections.push(`<h2 style="font-family: sans-serif; margin: 40px 0 16px; color: #1a1a1a;">📧 EMAIL 1 — Dia 0 (3 variações por motivo)</h2>`);
  for (const ex of declineExamples) {
    const lead = { ...sampleLead, daysSinceFailure: 0, declineCode: ex.code, declineLabel: ex.label };
    const email = buildRecoveryEmail(1, lead, brand);
    sections.push(renderSection(`Email 1 · ${ex.label}`, email.subject, email.html));
  }

  // ──── Email 2 ────
  sections.push(`<h2 style="font-family: sans-serif; margin: 40px 0 16px; color: #1a1a1a;">📧 EMAIL 2 — Dia 3 (prova social com números reais)</h2>`);
  const lead2 = { ...sampleLead, daysSinceFailure: 3 };
  const email2 = buildRecoveryEmail(2, lead2, brand);
  sections.push(renderSection('Email 2 · Prova social', email2.subject, email2.html));

  // ──── Email 3 — com e sem cupom ────
  sections.push(`<h2 style="font-family: sans-serif; margin: 40px 0 16px; color: #1a1a1a;">📧 EMAIL 3 — Dia 7 (última chamada)</h2>`);

  const lead3 = { ...sampleLead, daysSinceFailure: 7 };
  const email3WithCoupon = buildRecoveryEmail(3, lead3, brand);
  sections.push(renderSection('Email 3 · COM cupom 20% OFF', email3WithCoupon.subject, email3WithCoupon.html));

  const brandNoCoupon = { ...brand, recoveryCouponCode: undefined, recoveryCouponDiscount: undefined };
  const email3NoCoupon = buildRecoveryEmail(3, lead3, brandNoCoupon);
  sections.push(renderSection('Email 3 · SEM cupom (fallback)', email3NoCoupon.subject, email3NoCoupon.html));

  const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Preview · Campanha de Recuperação AI Model Lab</title>
</head>
<body style="margin: 0; padding: 40px; background: #fafafa; font-family: -apple-system, sans-serif;">
  <header style="max-width: 720px; margin: 0 auto 32px; padding-bottom: 24px; border-bottom: 1px solid #ddd;">
    <h1 style="margin: 0 0 8px; font-size: 28px; color: #1a1a1a;">🔁 Preview · Campanha de Recuperação</h1>
    <p style="margin: 0; color: #666; font-size: 14px;">Dados de exemplo: Maria Silva · Plano Creator (R$ 89,90) · Visa final 4242</p>
    <p style="margin: 8px 0 0; color: #666; font-size: 14px;">Bônus: +2.000 créditos grátis · Cupom: <code>RECOVERY20</code> (20% OFF) · Prova social: 847 criadores / 12.430 imagens / 3.281 vídeos</p>
  </header>
  <main style="max-width: 720px; margin: 0 auto;">
    ${sections.join('\n')}
  </main>
  <footer style="max-width: 720px; margin: 60px auto 0; padding-top: 24px; border-top: 1px solid #ddd; text-align: center; color: #999; font-size: 13px;">
    Os números reais de prova social (Email 2) virão do banco no momento do envio via cron.
  </footer>
</body>
</html>`;

  const outDir = path.resolve(__dirname, 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'preview-recovery-emails.html');
  fs.writeFileSync(outPath, fullHtml, 'utf-8');

  console.log(`✅ Preview gerado: ${outPath}`);
  console.log(`   Abre no navegador: open ${outPath}`);
}

main();
