/**
 * Mia Chatter (L20 do clone das mecânicas de venda da Candy e das líderes, 24/11/2026).
 *
 * Molde: operador de AI OFM na Fanvue com US$ 7.490 de US$ 12 mil vindos do chat (62%) e 65% de fechamento de PPV;
 * 1ª oferta abaixo de US$ 15 vende ~4× mais (ESTUDO-RANKING-QUEM-FATURA-18-2026-11-23.md §1 e §3, selo ⚠️ vendedor).
 * A Fanvue tem API oficial de chat com OAuth (escopos read:chat e write:chat).
 *
 * Tudo atrás de MIA_CHATTER_ENABLED (default off): desligado, nenhuma rota responde, o cron não toca no banco e o
 * webhook da Perfect Pay segue idêntico. As URLs da Fanvue moram em env para trocar sem deploy se a API mudar.
 */

/** Só o que a leitura precisa: ConfigService.get ou process.env servem. */
export type EnvReader = (key: string) => string | undefined;

export interface MiaChatterConfig {
  enabled: boolean;
  fanvue: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    authUrl: string;
    tokenUrl: string;
    apiBase: string;
    apiVersion: string;
    scopes: string;
    /** como o token endpoint recebe o segredo: basic (cabeçalho) ou post (corpo) */
    tokenAuth: 'basic' | 'post';
    /** a Fanvue cobra o PPV em centavos de dólar; `usd` se a API passar a pedir dólar inteiro */
    priceUnit: 'cents' | 'usd';
  };
  /** chave AES-256 (32 bytes, base64 ou hex) que cifra os tokens de cada cliente */
  tokenKey: string;
  /** para onde o OAuth devolve a cliente (aba PPV da modelo) */
  returnUrl: string;
  llm: {
    /** OpenRouter, nunca Claude: a política da Anthropic proíbe gerar texto sexual explícito */
    apiKey: string;
    models: string[];
    /** teto de gasto do modelo de texto por cliente por mês (conta do prejuízo zero: US$ 15,50) */
    capUsdPerMonth: number;
    /** preço por milhão de tokens para estimar quando o OpenRouter não devolve o custo (Grok 4: 3 entrada, 15 saída) */
    priceInPerMTok: number;
    priceOutPerMTok: number;
    maxTokens: number;
    timeoutMs: number;
  };
  /** códigos da Perfect Pay (plano do postback e/ou do link) que ativam a assinatura de US$ 39/mês */
  ppPlanCodes: string[];
  /** fã que passou deste gasto vira baleia: a cliente é avisada e a Mia passa a conversa para ela */
  whaleUsd: number;
  /** dias de acesso por cobrança (a PP renova todo mês) */
  paidDays: number;
  /** quantas respostas no máximo por conta a cada rodada do cron (ritmo humano e custo previsível) */
  maxRepliesPerRun: number;
}

export const MIA_CHATTER_DEFAULT_MODELS = 'x-ai/grok-4.3';

const ON_VALUES = new Set(['on', 'true', '1', 'yes']);

export function isMiaChatterEnabled(read: EnvReader): boolean {
  return ON_VALUES.has((read('MIA_CHATTER_ENABLED') ?? '').trim().toLowerCase());
}

function text(read: EnvReader, key: string, fallback = ''): string {
  const value = read(key)?.trim();
  return value ? value : fallback;
}

function positiveNumber(read: EnvReader, key: string, fallback: number): number {
  const raw = Number(read(key));
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function list(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function readMiaChatterConfig(read: EnvReader): MiaChatterConfig {
  const frontend = text(read, 'FRONTEND_URL', 'https://www.theaimodelab.com').replace(/\/+$/, '');
  return {
    enabled: isMiaChatterEnabled(read),
    fanvue: {
      clientId: text(read, 'FANVUE_CLIENT_ID'),
      clientSecret: text(read, 'FANVUE_CLIENT_SECRET'),
      redirectUri: text(read, 'FANVUE_REDIRECT_URI'),
      authUrl: text(read, 'FANVUE_AUTH_URL', 'https://auth.fanvue.com/oauth2/auth'),
      tokenUrl: text(read, 'FANVUE_TOKEN_URL', 'https://auth.fanvue.com/oauth2/token'),
      apiBase: text(read, 'FANVUE_API_BASE', 'https://api.fanvue.com').replace(/\/+$/, ''),
      apiVersion: text(read, 'FANVUE_API_VERSION', '2025-06-26'),
      scopes: text(read, 'FANVUE_SCOPES', 'openid offline_access offline read:self read:chat write:chat'),
      tokenAuth: text(read, 'FANVUE_TOKEN_AUTH', 'basic').toLowerCase() === 'post' ? 'post' : 'basic',
      priceUnit: text(read, 'FANVUE_PRICE_UNIT', 'cents').toLowerCase() === 'usd' ? 'usd' : 'cents',
    },
    tokenKey: text(read, 'MIA_CHATTER_TOKEN_KEY'),
    returnUrl: text(read, 'MIA_CHATTER_RETURN_URL', `${frontend}/x`),
    llm: {
      apiKey: text(read, 'OPENROUTER_API_KEY'),
      models: list(text(read, 'MIA_CHATTER_MODELS', MIA_CHATTER_DEFAULT_MODELS)),
      capUsdPerMonth: positiveNumber(read, 'MIA_CHATTER_LLM_CAP_USD', 15.5),
      priceInPerMTok: positiveNumber(read, 'MIA_CHATTER_PRICE_IN_PER_MTOK', 3),
      priceOutPerMTok: positiveNumber(read, 'MIA_CHATTER_PRICE_OUT_PER_MTOK', 15),
      maxTokens: Math.round(positiveNumber(read, 'MIA_CHATTER_MAX_TOKENS', 220)),
      timeoutMs: Math.round(positiveNumber(read, 'MIA_CHATTER_TIMEOUT_MS', 30_000)),
    },
    ppPlanCodes: list(text(read, 'MIA_CHATTER_PP_PLAN_CODES')).map((code) => code.toUpperCase()),
    whaleUsd: positiveNumber(read, 'MIA_CHATTER_WHALE_USD', 200),
    paidDays: Math.round(positiveNumber(read, 'MIA_CHATTER_PAID_DAYS', 31)),
    maxRepliesPerRun: Math.round(positiveNumber(read, 'MIA_CHATTER_MAX_REPLIES_PER_RUN', 20)),
  };
}

/** O que falta para a cliente conseguir ligar a conta (a tela mostra "em breve" enquanto faltar algo). */
export function missingForConnect(config: MiaChatterConfig): string[] {
  const missing: string[] = [];
  if (!config.fanvue.clientId) missing.push('FANVUE_CLIENT_ID');
  if (!config.fanvue.clientSecret) missing.push('FANVUE_CLIENT_SECRET');
  if (!config.fanvue.redirectUri) missing.push('FANVUE_REDIRECT_URI');
  if (!config.tokenKey) missing.push('MIA_CHATTER_TOKEN_KEY');
  return missing;
}
