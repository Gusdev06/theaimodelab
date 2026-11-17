export const UNLIMITED_REDIS = 'UNLIMITED_REDIS';

export const UNLIMITED_LOCK_KEY_PREFIX = 'unlimited:lock:';
export const UNLIMITED_MANUAL_DELAY_KEY_PREFIX = 'unlimited:manual-delay:';

// TTL do lock por usuário. Alinhar com lockDuration do BullMQ (15min — suporta vídeos longos).
// 45 min = janela de vídeo do cron de presas: com retry (30 s) e modelo
// alternativo, um job passa de 15 min e o lock vencia no meio (TKT-111). O lock
// é liberado no fim do job; o TTL é só a rede de segurança.
export const UNLIMITED_LOCK_TTL_SECONDS = 45 * 60;

// Janela móvel de 24h para contar gerações no modo ilimitado.
export const UNLIMITED_WINDOW_HOURS = 24;

// Bloqueia novas gerações quando usuário atinge esse total de gerações ilimitadas em 24h.
export const UNLIMITED_HARD_CAP = 40;

/**
 * Uso justo da IMAGEM ilimitada (16/11/2026, regra prejuízo zero do dono): orçamento diário por plano, em
 * "imagens NB2 1K". Conta do pior caso por mês = mensalidade − Perfect Pay (10% + US$ 1,50) − imposto 6% − todos
 * os créditos do plano gastos no modelo mais caro; o que sobra paga a imagem ilimitada (NB2 1K ~US$ 0,054,
 * NBP 1K ~US$ 0,082): Advanced sobra ~US$ 12 → 7/dia; Studio ~US$ 13,6 → 8/dia; Agency ~US$ 36 → 22/dia.
 * Plano fora da lista (só vídeo Veo) segue no teto antigo de 40/24 h. Anual e avulso de 30 dias usam o do mensal.
 */
export const UNLIMITED_DAILY_BUDGET: Record<string, number> = {
  advanced: 7,
  studio: 8,
  agency: 22,
};

/** Peso de cada geração ilimitada no orçamento diário (NB2 1K = 1). Modelo não listado pesa 1. */
export const UNLIMITED_MODEL_WEIGHT: Record<string, Partial<Record<string, number>>> = {
  NB2: { RES_1K: 1, RES_2K: 1.5 },
  NBP: { RES_1K: 1.5 },
};

export interface CooldownTier {
  maxCount: number;
  delayMs: number;
}

// Cooldown silencioso aplicado como delay no BullMQ. Buscar a primeira tier
// cujo maxCount > usageCount → retorna delayMs correspondente. Se usageCount
// >= UNLIMITED_HARD_CAP, o pedido é bloqueado antes do enfileiramento.
export const UNLIMITED_COOLDOWN_TIERS: CooldownTier[] = [
  { maxCount: 7, delayMs: 0 },        // 0-6: imediato
  { maxCount: 13, delayMs: 80_000 },  // 7-12: 80s
  { maxCount: 16, delayMs: 180_000 }, // 13-15: 180s
  { maxCount: 40, delayMs: 400_000 }, // 16-39: 400s
];
