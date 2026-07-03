/**
 * Parser único da URL do Redis usado tanto pelo BullModule quanto pelo
 * Redis client direto (UnlimitedService). Extrai host, port, password,
 * username e — importante — o **db index** do path da URL (ex: `/1`).
 *
 * Aceita também a env var `REDIS_DB` como override numérico (vence o path).
 *
 * Exemplos:
 *   redis://host:6379       → db 0
 *   redis://host:6379/1     → db 1
 *   redis://host:6379/2 + REDIS_DB=5 → db 5
 */
export interface ParsedRedisConfig {
  host: string;
  port: number;
  password?: string;
  username?: string;
  db: number;
}

export function parseRedisConfig(
  url: string,
  dbOverride?: string | number | null,
): ParsedRedisConfig {
  const parsed = new URL(url);

  const port = parseInt(parsed.port, 10) || 6379;
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  const username =
    parsed.username && parsed.username !== 'default'
      ? decodeURIComponent(parsed.username)
      : undefined;

  // Path = "/1" → db 1. Path vazio ou "/" → db 0.
  const pathDb = parsed.pathname.replace(/^\//, '');
  const fromPath = pathDb ? parseInt(pathDb, 10) : 0;

  const override =
    dbOverride !== null && dbOverride !== undefined && dbOverride !== ''
      ? Number(dbOverride)
      : null;

  const db = override !== null && !Number.isNaN(override) ? override : fromPath;

  return {
    host: parsed.hostname,
    port,
    password,
    username,
    db: Number.isFinite(db) && db >= 0 ? db : 0,
  };
}
