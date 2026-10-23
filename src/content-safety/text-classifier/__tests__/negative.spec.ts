import { assessNegative, maturityTokens } from '../negative';

const MARKERS = ['marcador alfa', 'beta'];

describe('assessNegative (negativo com a regra invertida)', () => {
  it('marcador no negativo de pedido sexual = sinal', () => {
    expect(
      assessNegative('blurry, beta, low quality', {
        sexualRequest: true,
        markers: MARKERS,
      }),
    ).toEqual({ flagged: true, markerHits: 1 });
  });

  it('o mesmo negativo em pedido não sexual não conta (só registra os acertos)', () => {
    expect(
      assessNegative('blurry, beta', {
        sexualRequest: false,
        markers: MARKERS,
      }),
    ).toEqual({ flagged: false, markerHits: 1 });
  });

  it('palavra inteira: marcador dentro de outra palavra não conta', () => {
    expect(
      assessNegative('alphabetagamma, betas', {
        sexualRequest: true,
        markers: MARKERS,
      }),
    ).toEqual({ flagged: false, markerHits: 0 });
  });

  it('marcador de duas palavras casa com qualquer separador, caixa e acento', () => {
    for (const negative of [
      'MARCADOR ALFA',
      'marcador-alfa',
      'márcador   álfa!!',
      'x,marcador_alfa,y',
    ]) {
      expect(
        assessNegative(negative, { sexualRequest: true, markers: MARKERS })
          .flagged,
      ).toBe(true);
    }
  });

  it('forma canônica da trava: letra de largura total vira a letra comum', () => {
    expect(
      assessNegative('ｂｅｔａ', { sexualRequest: true, markers: MARKERS })
        .flagged,
    ).toBe(true);
  });

  it('conta marcadores distintos, sem repetir', () => {
    expect(
      assessNegative('beta beta marcador alfa', {
        sexualRequest: true,
        markers: [...MARKERS, 'beta'],
      }),
    ).toEqual({ flagged: true, markerHits: 2 });
  });

  it('negativo vazio, nulo ou lista vazia: nada', () => {
    for (const negative of [null, undefined, '', '   ']) {
      expect(
        assessNegative(negative, { sexualRequest: true, markers: MARKERS }),
      ).toEqual({ flagged: false, markerHits: 0 });
    }
    expect(
      assessNegative('beta', { sexualRequest: true, markers: [] }),
    ).toEqual({ flagged: false, markerHits: 0 });
  });

  it('não procura nada além dos marcadores da política (o resto do negativo é boa prática)', () => {
    expect(
      assessNegative('qualquer termo que a cliente queira evitar', {
        sexualRequest: true,
        markers: MARKERS,
      }),
    ).toEqual({ flagged: false, markerHits: 0 });
  });

  it('maturityTokens separa por tudo que não é letra ou número', () => {
    expect(maturityTokens('A-b_c, d🔥e')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(maturityTokens(null)).toEqual([]);
  });
});
