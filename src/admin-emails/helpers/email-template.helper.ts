/**
 * Embrulha o HTML do corpo no template visual padrão do AI Model Lab.
 * Mesmo estilo dos outros emails transacionais (welcome, password reset, etc).
 */
export function wrapInBroadcastTemplate(innerHtml: string, logoUrl: string): string {
  const logoHtml = logoUrl
    ? `<div style="margin-bottom: 32px;"><img src="${logoUrl}" alt="The AI Model Lab" width="80" height="80" style="display: block; border-radius: 12px;"></div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f9f9f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f9f9f9; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; max-width: 520px;">
          <tr>
            <td style="padding: 48px 40px;">
              ${logoHtml}
              ${innerHtml}
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 40px; background-color: #fafafa; text-align: center; font-size: 12px; color: #999; border-top: 1px solid #eee; line-height: 1.5;">
              <p style="margin: 0;">The AI Model Lab · Plataforma de criação com IA</p>
              <p style="margin: 4px 0 0;">Você está recebendo este email porque é cliente da plataforma.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
