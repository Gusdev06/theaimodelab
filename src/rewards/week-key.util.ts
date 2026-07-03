const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;

function toBrt(date: Date): Date {
  return new Date(date.getTime() - BRT_OFFSET_MS);
}

function fromBrt(brt: Date): Date {
  return new Date(brt.getTime() + BRT_OFFSET_MS);
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatYmd(brt: Date): string {
  return `${brt.getUTCFullYear()}-${pad(brt.getUTCMonth() + 1)}-${pad(brt.getUTCDate())}`;
}

/**
 * Returns the ISO date (YYYY-MM-DD) of the Wednesday of the current Mon-Sun week
 * in America/Sao_Paulo (BRT, UTC-3, no DST). Used as the unique key per week.
 */
export function currentWeekWednesdayKey(now: Date = new Date()): string {
  const brt = toBrt(now);
  const day = brt.getUTCDay(); // 0=Sun, 1=Mon ... 6=Sat
  const offset = day === 0 ? -4 : 3 - day;
  const wed = new Date(brt);
  wed.setUTCDate(brt.getUTCDate() + offset);
  wed.setUTCHours(0, 0, 0, 0);
  return formatYmd(wed);
}

/**
 * True if "now" falls on Wednesday in BRT (00:00:00 to 23:59:59.999).
 */
export function isWednesdayInBrt(now: Date = new Date()): boolean {
  return toBrt(now).getUTCDay() === 3;
}

/**
 * UTC instant when the current claim window opens (most recent Wednesday 00:00 BRT).
 */
export function currentWindowOpensAt(now: Date = new Date()): Date {
  const brt = toBrt(now);
  const day = brt.getUTCDay();
  const offset = day === 0 ? -4 : 3 - day;
  const wed = new Date(brt);
  wed.setUTCDate(brt.getUTCDate() + offset);
  wed.setUTCHours(0, 0, 0, 0);
  return fromBrt(wed);
}

/**
 * UTC instant when the current/next claim window closes (Wednesday 23:59:59.999 BRT).
 */
export function currentWindowClosesAt(now: Date = new Date()): Date {
  const open = currentWindowOpensAt(now);
  return new Date(open.getTime() + 24 * 60 * 60 * 1000 - 1);
}

/**
 * UTC instant of the next Wednesday 00:00 BRT strictly in the future.
 * - If today is Mon/Tue: returns this week's Wednesday.
 * - If today is Wed: returns next Wednesday (+7 days), since today's window is the current one, not the "next".
 * - If today is Thu..Sun: returns next week's Wednesday.
 */
export function nextWindowOpensAt(now: Date = new Date()): Date {
  const brt = toBrt(now);
  const day = brt.getUTCDay(); // 0=Sun..6=Sat
  const offset = day === 3 ? 7 : (3 - day + 7) % 7;
  const wed = new Date(brt);
  wed.setUTCDate(brt.getUTCDate() + offset);
  wed.setUTCHours(0, 0, 0, 0);
  return fromBrt(wed);
}
