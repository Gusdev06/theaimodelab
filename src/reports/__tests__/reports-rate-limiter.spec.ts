import { HttpStatus } from '@nestjs/common';
import {
  REPORTS_ALERT_EMAILS,
  REPORTS_CONTACT_EMAIL,
  REPORTS_GLOBAL,
  REPORTS_GLOBAL_BOT,
  REPORTS_GLOBAL_PRIORITY,
  REPORTS_PER_CLIENT,
  ReportsRateLimitedException,
  ReportsRateLimiter,
} from '../reports-rate-limiter';

function limiterAt(start = Date.UTC(2026, 9, 16, 12)) {
  let now = start;
  const limiter = new ReportsRateLimiter(() => now);
  return { limiter, advance: (ms: number) => (now += ms) };
}

function rejection(fn: () => void): ReportsRateLimitedException {
  try {
    fn();
  } catch (error) {
    if (error instanceof ReportsRateLimitedException) return error;
    throw error;
  }
  throw new Error('esperava 429');
}

/** IP inventado diferente a cada pedido (cabeçalho forjado por quem chama o VPS direto) */
const forged = (i: number) => `10.${Math.floor(i / 62_500) % 250}.${Math.floor(i / 250) % 250}.${i % 250}`;

describe('ReportsRateLimiter', () => {
  it('os limites são os combinados: 5 por 10 min por cliente; por hora, 5.000 urgentes, 120 comuns, 120 iscas e 30 avisos avulsos', () => {
    expect(REPORTS_PER_CLIENT).toEqual({ limit: 5, windowMs: 600_000 });
    expect(REPORTS_GLOBAL).toEqual({ limit: 120, windowMs: 3_600_000 });
    expect(REPORTS_GLOBAL_PRIORITY).toEqual({ limit: 5_000, windowMs: 3_600_000 });
    expect(REPORTS_GLOBAL_BOT).toEqual({ limit: 120, windowMs: 3_600_000 });
    expect(REPORTS_ALERT_EMAILS).toEqual({ limit: 30, windowMs: 3_600_000 });
  });

  it('5 denúncias por cliente a cada 10 minutos; a 6ª é 429 REPORTS_RATE_LIMITED', () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 5; i++) limiter.consume('203.0.113.9', 'standard');
    const error = rejection(() => limiter.consume('203.0.113.9', 'standard'));
    expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(error.getResponse()).toEqual({ code: 'REPORTS_RATE_LIMITED', message: expect.any(String) });
  });

  it('o limite por cliente de humano soma urgentes e comuns; a urgente acima dele passa marcada, a comum é 429', () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 3; i++) expect(limiter.consume('203.0.113.9', 'standard')).toEqual({ overClientLimit: false });
    for (let i = 0; i < 2; i++) expect(limiter.consume('203.0.113.9', 'priority')).toEqual({ overClientLimit: false });
    expect(limiter.consume('203.0.113.9', 'priority')).toEqual({ overClientLimit: true });
    expect(() => limiter.consume('203.0.113.9', 'standard')).toThrow(ReportsRateLimitedException);
  });

  it('a urgente acima do limite conta: quem insiste segue marcado e só sai da marca quando a janela esvazia', () => {
    const { limiter, advance } = limiterAt();
    for (let i = 0; i < 5; i++) limiter.consume('a', 'priority');
    advance(5 * 60_000);
    for (let i = 0; i < 3; i++) expect(limiter.consume('a', 'priority')).toEqual({ overClientLimit: true });
    // passaram 10 min das 5 primeiras: na janela ficaram as 3 marcadas (menos que 5)
    advance(5 * 60_000);
    expect(limiter.consume('a', 'priority')).toEqual({ overClientLimit: false });
  });

  it('um cliente no limite não atrapalha outro', () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 5; i++) limiter.consume('203.0.113.9', 'standard');
    expect(() => limiter.consume('203.0.113.9', 'standard')).toThrow(ReportsRateLimitedException);
    expect(() => limiter.consume('198.51.100.20', 'standard')).not.toThrow();
  });

  it('a janela é deslizante: libera de novo 10 minutos depois da 1ª', () => {
    const { limiter, advance } = limiterAt();
    limiter.consume('a', 'standard');
    advance(60_000);
    for (let i = 0; i < 4; i++) limiter.consume('a', 'standard');
    advance(9 * 60_000 - 1);
    expect(() => limiter.consume('a', 'standard')).toThrow(ReportsRateLimitedException);
    advance(1);
    expect(() => limiter.consume('a', 'standard')).not.toThrow();
    expect(() => limiter.consume('a', 'standard')).toThrow(ReportsRateLimitedException);
  });

  it('recusa não conta: quem insiste não fica preso por mais tempo', () => {
    const { limiter, advance } = limiterAt();
    for (let i = 0; i < 5; i++) limiter.consume('a', 'standard');
    for (let i = 0; i < 20; i++) expect(() => limiter.consume('a', 'standard')).toThrow(ReportsRateLimitedException);
    advance(10 * 60_000);
    expect(() => limiter.consume('a', 'standard')).not.toThrow();
  });

  it('teto global de 120 comuns por hora, mesmo com um IP diferente (forjado) a cada pedido', () => {
    const { limiter, advance } = limiterAt();
    for (let i = 0; i < 120; i++) limiter.consume(forged(i), 'standard');
    const error = rejection(() => limiter.consume('192.0.2.1', 'standard'));
    expect(error.getResponse()).toMatchObject({ code: 'REPORTS_RATE_LIMITED' });
    advance(60 * 60_000);
    expect(() => limiter.consume('192.0.2.1', 'standard')).not.toThrow();
  });

  it('enxurrada de denúncias comuns não cala as urgentes; 600 urgentes forjadas também não (o teto é 5.000, só o do banco)', () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 120; i++) limiter.consume(forged(i), 'standard');
    expect(() => limiter.consume('192.0.2.1', 'standard')).toThrow(ReportsRateLimitedException);
    expect(() => limiter.consume('192.0.2.1', 'priority')).not.toThrow();
    for (let i = 1; i < 600; i++) limiter.consume(forged(10_000 + i), 'priority');
    expect(() => limiter.consume('192.0.2.2', 'priority')).not.toThrow();
    for (let i = 601; i < 5_000; i++) limiter.consume(forged(20_000 + i), 'priority');
    const error = rejection(() => limiter.consume('192.0.2.3', 'priority'));
    // a recusa da faixa urgente indica a denúncia por e-mail
    expect(error.getResponse()).toEqual({ code: 'REPORTS_RATE_LIMITED', message: expect.stringContaining(REPORTS_CONTACT_EMAIL) });
  });

  it('avisos avulsos por e-mail: 30 por hora, janela deslizante', () => {
    const { limiter, advance } = limiterAt();
    for (let i = 0; i < 30; i++) {
      expect(limiter.takeAlertSlot()).toBe(true);
      advance(60_000);
    }
    expect(limiter.takeAlertSlot()).toBe(false);
    // 1 h depois do 1º aviso, libera um
    advance(30 * 60_000 + 1);
    expect(limiter.takeAlertSlot()).toBe(true);
    expect(limiter.takeAlertSlot()).toBe(false);
  });

  it('isca de robô tem janelas próprias: nunca gasta o limite de humano (nem por cliente, nem global)', () => {
    const { limiter } = limiterAt();
    // enxurrada de robô com IP inventado esgota só o teto da isca
    for (let i = 0; i < 120; i++) limiter.consume(forged(i), 'bot');
    expect(() => limiter.consume('192.0.2.1', 'bot')).toThrow(ReportsRateLimitedException);
    for (let i = 0; i < 5; i++) limiter.consume(forged(500 + i), 'standard');
    limiter.consume('192.0.2.9', 'priority');
    // o mesmo IP com 5 iscas não perde a vez de denunciar de verdade
    const { limiter: other } = limiterAt();
    for (let i = 0; i < 5; i++) other.consume('203.0.113.9', 'bot');
    expect(() => other.consume('203.0.113.9', 'bot')).toThrow(ReportsRateLimitedException);
    for (let i = 0; i < 5; i++) expect(() => other.consume('203.0.113.9', 'priority')).not.toThrow();
  });

  it('enxurrada recusada com IPs inventados não cresce a memória', () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 120; i++) limiter.consume(`c-${i}`, 'standard');
    for (let i = 0; i < 5_000; i++) expect(() => limiter.consume(`forjado-${i}`, 'standard')).toThrow(ReportsRateLimitedException);
    expect(limiter.trackedClients).toBeLessThanOrEqual(120);
  });

  it('clientes sem atividade na janela saem da memória (humano e robô)', () => {
    const { limiter, advance } = limiterAt();
    for (let i = 0; i < 50; i++) limiter.consume(`c-${i}`, 'standard');
    for (let i = 0; i < 20; i++) limiter.consume(`b-${i}`, 'bot');
    expect(limiter.trackedClients).toBe(70);
    advance(10 * 60_000 + 1);
    limiter.consume('novo', 'priority');
    expect(limiter.trackedClients).toBe(1);
  });

  it('sem IP: todos dividem a mesma janela; chave longa é cortada', () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 3; i++) limiter.consume(null, 'standard');
    for (let i = 0; i < 2; i++) limiter.consume('  ', 'priority');
    expect(() => limiter.consume(undefined, 'standard')).toThrow(ReportsRateLimitedException);
    const long = 'x'.repeat(64);
    for (let i = 0; i < 5; i++) limiter.consume(`${long}-${i}`, 'standard');
    expect(() => limiter.consume(`${long}-qualquer`, 'standard')).toThrow(ReportsRateLimitedException);
  });
});
