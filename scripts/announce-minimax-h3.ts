/**
 * ANÚNCIO — NOVO MODELO MiniMax H3 (broadcast para toda a base)
 *
 * Dispara 1 email de anúncio do modelo MiniMax H3 para TODOS os usuários
 * (isActive + emailVerified), localizado por user.locale (EN / ES / PT-BR).
 *
 * Reusa os mesmos helpers de markdown + template dos broadcasts do painel admin,
 * então o visual é idêntico aos outros emails da plataforma.
 *
 * Mantém log de envios em scripts/output/announce-minimax-h3-sent-log.json
 * pra nunca mandar 2x pro mesmo email (idempotente — pode re-rodar sem medo).
 *
 * ⚠️  DRY-RUN é o padrão. Só envia de verdade com --send.
 *
 * Uso:
 *   # 1) Preview (não envia) — gera HTML dos 3 locales em scripts/output/
 *   npx ts-node scripts/announce-minimax-h3.ts --dry-run
 *
 *   # 2) Teste real mandando só pra você antes de soltar pra base
 *   npx ts-node scripts/announce-minimax-h3.ts --send --only=voce@email.com
 *
 *   # 3) Disparo real pra todos
 *   npx ts-node scripts/announce-minimax-h3.ts --send
 *
 *   # limitar a N destinatários (ex.: soltar em ondas)
 *   npx ts-node scripts/announce-minimax-h3.ts --send --limit=500
 *
 * Env vars (puxa do .env):
 *   RESEND_API_KEY     (obrigatório)
 *   RESEND_FROM_EMAIL  (obrigatório, ex: "The AI Model Lab <ola@theaimodelab.ai>")
 *   FRONTEND_URL       (default: https://theaimodelab.ai)
 *   LOGO_URL           (opcional — mesmo logo dos outros broadcasts)
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { Resend } from 'resend';
import { PrismaClient } from '@prisma/client';
import { renderMarkdownToEmailHtml } from '../src/admin-emails/helpers/markdown.helper';
import { wrapInBroadcastTemplate } from '../src/admin-emails/helpers/email-template.helper';
import { signUnsubscribe } from '../src/email-preferences/unsubscribe-token.util';

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
const DRY_RUN = !args.includes('--send');
const ONLY_EMAIL = getArg('only');
const LIMIT = parseInt(getArg('limit') || '0', 10);
const FORCE = args.includes('--force');
const BATCH_SIZE = 90; // Resend aceita até 100/chamada; 90 por segurança

// ─────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY!;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL!;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://theaimodelab.ai';
const LOGO_URL = process.env.LOGO_URL || '';
// Secret pro token de descadastro — mesmo fallback do EmailPreferencesService.
const UNSUB_SECRET =
  process.env.EMAIL_UNSUBSCRIBE_SECRET ||
  process.env.JWT_ACCESS_SECRET ||
  'insecure-fallback-secret-change-me';
// Same-origin em produção: a API responde em FRONTEND_URL/api/v1/*
const UNSUB_BASE = `${FRONTEND_URL.replace(/\/+$/, '')}/api/v1/email/unsubscribe`;
const SUPPORT_MAILTO = process.env.SUPPORT_EMAIL || 'ola@theaimodelab.com';

function unsubscribeUrl(email: string, locale: EmailLocale): string {
  const t = signUnsubscribe(email, UNSUB_SECRET);
  return `${UNSUB_BASE}?e=${encodeURIComponent(email)}&t=${t}&l=${locale}`;
}

// Rodapé de descadastro localizado (aparece no corpo, acima do rodapé do template)
const UNSUB_COPY: Record<EmailLocale, (url: string) => string> = {
  'pt-BR': (url) =>
    `Não quer mais receber novidades? <a href="${url}">Descadastrar</a>.`,
  es: (url) =>
    `¿No quieres recibir novedades? <a href="${url}">Darse de baja</a>.`,
  en: (url) => `Don't want these updates? <a href="${url}">Unsubscribe</a>.`,
};

// Credenciais só são obrigatórias pro envio real — dry-run funciona sem elas
// (útil pra revisar o HTML e a contagem localmente, onde a chave do Resend não existe).
if (!args.includes('--dry-run-only') && !DRY_RUN && (!RESEND_API_KEY || !FROM_EMAIL)) {
  console.error('❌ RESEND_API_KEY e RESEND_FROM_EMAIL precisam estar no .env para --send');
  process.exit(1);
}

// ─────────────────────────────────────────
// LOCALE
// ─────────────────────────────────────────
type EmailLocale = 'en' | 'es' | 'pt-BR';
function resolveEmailLocale(userLocale: string | null | undefined): EmailLocale {
  const l = (userLocale || '').toLowerCase();
  if (l.startsWith('pt')) return 'pt-BR';
  if (l.startsWith('es')) return 'es';
  return 'en';
}

// ─────────────────────────────────────────
// CONTEÚDO (3 idiomas) — {{firstName}} é substituído por destinatário
// ─────────────────────────────────────────
const CTA = `${FRONTEND_URL}/video`;

const CONTENT: Record<EmailLocale, { subject: string; body: string }> = {
  'pt-BR': {
    subject: '🎬 Novo modelo: MiniMax H3 (com áudio nativo) já está no ar',
    body: `# Chegou o MiniMax H3 🎬

Oi, {{firstName}}!

Acabamos de liberar um novo modelo de vídeo na plataforma: o **MiniMax H3** — com **áudio nativo sempre ligado** e três modos de criação em um só lugar:

- **Texto → Vídeo** — descreva a cena e receba o vídeo com som.
- **Imagem → Vídeo** — dê vida a uma imagem (com frame inicial e final opcional).
- **Referência → Vídeo** — envie imagens/vídeos/áudios de referência pra guiar o resultado.

**Resoluções:** 480p e 768p · **Duração:** 5 a 15 segundos · **Áudio:** incluído.

Ele já aparece no seletor de modelos da página de vídeo. É só escolher o modo e gerar.

[**Criar com o MiniMax H3 →**](${CTA})

Bom proveito,
Equipe The AI Model Lab`,
  },
  es: {
    subject: '🎬 Nuevo modelo: MiniMax H3 (con audio nativo) ya disponible',
    body: `# Llegó el MiniMax H3 🎬

¡Hola, {{firstName}}!

Acabamos de lanzar un nuevo modelo de video en la plataforma: **MiniMax H3** — con **audio nativo siempre activo** y tres modos de creación en un solo lugar:

- **Texto → Video** — describe la escena y recibe el video con sonido.
- **Imagen → Video** — da vida a una imagen (con frame inicial y final opcional).
- **Referencia → Video** — sube imágenes/videos/audios de referencia para guiar el resultado.

**Resoluciones:** 480p y 768p · **Duración:** 5 a 15 segundos · **Audio:** incluido.

Ya aparece en el selector de modelos de la página de video. Solo elige el modo y genera.

[**Crear con MiniMax H3 →**](${CTA})

¡Que lo disfrutes!
Equipo The AI Model Lab`,
  },
  en: {
    subject: '🎬 New model: MiniMax H3 (with native audio) is live',
    body: `# MiniMax H3 is here 🎬

Hey {{firstName}}!

We just added a new video model to the platform: **MiniMax H3** — with **native audio always on** and three creation modes in one place:

- **Text → Video** — describe the scene and get a video with sound.
- **Image → Video** — bring an image to life (with optional first and last frame).
- **Reference → Video** — upload reference images/videos/audio to guide the result.

**Resolutions:** 480p and 768p · **Duration:** 5 to 15 seconds · **Audio:** included.

It's already in the model picker on the video page. Just pick a mode and generate.

[**Create with MiniMax H3 →**](${CTA})

Enjoy,
The AI Model Lab team`,
  },
};

function firstNameOf(name: string | null | undefined): string {
  const n = (name || '').trim();
  if (!n) return CONTENT_DEFAULT_NAME;
  return n.split(/\s+/)[0];
}
const CONTENT_DEFAULT_NAME = 'there';

// ─────────────────────────────────────────
// LOG (idempotência)
// ─────────────────────────────────────────
const LOG_PATH = path.resolve(__dirname, 'output', 'announce-minimax-h3-sent-log.json');
function loadLog(): Record<string, string> {
  if (!fs.existsSync(LOG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(LOG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}
function saveLog(log: Record<string, string>) {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2), 'utf-8');
}

// ─────────────────────────────────────────
// BUILD
// ─────────────────────────────────────────
async function buildEmail(email: string, name: string, locale: EmailLocale) {
  const { subject, body } = CONTENT[locale];
  const first = firstNameOf(name) || (locale === 'pt-BR' ? 'tudo bem' : CONTENT_DEFAULT_NAME);
  const md = body.replace(/\{\{firstName\}\}/g, first);
  const rendered = await renderMarkdownToEmailHtml(md);
  const url = unsubscribeUrl(email, locale);
  const footer = `<p style="margin:24px 0 0;font-size:12px;color:#999;line-height:1.5;">${UNSUB_COPY[locale](url)}</p>`;
  const html = wrapInBroadcastTemplate(rendered + footer, LOGO_URL);
  // List-Unsubscribe: link HTTPS one-click (RFC 8058) + mailto de fallback.
  const headers: Record<string, string> = {
    'List-Unsubscribe': `<${url}>, <mailto:${SUPPORT_MAILTO}?subject=unsubscribe>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
  return { subject, html, headers };
}

// ─────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────
async function main() {
  console.log(`\n📧 Anúncio MiniMax H3 — broadcast\n`);
  console.log(`   From:  ${FROM_EMAIL}`);
  console.log(`   CTA:   ${CTA}`);
  console.log(`   Modo:  ${DRY_RUN ? '🔬 DRY-RUN (não envia)' : '🚀 SEND REAL'}`);
  if (ONLY_EMAIL) console.log(`   Filtro: apenas ${ONLY_EMAIL}`);
  if (LIMIT) console.log(`   Limite: ${LIMIT} destinatários`);
  if (FORCE) console.log(`   Force:  ignorando log de envios anteriores`);
  console.log('');

  const users = await prisma.user.findMany({
    where: { isActive: true, emailVerified: true, marketingOptOut: false },
    select: { email: true, name: true, locale: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`📋 ${users.length} usuários ativos com email verificado\n`);

  const log = loadLog();
  let skippedSent = 0;
  let skippedFilter = 0;

  let recipients = users
    .map((u) => ({
      email: (u.email || '').trim().toLowerCase(),
      name: u.name,
      locale: resolveEmailLocale(u.locale),
    }))
    .filter((r) => {
      if (!r.email) return false;
      if (ONLY_EMAIL && r.email !== ONLY_EMAIL.toLowerCase()) {
        skippedFilter++;
        return false;
      }
      if (!FORCE && log[r.email]) {
        skippedSent++;
        return false;
      }
      return true;
    });

  if (LIMIT > 0) recipients = recipients.slice(0, LIMIT);

  const byLocale = recipients.reduce<Record<string, number>>((acc, r) => {
    acc[r.locale] = (acc[r.locale] || 0) + 1;
    return acc;
  }, {});
  console.log(`✅ ${recipients.length} destinatários`);
  console.log(`   Locales: ${JSON.stringify(byLocale)}`);
  if (skippedSent) console.log(`⏭️  ${skippedSent} pulados (já receberam)`);
  if (skippedFilter) console.log(`⏭️  ${skippedFilter} pulados (filtro --only)`);
  console.log('');

  if (recipients.length === 0) {
    console.log('Nada pra enviar.');
    return;
  }

  // ─────── DRY-RUN: salva preview de cada locale e sai ───────
  if (DRY_RUN) {
    const outDir = path.resolve(__dirname, 'output');
    fs.mkdirSync(outDir, { recursive: true });
    for (const locale of ['pt-BR', 'es', 'en'] as EmailLocale[]) {
      const { subject, html } = await buildEmail('preview@theaimodelab.com', 'Maria Silva', locale);
      const p = path.resolve(outDir, `announce-minimax-h3-${locale}.html`);
      fs.writeFileSync(p, html, 'utf-8');
      console.log(`📄 [${locale}] "${subject}"`);
      console.log(`   → ${p}`);
    }
    console.log(`\nℹ️  Dry-run completo. Abra os HTMLs pra revisar e use --send para enviar.`);
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
    const payload = await Promise.all(
      batch.map(async (r) => {
        const { subject, html, headers } = await buildEmail(r.email, r.name, r.locale);
        return { from: FROM_EMAIL, to: [r.email], subject, html, headers };
      }),
    );

    process.stdout.write(
      `   Batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} emails)... `,
    );

    try {
      const { data, error } = await resend.batch.send(payload);
      if (error) {
        console.log('❌');
        console.error('   Resend batch error:', error);
        errorCount += batch.length;
        batch.forEach((r) => errors.push({ email: r.email, error: JSON.stringify(error) }));
        continue;
      }
      console.log(`✅ ${data?.data?.length ?? batch.length} enfileirados`);
      sentCount += batch.length;
      batch.forEach((r) => {
        log[r.email] = sentNow;
      });
      saveLog(log);
    } catch (err: any) {
      console.log('❌');
      console.error('   Exception:', err.message);
      errorCount += batch.length;
      batch.forEach((r) => errors.push({ email: r.email, error: err.message }));
    }

    // Throttle entre batches (rate limit Resend)
    if (i + BATCH_SIZE < recipients.length) {
      await new Promise((r) => setTimeout(r, 1100));
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`✅ Enviados: ${sentCount}`);
  if (errorCount > 0) console.log(`❌ Falhas:   ${errorCount}`);
  console.log(`📁 Log: ${LOG_PATH}`);
  console.log('═══════════════════════════════════════════════════════════');

  if (errors.length > 0) {
    console.log('\nErros:');
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
