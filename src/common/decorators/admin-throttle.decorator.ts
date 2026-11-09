import { Throttle } from '@nestjs/throttler';

/**
 * Limite próprio das rotas de admin: 300 requisições por minuto por usuário e por rota.
 *
 * O throttler global (30/min) foi pensado para o cliente final; o painel do admin carrega várias telas em
 * paralelo e tomava 429. Continua havendo limite (não usar SkipThrottle): um token admin vazado não vira
 * raspagem ilimitada da base.
 */
export const ADMIN_THROTTLE_LIMIT = 300;
export const ADMIN_THROTTLE_TTL_MS = 60_000;

export const AdminThrottle = () =>
  Throttle({ default: { ttl: ADMIN_THROTTLE_TTL_MS, limit: ADMIN_THROTTLE_LIMIT } });
