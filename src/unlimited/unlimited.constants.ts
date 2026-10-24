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
