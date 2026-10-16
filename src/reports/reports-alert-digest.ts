import { ContentReportCategory } from '@prisma/client';

/**
 * Por que a denúncia é urgente (prazo de 24 h):
 * - `category`: categoria urgente (menor de idade, imagem íntima sem consentimento);
 * - `depicted_person`: a própria pessoa retratada denunciando imagem íntima sem consentimento ou uso da imagem dela;
 * - `cites_minor`: descrição ou alvo que cita menor (a mesma guarda das gerações), qualquer que seja a categoria.
 */
export type UrgentReason = 'category' | 'depicted_person' | 'cites_minor';
export const URGENT_REASONS: readonly UrgentReason[] = ['category', 'depicted_person', 'cites_minor'];

/** Denúncia como entra no resumo (sem e-mail de quem denunciou: o resumo é curto, o contato fica no admin). */
export interface DigestReport {
  id: string;
  category: ContentReportCategory;
  target: string;
  description: string;
  createdAt: Date;
  reasons: readonly UrgentReason[];
}

/** Denúncias listadas uma a uma no resumo; as demais entram só na contagem (a lista inteira está no admin). */
export const DIGEST_LIST_MAX = 100;
const TARGET_MAX = 200;
const DESCRIPTION_MAX = 300;

const CATEGORY_LABEL: Record<ContentReportCategory, string> = {
  [ContentReportCategory.MINOR]: 'menor de idade',
  [ContentReportCategory.NON_CONSENSUAL]: 'imagem íntima sem consentimento',
  [ContentReportCategory.IMPERSONATION]: 'uso de imagem',
  [ContentReportCategory.COPYRIGHT]: 'direito autoral',
  [ContentReportCategory.ILLEGAL]: 'conteúdo ilegal',
  [ContentReportCategory.OTHER]: 'outro motivo',
};

const REASON_LABEL: Record<UrgentReason, string> = {
  category: 'categoria urgente',
  depicted_person: 'a própria pessoa retratada',
  cites_minor: 'o texto cita menor',
};

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Envolve menor de idade (pela categoria ou pelo texto): vai para o topo do resumo. */
const involvesMinor = (report: DigestReport): boolean =>
  report.category === ContentReportCategory.MINOR || report.reasons.includes('cites_minor');

/** Endereço do admin (REPORTS_ADMIN_URL): só http(s); qualquer outra coisa não vira link. */
function adminBase(adminUrl: string | null): URL | null {
  if (!adminUrl?.trim()) return null;
  try {
    const url = new URL(adminUrl.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** Link do admin para a denúncia (?report=<id>). */
function reportLink(base: URL | null, id: string): string | null {
  if (!base) return null;
  const url = new URL(base.toString());
  url.searchParams.set('report', id);
  return url.toString();
}

/**
 * Resumo das denúncias urgentes que não tiveram aviso avulso (teto de avisos da hora, ou o mesmo cliente mandando
 * várias seguidas): um e-mail só, com id, categoria, motivo, data, conteúdo e o link do admin de cada uma. Menor de
 * idade primeiro, depois as mais antigas. O conteúdo denunciado vai como texto (nunca como link clicável: é texto
 * de quem denunciou). Puro, testável.
 */
export function buildUrgentDigest(
  reports: readonly DigestReport[],
  opts: { adminUrl: string | null; waiting?: number },
): { subject: string; html: string } {
  const base = adminBase(opts.adminUrl);
  const total = reports.length;
  const ordered = [...reports].sort(
    (a, b) => Number(involvesMinor(b)) - Number(involvesMinor(a)) || a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const listed = ordered.slice(0, DIGEST_LIST_MAX);
  const minors = reports.filter(involvesMinor).length;
  const headline = total === 1 ? '1 nova denúncia urgente' : `${total} novas denúncias urgentes`;
  const subject = `[DENÚNCIAS URGENTES] ${headline}${minors ? ` (${minors} com menor de idade)` : ''} — The AI Model Lab`;

  const rows = listed
    .map((report) => {
      const link = reportLink(base, report.id);
      const id = link ? `<a href="${escapeHtml(link)}">${escapeHtml(report.id)}</a>` : escapeHtml(report.id);
      const reasons = report.reasons.length ? report.reasons.map((reason) => REASON_LABEL[reason]).join(', ') : 'urgente na gravação';
      return `<tr>
        <td style="padding:6px 8px;border-top:1px solid #ddd;vertical-align:top"><b>${escapeHtml(CATEGORY_LABEL[report.category] ?? report.category)}</b><br>
          <span style="color:#666">${escapeHtml(reasons)}</span><br>
          <span style="color:#666">${report.createdAt.toISOString()}</span><br>${id}</td>
        <td style="padding:6px 8px;border-top:1px solid #ddd;vertical-align:top"><b>Conteúdo:</b> ${escapeHtml(clip(report.target, TARGET_MAX))}<br>
          <b>Relato:</b> ${escapeHtml(clip(report.description, DESCRIPTION_MAX)).replace(/\r?\n/g, '<br>')}</td>
      </tr>`;
    })
    .join('');

  const notes: string[] = [];
  if (total > listed.length) notes.push(`Mais ${total - listed.length} denúncia(s) urgente(s) neste resumo não cabem na lista: veja todas no admin.`);
  if (opts.waiting && opts.waiting > 0) notes.push(`Outras ${opts.waiting} seguem na fila para o próximo resumo.`);
  const open = base
    ? `<p><a href="${escapeHtml(base.toString())}">Abrir a fila de denúncias</a></p>`
    : '<p style="color:#666">Fila completa: admin da plataforma (GET /api/v1/admin/reports) ou Denúncias no cockpit.</p>';

  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">
    <h2 style="margin:0 0 8px">${escapeHtml(headline)}</h2>
    <p>O teto de avisos avulsos da hora foi atingido, ou o mesmo cliente mandou várias denúncias seguidas: estas vieram juntas neste resumo. Toda denúncia está gravada no admin.</p>
    ${open}
    <table style="border-collapse:collapse;width:100%">${rows}</table>
    ${notes.map((note) => `<p style="color:#666">${escapeHtml(note)}</p>`).join('')}
    <p style="color:#666">Menor ou imagem íntima sem consentimento: retirar do ar em até 24 h, preservar a evidência e, se envolver menor, comunicar às autoridades.</p>
  </div>`;
  return { subject, html };
}
