/**
 * Templates da campanha de recuperação de churn involuntário.
 * 3 emails: D+0 (alerta), D+3 (lembrete + prova social), D+7 (última chance + cupom).
 *
 * Segue o padrão visual de email.service.ts:
 *   - background: #f9f9f9
 *   - card: #ffffff, border-radius 8px, max-width 480px
 *   - CTA primário: bg #1a1a1a, texto branco
 *   - texto: #1a1a1a (heading), #666 (corpo)
 *   - tabelas role="presentation" para compatibilidade
 */

export interface RecoveryLead {
  name: string;
  planName: string;
  planPriceBRL: string;
  daysSinceFailure: number;
  declineCode: string;
  declineLabel: string;
  cardBrand: string | null;
  cardLast4: string | null;
  billingPortalUrl: string | null;
  lastInvoiceUrl: string | null;
}

export interface BrandConfig {
  // logoUrl removido propositalmente — emails com imagem caem em spam mais facilmente.
  // Usamos wordmark em texto puro no header.
  frontendUrl: string;
  supportEmail: string;
  recoveryCouponCode?: string; // ex: RECOVERY20 (Email 3)
  recoveryCouponDiscount?: string; // ex: 20% (Email 3)
  bonusCredits?: number; // ex: 2000 — créditos grátis no Email 1 (reativando na semana)
  socialProof?: SocialProof; // Email 2 — números reais do banco
}

export interface SocialProof {
  imagesThisWeek: number;
  videosThisWeek: number;
  creatorsActiveThisWeek: number;
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

function firstName(fullName: string) {
  return (fullName || '').trim().split(/\s+/)[0] || 'tudo bem';
}

function cardLabel(brand: string | null, last4: string | null) {
  if (!brand || !last4) return 'seu cartão';
  const brandMap: Record<string, string> = {
    visa: 'Visa',
    mastercard: 'Mastercard',
    amex: 'Amex',
    elo: 'Elo',
    hipercard: 'Hipercard',
    discover: 'Discover',
  };
  return `seu ${brandMap[brand.toLowerCase()] || brand} final ${last4}`;
}

function ctaUrl(lead: RecoveryLead, brand: BrandConfig, utm: string) {
  const base = lead.billingPortalUrl || `${brand.frontendUrl}/perfil`;
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}utm_source=email&utm_medium=recovery&utm_campaign=${utm}`;
}

// Wordmark em texto puro — sem imagens (melhor deliverability)
function wordmark() {
  return `<div style="margin-bottom: 32px;">
    <span style="font-size: 20px; font-weight: 800; color: #1a1a1a; letter-spacing: 2px;">THEAIMODELAB</span>
  </div>`;
}

function shell(opts: {
  brand: BrandConfig;
  previewText: string;
  body: string;
  footerNote?: string;
}) {
  const { brand, previewText, body, footerNote } = opts;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f9f9f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <div style="display: none; max-height: 0; overflow: hidden; mso-hide: all; font-size: 0; line-height: 0; color: #f9f9f9;">${previewText}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f9f9f9; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden;">
          <tr>
            <td style="padding: 48px 40px;">
              ${wordmark()}
              ${body}
            </td>
          </tr>
          ${
            footerNote
              ? `<tr>
            <td style="padding: 0 40px 40px;">
              <hr style="border: none; border-top: 1px solid #eee; margin: 0 0 24px;">
              <p style="margin: 0; font-size: 13px; color: #999; line-height: 1.5;">${footerNote}</p>
            </td>
          </tr>`
              : ''
          }
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function ctaButton(href: string, label: string) {
  return `<div style="margin: 0 0 28px;">
    <a href="${href}" style="display: inline-block; background-color: #1a1a1a; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-size: 15px; font-weight: 600;">${label}</a>
  </div>`;
}

// Frase inicial adaptada ao motivo da falha
function declineIntro(decline: string, card: string): string {
  switch (decline) {
    case 'insufficient_funds':
      return `tentamos cobrar sua assinatura, mas ${card} não tinha saldo disponível no momento da cobrança.`;
    case 'expired_card':
      return `${card.charAt(0).toUpperCase() + card.slice(1)} expirou e precisa ser atualizado para continuar usando sua assinatura.`;
    case 'card_declined':
    case 'do_not_honor':
    case 'generic_decline':
      return `${card.charAt(0).toUpperCase() + card.slice(1)} foi recusado pelo banco emissor. Não é nada com a gente — pode ser bloqueio temporário ou regra anti-fraude do seu banco.`;
    case 'incorrect_cvc':
      return `o CVC informado no cadastro de ${card} não bateu. Precisamos atualizar os dados.`;
    case 'lost_card':
    case 'stolen_card':
      return `${card.charAt(0).toUpperCase() + card.slice(1)} foi reportado como perdido/bloqueado. Você precisa cadastrar um cartão novo.`;
    case 'authentication_required':
      return `a cobrança de ${card} precisa de autenticação 3D Secure do seu banco. Clica no botão e o Stripe te leva direto pra concluir.`;
    case 'processing_error':
      return `tivemos um erro temporário ao processar ${card}. Pode ter sido instabilidade do banco — só precisa confirmar que está tudo certo.`;
    default:
      return `tentamos cobrar sua assinatura, mas a cobrança em ${card} não foi autorizada.`;
  }
}

// ─────────────────────────────────────────
// EMAIL 1 — D+0  "Tivemos um problema com seu cartão"
// ─────────────────────────────────────────

export function buildEmail1(lead: RecoveryLead, brand: BrandConfig) {
  const fname = firstName(lead.name);
  const card = cardLabel(lead.cardBrand, lead.cardLast4);
  const cta = ctaUrl(lead, brand, 'recovery_d0');
  const intro = declineIntro(lead.declineCode, card);

  const subject = `${fname}, tivemos um problema com seu cartão`;
  const previewText = brand.bonusCredits
    ? `Reativando essa semana, te damos +${brand.bonusCredits.toLocaleString('pt-BR')} créditos grátis.`
    : `Sua assinatura ${lead.planName} ficou em risco — 2 minutos resolve.`;

  const bonusBlock = brand.bonusCredits
    ? `
    <div style="margin: 0 0 28px; padding: 18px 20px; background-color: #f5f5f5; border-left: 3px solid #1a1a1a; border-radius: 4px;">
      <p style="margin: 0 0 4px; font-size: 13px; color: #999; text-transform: uppercase; letter-spacing: 1px; font-weight: 600;">Pra recuperar o tempo perdido</p>
      <p style="margin: 0; font-size: 15px; color: #1a1a1a; line-height: 1.5;">Reativando essa semana, <strong>te damos +${brand.bonusCredits.toLocaleString('pt-BR')} créditos grátis</strong> que entram automaticamente na sua conta assim que o pagamento for confirmado.</p>
    </div>`
    : '';

  const body = `
    <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #1a1a1a; line-height: 1.3;">Tivemos um problema com seu cartão</h1>
    <p style="margin: 0 0 20px; font-size: 15px; color: #666; line-height: 1.6;">Oi ${fname}, ${intro}</p>
    <p style="margin: 0 0 20px; font-size: 15px; color: #666; line-height: 1.6;">Sua assinatura <strong style="color: #1a1a1a;">${lead.planName}</strong> (${lead.planPriceBRL}/mês) está pausada até a gente conseguir cobrar de novo. Suas influencers, conteúdos gerados e configurações continuam todos salvos.</p>
    ${bonusBlock}
    <p style="margin: 0 0 28px; font-size: 15px; color: #666; line-height: 1.6;"><strong style="color: #1a1a1a;">Como resolver:</strong> clica no botão abaixo, atualiza o cartão (ou tenta outro), e volta a usar a AI Model Lab normalmente. Leva menos de 1 minuto.</p>
    ${ctaButton(cta, 'Atualizar pagamento agora')}
    <p style="margin: 0; font-size: 13px; color: #999; line-height: 1.6;">Se foi engano e o cartão já tem saldo, pode ignorar este email — vamos tentar cobrar de novo automaticamente nos próximos dias.</p>
  `;

  const footerNote = `Qualquer dúvida, é só responder este email. A gente lê tudo.`;

  return {
    subject,
    html: shell({ brand, previewText, body, footerNote }),
  };
}

// ─────────────────────────────────────────
// EMAIL 2 — D+3  "Seus créditos estão te esperando"
// ─────────────────────────────────────────

export function buildEmail2(lead: RecoveryLead, brand: BrandConfig) {
  const fname = firstName(lead.name);
  const cta = ctaUrl(lead, brand, 'recovery_d3');
  const sp = brand.socialProof;

  const subject = `${fname}, seu acesso e seus créditos estão esperando`;
  const previewText = sp
    ? `${sp.creatorsActiveThisWeek.toLocaleString('pt-BR')} criadores geraram conteúdo essa semana. Volta com a gente?`
    : `Já faz ${lead.daysSinceFailure} dias. Reativa em 1 clique.`;

  const socialProofBlock = sp
    ? `
    <div style="margin: 0 0 28px; padding: 20px; background-color: #f5f5f5; border-radius: 8px;">
      <p style="margin: 0 0 14px; font-size: 13px; color: #999; text-transform: uppercase; letter-spacing: 1px; font-weight: 600;">Enquanto você ficou fora · últimos 7 dias</p>
      <p style="margin: 0 0 10px; font-size: 15px; color: #1a1a1a; line-height: 1.6;">▸ <strong>${sp.creatorsActiveThisWeek.toLocaleString('pt-BR')} criadores</strong> ativos na plataforma</p>
      <p style="margin: 0 0 10px; font-size: 15px; color: #1a1a1a; line-height: 1.6;">▸ <strong>${sp.imagesThisWeek.toLocaleString('pt-BR')} imagens</strong> geradas</p>
      <p style="margin: 0; font-size: 15px; color: #1a1a1a; line-height: 1.6;">▸ <strong>${sp.videosThisWeek.toLocaleString('pt-BR')} vídeos</strong> criados</p>
    </div>`
    : `
    <div style="margin: 0 0 28px; padding: 20px; background-color: #f5f5f5; border-radius: 8px;">
      <p style="margin: 0 0 12px; font-size: 13px; color: #999; text-transform: uppercase; letter-spacing: 1px; font-weight: 600;">Enquanto você ficou fora</p>
      <p style="margin: 0 0 8px; font-size: 15px; color: #1a1a1a; line-height: 1.6;">▸ Outros criadores geraram milhares de vídeos e imagens</p>
      <p style="margin: 0; font-size: 15px; color: #1a1a1a; line-height: 1.6;">▸ Seus créditos do <strong>${lead.planName}</strong> continuam intactos te esperando</p>
    </div>`;

  const body = `
    <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #1a1a1a; line-height: 1.3;">Te esperando aqui, ${fname}</h1>
    <p style="margin: 0 0 20px; font-size: 15px; color: #666; line-height: 1.6;">Faz alguns dias que sua assinatura <strong style="color: #1a1a1a;">${lead.planName}</strong> ficou em pausa por causa de um problema com o cartão. Quis dar um toque porque seus créditos, influencers e galeria continuam tudo aqui, prontos pra serem usados.</p>

    ${socialProofBlock}

    <p style="margin: 0 0 28px; font-size: 15px; color: #666; line-height: 1.6;">A boa notícia: reativar é 1 clique. Cadastra um cartão novo (ou tenta o atual) e volta exatamente de onde parou — seus <strong style="color: #1a1a1a;">${lead.planName}</strong> intactos.</p>

    ${ctaButton(cta, `Voltar pro plano ${lead.planName}`)}

    <p style="margin: 0; font-size: 13px; color: #999; line-height: 1.6;">Se já não faz sentido pra você agora, sem problema — só responde esse email contando o motivo, ajuda muito a gente melhorar.</p>
  `;

  return {
    subject,
    html: shell({ brand, previewText, body }),
  };
}

// ─────────────────────────────────────────
// EMAIL 3 — D+7  "Última chance + cupom"
// ─────────────────────────────────────────

export function buildEmail3(lead: RecoveryLead, brand: BrandConfig) {
  const fname = firstName(lead.name);
  const cta = ctaUrl(lead, brand, 'recovery_d7');
  const hasCoupon = !!(brand.recoveryCouponCode && brand.recoveryCouponDiscount);

  const subject = hasCoupon
    ? `Última chamada, ${fname} — ${brand.recoveryCouponDiscount} OFF no seu primeiro mês`
    : `${fname}, sua conta vai para o plano gratuito em breve`;

  const previewText = hasCoupon
    ? `Cupom ${brand.recoveryCouponCode} expira em 48h. Depois disso, paramos de incomodar.`
    : `Suas influencers e galeria continuam salvas — pode voltar quando quiser.`;

  const couponBlock = hasCoupon
    ? `
    <div style="margin: 0 0 28px; padding: 24px; background-color: #1a1a1a; border-radius: 8px; text-align: center;">
      <p style="margin: 0 0 8px; font-size: 13px; color: #999; text-transform: uppercase; letter-spacing: 1px; font-weight: 600;">Seu cupom de retorno</p>
      <p style="margin: 0 0 12px; font-family: 'SF Mono', Monaco, monospace; font-size: 28px; font-weight: 700; color: #ffffff; letter-spacing: 2px;">${brand.recoveryCouponCode}</p>
      <p style="margin: 0; font-size: 14px; color: #cccccc;">${brand.recoveryCouponDiscount} de desconto no seu próximo mês · Expira em 48h</p>
    </div>`
    : '';

  const body = `
    <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #1a1a1a; line-height: 1.3;">${
      hasCoupon ? `Última chance, ${fname}` : `Última atualização, ${fname}`
    }</h1>
    <p style="margin: 0 0 20px; font-size: 15px; color: #666; line-height: 1.6;">É a última vez que escrevo sobre sua assinatura ${lead.planName}. Faz ${lead.daysSinceFailure} dias que ficou em pausa, e em breve sua conta vai voltar pro plano gratuito (suas criações continuam salvas, viu, fica tranquilo).</p>
    ${
      hasCoupon
        ? `<p style="margin: 0 0 20px; font-size: 15px; color: #666; line-height: 1.6;">Antes de a gente fechar essa porta, separei um cupom único pra você reativar com desconto:</p>`
        : ''
    }
    ${couponBlock}
    <p style="margin: 0 0 28px; font-size: 15px; color: #666; line-height: 1.6;">Se quiser voltar, é só clicar abaixo${
      hasCoupon ? ' e aplicar o cupom no checkout' : ''
    }. Se não fizer mais sentido, tudo bem também — não vou te incomodar mais.</p>

    ${ctaButton(cta, hasCoupon ? `Reativar com ${brand.recoveryCouponDiscount} OFF` : 'Reativar minha assinatura')}

    <p style="margin: 0; font-size: 13px; color: #999; line-height: 1.6;">Obrigado por ter testado a AI Model Lab. Se decidir não voltar, adoraria saber o motivo — é só responder esse email.</p>
  `;

  const footerNote = `Esse é o último email da sequência de recuperação. Você não vai receber mais mensagens sobre essa assinatura.`;

  return {
    subject,
    html: shell({ brand, previewText, body, footerNote }),
  };
}

// ─────────────────────────────────────────
// DISPATCHER
// ─────────────────────────────────────────

export type EmailNumber = 1 | 2 | 3;

export function buildRecoveryEmail(n: EmailNumber, lead: RecoveryLead, brand: BrandConfig) {
  if (n === 1) return buildEmail1(lead, brand);
  if (n === 2) return buildEmail2(lead, brand);
  return buildEmail3(lead, brand);
}
