import { loadAccessLogConfig } from '../../../access-log/access-log.config';
import {
  formatReportReason,
  hasStoredMedia,
  matchesPromotedKey,
  parseDateBound,
  parseReportReason,
  percentile,
  reviewerIpOf,
  utcDayKey,
  utcDayStart,
} from '../review.helpers';

describe('review.helpers', () => {
  it('registro da comunicação: formata e lê de volta canal e protocolo', () => {
    const text = formatReportReason('cnca', 'NID-2026/0001', 'comunicado pelo Nidus');
    expect(text).toBe('[canal:cnca][protocolo:NID-2026/0001] comunicado pelo Nidus');
    expect(parseReportReason(text)).toEqual({ channel: 'cnca', protocol: 'NID-2026/0001' });
    expect(parseReportReason(formatReportReason('ncmec', null, 'sem protocolo ainda'))).toEqual({
      channel: 'ncmec',
      protocol: null,
    });
    expect(parseReportReason('texto livre')).toBeNull();
    expect(parseReportReason(null)).toBeNull();
  });

  it('mídia guardada: nunca o marcador do caso leve nem a linha do refinador', () => {
    expect(hasStoredMedia('inputs/g/u/a.png')).toBe(true);
    expect(hasStoredMedia('light:abc123')).toBe(false);
    expect(hasStoredMedia('refiner-output')).toBe(false);
    expect(hasStoredMedia(null)).toBe(false);
    expect(hasStoredMedia('')).toBe(false);
  });

  it('chave promovida: troca só o segmento do uuid (ou acrescenta um na chave curta)', () => {
    expect(matchesPromotedKey('generations/g1/q1/out.png', 'generations/g1/p2/out.png')).toBe(true);
    expect(matchesPromotedKey('generations/g1/q1/out.png', 'generations/g2/p2/out.png')).toBe(false);
    expect(matchesPromotedKey('generations/g1/q1/out.png', 'generations/g1/p2/outro.png')).toBe(false);
    expect(matchesPromotedKey('generations/g1/out.png', 'generations/g1/p2/out.png')).toBe(true);
    expect(matchesPromotedKey('generations/g1/out.png', 'generations/g9/p2/out.png')).toBe(false);
    expect(matchesPromotedKey('generations/g1/q1/out.png', 'generations/g1/q1/out.png')).toBe(true);
  });

  it('percentil pelo vizinho mais próximo; lista vazia = null', () => {
    const sorted = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    expect(percentile(sorted, 50)).toBe(500);
    expect(percentile(sorted, 95)).toBe(1000);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([], 50)).toBeNull();
  });

  it('datas: dia UTC inteiro, ISO completo e inválida', () => {
    expect(parseDateBound('2026-10-22', false)).toEqual(new Date('2026-10-22T00:00:00.000Z'));
    expect(parseDateBound('2026-10-22', true)).toEqual(new Date('2026-10-23T00:00:00.000Z'));
    expect(parseDateBound('2026-10-22T15:00:00Z', true)).toEqual(new Date('2026-10-22T15:00:00Z'));
    expect(parseDateBound(undefined, false)).toBeUndefined();
    expect(parseDateBound('ontem', false)).toBeNull();
    expect(utcDayKey(new Date('2026-10-22T23:59:59Z'))).toBe('2026-10-22');
    expect(utcDayStart(new Date('2026-10-22T23:59:59Z'))).toEqual(new Date('2026-10-22T00:00:00Z'));
  });

  it('IP do revisor: 1º salto do x-forwarded-for, senão o do socket', () => {
    expect(reviewerIpOf({ headers: { 'x-forwarded-for': '198.51.100.4, 10.0.0.1' }, ip: '10.0.0.1' })).toBe(
      '198.51.100.4',
    );
    expect(reviewerIpOf({ headers: {}, ip: '10.0.0.2' })).toBe('10.0.0.2');
    expect(reviewerIpOf({})).toBeNull();
  });

  it('IP do revisor com proxy declarado: só o salto confiável vale (x-forwarded-for forjado não entra na trilha)', () => {
    const { config } = loadAccessLogConfig((key) =>
      key === 'TRUSTED_PROXY_IPS' ? '10.0.0.0/8' : undefined,
    );
    // pelo proxy: o cliente é o salto escrito pelo proxy (o mais à direita), não o que o cliente inventou
    expect(
      reviewerIpOf(
        {
          headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.4' },
          socket: { remoteAddress: '10.0.0.1' },
        },
        config,
      ),
    ).toBe('198.51.100.4');
    // direto na API (socket fora da lista): o cabeçalho é ignorado, vale o socket
    expect(
      reviewerIpOf(
        {
          headers: { 'x-forwarded-for': '203.0.113.9' },
          socket: { remoteAddress: '198.51.100.77' },
        },
        config,
      ),
    ).toBe('198.51.100.77');
  });
});
