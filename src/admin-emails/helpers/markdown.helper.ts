import { marked } from 'marked';

const INLINE_STYLES: Record<string, string> = {
  h1: 'margin: 0 0 18px; font-size: 26px; font-weight: 700; color: #1a1a1a; line-height: 1.3;',
  h2: 'margin: 28px 0 14px; font-size: 20px; font-weight: 700; color: #1a1a1a; line-height: 1.3;',
  h3: 'margin: 22px 0 10px; font-size: 17px; font-weight: 700; color: #1a1a1a; line-height: 1.3;',
  p: 'margin: 0 0 16px; font-size: 15px; color: #444; line-height: 1.65;',
  ul: 'margin: 0 0 16px; padding-left: 22px; font-size: 15px; color: #444; line-height: 1.65;',
  ol: 'margin: 0 0 16px; padding-left: 22px; font-size: 15px; color: #444; line-height: 1.65;',
  li: 'margin: 0 0 6px;',
  a: 'color: #1a1a1a; text-decoration: underline; font-weight: 500;',
  strong: 'color: #1a1a1a; font-weight: 600;',
  em: 'font-style: italic;',
  blockquote:
    'margin: 0 0 16px; padding: 12px 16px; border-left: 3px solid #1a1a1a; background: #f5f5f5; color: #555; font-size: 15px; line-height: 1.6;',
  hr: 'margin: 28px 0; border: none; border-top: 1px solid #eee;',
  img: 'max-width: 100%; height: auto; border-radius: 6px; display: block;',
  code: 'background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-family: SFMono-Regular, Consolas, Menlo, monospace; font-size: 13px; color: #1a1a1a;',
  pre: 'margin: 0 0 16px; padding: 16px; background: #f3f4f6; border-radius: 6px; overflow-x: auto; font-family: SFMono-Regular, Consolas, Menlo, monospace; font-size: 13px; color: #1a1a1a;',
  table: 'border-collapse: collapse; width: 100%; margin: 0 0 16px;',
  th: 'border: 1px solid #e5e7eb; padding: 8px 12px; background: #f9fafb; text-align: left; font-size: 14px; color: #1a1a1a;',
  td: 'border: 1px solid #e5e7eb; padding: 8px 12px; font-size: 14px; color: #444;',
};

/**
 * Converte markdown em HTML pronto pra email — aplica inline styles em todas as
 * tags pra funcionar nos clientes que ignoram CSS externo (Gmail, Outlook).
 */
export async function renderMarkdownToEmailHtml(markdown: string): Promise<string> {
  const rawHtml = await marked.parse(markdown, { async: true, breaks: true, gfm: true });
  return applyInlineStyles(rawHtml as string);
}

function applyInlineStyles(html: string): string {
  let out = html;
  for (const [tag, style] of Object.entries(INLINE_STYLES)) {
    const openTagRegex = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi');
    out = out.replace(openTagRegex, (_match, rawAttrs?: string) => {
      const attrs = rawAttrs ?? '';
      if (/style\s*=\s*"/.test(attrs)) {
        const merged = attrs.replace(
          /style\s*=\s*"([^"]*)"/i,
          (_m, existing: string) => `style="${style} ${existing}"`,
        );
        return `<${tag}${merged}>`;
      }
      return `<${tag}${attrs} style="${style}">`;
    });
  }
  return out;
}
