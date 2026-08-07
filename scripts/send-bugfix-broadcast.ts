/**
 * BROADCAST — CORREÇÃO DOS BUGS DE COBRANÇA DE CRÉDITOS (2026-08-03)
 *
 * Envia um comunicado a TODOS os usuários ativos informando a correção dos
 * dois bugs de cobrança (gerações gratuitas debitando créditos + modo
 * ilimitado desligando sozinho). Conteúdo segmentado por locale do usuário
 * (pt* → PT, es* → ES, resto → EN), no template visual padrão dos broadcasts.
 *
 * Mantém log em scripts/output/bugfix-broadcast-sent-log.json pra não enviar
 * 2x pro mesmo email.
 *
 * Uso:
 *   # Preview (não envia; salva HTMLs em scripts/output/) — sempre rode primeiro
 *   npx ts-node scripts/send-bugfix-broadcast.ts --dry-run
 *
 *   # Envia só um teste para um email arbitrário (não precisa estar no DB)
 *   npx ts-node scripts/send-bugfix-broadcast.ts --test=voce@email.com
 *
 *   # Disparo real para todos os usuários ativos
 *   npx ts-node scripts/send-bugfix-broadcast.ts --send
 *
 * Env vars (puxa do .env): RESEND_API_KEY, RESEND_FROM_EMAIL,
 * FRONTEND_URL (default https://theaimodelab.com), LOGO_URL (opcional).
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { Resend } from 'resend';
import { PrismaClient } from '@prisma/client';
import { wrapInBroadcastTemplate } from '../src/admin-emails/helpers/email-template.helper';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
const prisma = new PrismaClient();

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : undefined;
};

const SEND = args.includes('--send');
const TEST_EMAIL = getArg('test');
const DRY_RUN = !SEND && !TEST_EMAIL;
const FORCE = args.includes('--force');
const BATCH_SIZE = 90; // Resend batch aceita até 100
const LOG_PATH = path.resolve(__dirname, 'output', 'bugfix-broadcast-sent-log.json');

const RESEND_API_KEY = process.env.RESEND_API_KEY!;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL!;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://theaimodelab.com';
const LOGO_URL = process.env.LOGO_URL || '';

if (!RESEND_API_KEY || !FROM_EMAIL) {
  console.error('❌ RESEND_API_KEY e RESEND_FROM_EMAIL precisam estar no .env');
  process.exit(1);
}

// ─────────────────────────────────────────
// CONTEÚDO POR IDIOMA
// ─────────────────────────────────────────
type Lang = 'pt' | 'es' | 'en';

const SUBJECTS: Record<Lang, string> = {
  pt: 'Corrigimos uma falha na cobrança de créditos',
  es: 'Corregimos un error en el cobro de créditos',
  en: 'We fixed a credits billing issue',
};

function bodyHtml(lang: Lang, firstName: string): string {
  const p = (t: string) =>
    `<p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #333;">${t}</p>`;
  const li = (t: string) =>
    `<li style="margin: 0 0 10px; font-size: 15px; line-height: 1.6; color: #333;">${t}</li>`;
  const h = (t: string) =>
    `<h1 style="margin: 0 0 20px; font-size: 20px; line-height: 1.35; color: #111;">${t}</h1>`;

  if (lang === 'pt') {
    return [
      h(`Olá, ${firstName}!`),
      p('Identificamos e corrigimos duas falhas na plataforma que podiam consumir seus créditos indevidamente:'),
      `<ul style="margin: 0 0 16px; padding-left: 20px;">`,
      li('<strong>Gerações gratuitas:</strong> em alguns modelos de vídeo e ferramentas (Motion Control, Grok Imagine, Gemini Omni, Kling e outros), gerar usando uma geração gratuita podia descontar créditos mesmo aparecendo como "Grátis".'),
      li('<strong>Modo ilimitado:</strong> ao recarregar a página, o modo ilimitado podia desligar sozinho sem aviso — e a geração seguinte consumia créditos.'),
      `</ul>`,
      p('As duas falhas <strong>já estão corrigidas</strong>.'),
      p('Se você acredita que perdeu créditos ou gerações gratuitas por causa disso, é só <strong>responder este email</strong>: vamos verificar seu histórico e devolver o que foi cobrado indevidamente.'),
      p('Obrigado pela confiança!<br>— Equipe The AI Model Lab'),
    ].join('\n');
  }

  if (lang === 'es') {
    return [
      h(`¡Hola, ${firstName}!`),
      p('Identificamos y corregimos dos errores en la plataforma que podían consumir tus créditos indebidamente:'),
      `<ul style="margin: 0 0 16px; padding-left: 20px;">`,
      li('<strong>Generaciones gratuitas:</strong> en algunos modelos de video y herramientas (Motion Control, Grok Imagine, Gemini Omni, Kling y otros), generar usando una generación gratuita podía descontar créditos aunque apareciera como "Gratis".'),
      li('<strong>Modo ilimitado:</strong> al recargar la página, el modo ilimitado podía desactivarse solo sin aviso — y la siguiente generación consumía créditos.'),
      `</ul>`,
      p('Ambos errores <strong>ya están corregidos</strong>.'),
      p('Si crees que perdiste créditos o generaciones gratuitas por esto, simplemente <strong>responde a este email</strong>: revisaremos tu historial y te devolveremos lo que se cobró indebidamente.'),
      p('¡Gracias por tu confianza!<br>— Equipo The AI Model Lab'),
    ].join('\n');
  }

  return [
    h(`Hi ${firstName}!`),
    p('We identified and fixed two issues on the platform that could wrongly consume your credits:'),
    `<ul style="margin: 0 0 16px; padding-left: 20px;">`,
    li('<strong>Free generations:</strong> on some video models and tools (Motion Control, Grok Imagine, Gemini Omni, Kling and others), generating with a free generation could deduct credits even when shown as "Free".'),
    li('<strong>Unlimited mode:</strong> after reloading the page, unlimited mode could silently turn itself off — and the next generation consumed credits.'),
    `</ul>`,
    p('Both issues are <strong>now fixed</strong>.'),
    p("If you believe you lost credits or free generations because of this, just <strong>reply to this email</strong>: we'll review your history and refund anything wrongly charged."),
    p('Thanks for your trust!<br>— The AI Model Lab Team'),
  ].join('\n');
}

function langFor(locale: string | null | undefined): Lang {
  const l = (locale || '').toLowerCase();
  if (l.startsWith('pt')) return 'pt';
  if (l.startsWith('es')) return 'es';
  return 'en';
}

function firstNameOf(name: string | null | undefined, lang: Lang): string {
  const first = (name || '').trim().split(/\s+/)[0];
  if (first) return first;
  return lang === 'pt' ? 'criador(a)' : lang === 'es' ? 'creador(a)' : 'creator';
}

// ─────────────────────────────────────────
// LOG (idempotência)
// ─────────────────────────────────────────
interface SentLog {
  [email: string]: string; // email → ISO date de envio
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
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2), 'utf-8');
}

// ─────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────
async function main() {
  console.log('\n📧 Broadcast — correção dos bugs de cobrança (2026-08-03)\n');
  console.log(`   From: ${FROM_EMAIL}`);
  console.log(`   Modo: ${DRY_RUN ? '🔬 DRY-RUN' : TEST_EMAIL ? `✉️  TESTE → ${TEST_EMAIL}` : '🚀 SEND REAL (todos os usuários ativos)'}\n`);

  if (TEST_EMAIL) {
    const resend = new Resend(RESEND_API_KEY);
    for (const lang of ['pt', 'es', 'en'] as Lang[]) {
      const html = wrapInBroadcastTemplate(bodyHtml(lang, firstNameOf('', lang)), LOGO_URL);
      const { error } = await resend.emails.send({
        from: FROM_EMAIL,
        to: [TEST_EMAIL],
        subject: `[TESTE ${lang.toUpperCase()}] ${SUBJECTS[lang]}`,
        html,
      });
      if (error) {
        console.error(`❌ Falha no teste (${lang}):`, error);
      } else {
        console.log(`✅ Teste ${lang.toUpperCase()} enviado para ${TEST_EMAIL}`);
      }
    }
    return;
  }

  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { email: true, name: true, locale: true },
    orderBy: { createdAt: 'asc' },
  });

  const log = loadLog();
  const recipients = users.filter(
    (u) => u.email && (FORCE || !log[u.email.toLowerCase()]),
  );
  const skipped = users.length - recipients.length;

  const byLang: Record<Lang, number> = { pt: 0, es: 0, en: 0 };
  for (const u of recipients) byLang[langFor(u.locale)]++;

  console.log(`📋 ${users.length} usuários ativos no banco`);
  if (skipped) console.log(`⏭️  ${skipped} pulados (já receberam — log local)`);
  console.log(`✅ ${recipients.length} a enviar → PT: ${byLang.pt} · ES: ${byLang.es} · EN: ${byLang.en}\n`);

  if (DRY_RUN) {
    for (const lang of ['pt', 'es', 'en'] as Lang[]) {
      const html = wrapInBroadcastTemplate(bodyHtml(lang, firstNameOf('Gustavo Gomes', lang)), LOGO_URL);
      const previewPath = path.resolve(__dirname, 'output', `preview-bugfix-${lang}.html`);
      fs.mkdirSync(path.dirname(previewPath), { recursive: true });
      fs.writeFileSync(previewPath, html, 'utf-8');
      console.log(`📄 Preview ${lang.toUpperCase()}: ${previewPath}`);
      console.log(`   Subject: ${SUBJECTS[lang]}`);
    }
    console.log('\nℹ️  Dry-run completo. Use --test=seu@email.com pra receber, ou --send pra disparar.');
    return;
  }

  // ─────── ENVIO REAL ───────
  const resend = new Resend(RESEND_API_KEY);
  const sentNow = new Date().toISOString();
  let sentCount = 0;
  let errorCount = 0;
  const errors: { email: string; error: string }[] = [];

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    const payload = batch.map((u) => {
      const lang = langFor(u.locale);
      return {
        from: FROM_EMAIL,
        to: [u.email],
        subject: SUBJECTS[lang],
        html: wrapInBroadcastTemplate(bodyHtml(lang, firstNameOf(u.name, lang)), LOGO_URL),
      };
    });

    process.stdout.write(`   Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(recipients.length / BATCH_SIZE)} (${batch.length} emails)... `);
    try {
      const { data, error } = await resend.batch.send(payload);
      if (error) {
        console.log('❌');
        console.error('   Resend batch error:', error);
        errorCount += batch.length;
        batch.forEach((u) => errors.push({ email: u.email, error: JSON.stringify(error) }));
        continue;
      }
      console.log(`✅ ${data?.data?.length ?? batch.length} enfileirados`);
      sentCount += batch.length;
      batch.forEach((u) => (log[u.email.toLowerCase()] = sentNow));
      saveLog(log);
    } catch (err: any) {
      console.log('❌');
      console.error('   Exception:', err.message);
      errorCount += batch.length;
      batch.forEach((u) => errors.push({ email: u.email, error: err.message }));
    }

    if (i + BATCH_SIZE < recipients.length) {
      await new Promise((r) => setTimeout(r, 1100));
    }
  }

  console.log('\n═══════════════════════════════════════');
  console.log(`✅ Enviados: ${sentCount}`);
  if (errorCount > 0) console.log(`❌ Falhas:   ${errorCount}`);
  console.log(`📁 Log: ${LOG_PATH}`);
  if (errors.length > 0) {
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
