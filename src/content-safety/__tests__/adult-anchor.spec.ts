import { ADULT_ANCHOR, adultAnchorEnabled, adultSafePrompt, neutralizeYouthSlang } from '../adult-anchor';
import { assessText } from '../minor-guard';

/**
 * Âncora de adulto dos modelos sem filtro: a gíria de juventude que a trava libera nunca chega ao provedor, e todo
 * prompt leva a regra de idade no fim.
 */
describe('adult-anchor', () => {
  const swaps: Array<[string, string]> = [
    ['novinha gostosa de biquíni na praia', 'jovem adulta gostosa de biquíni na praia'],
    ['duas NOVINHAS e uma ninfetinha loira', 'duas jovens adultas e uma jovem adulta loira'],
    ['mulher fantasiada de colegial, saia colegial xadrez', 'mulher fantasiada de uniforme escolar, saia escolar xadrez'],
    ['uniforme de colegiala, una colegiala rubia', 'uniforme escolar, una mujer adulta con uniforme escolar rubia'],
    ['sexy schoolgirl outfit, two schoolgirls kissing', 'sexy school-uniform outfit, two adult women wearing school-uniform costumes kissing'],
    ['she is dressed as a schoolgirl', 'she is wearing a school-uniform costume'],
    ['a schoolgirl on the bed', 'an adult woman wearing a school-uniform costume on the bed'],
    ['Genera una jovencita de 25 años', 'Genera una mujer adulta joven de 25 años'],
    ['a nymphet in lingerie', 'a young adult woman in lingerie'],
  ];
  it.each(swaps)('troca a gíria por adulta: %s', (prompt, expected) => {
    const { text, replaced } = neutralizeYouthSlang(prompt);
    expect(text).toBe(expected);
    expect(replaced.length).toBeGreaterThan(0);
  });

  it.each(swaps)('o que vai ao provedor passa na trava sem gíria nenhuma: %s', (prompt) => {
    const sent = adultSafePrompt(prompt);
    expect(assessText(sent)).toEqual({ blocked: false });
    expect(sent.endsWith(ADULT_ANCHOR)).toBe(true);
  });

  it('não mexe em quem não é gíria de pessoa', () => {
    expect(neutralizeYouthSlang('carro novinho em folha, mulher de vestido')).toEqual({
      text: 'carro novinho em folha, mulher de vestido',
      replaced: [],
    });
    expect(neutralizeYouthSlang('mulher adulta de 30 anos na praia').replaced).toEqual([]);
  });

  it('a âncora entra em todo prompt do modelo sem filtro, uma vez só', () => {
    const once = adultSafePrompt('mulher de 30 anos na praia');
    expect(once).toBe(`mulher de 30 anos na praia\n\n${ADULT_ANCHOR}`);
    expect(adultSafePrompt(once)).toBe(once);
  });

  it('respeita o teto: corta o pedido, nunca a âncora', () => {
    const sent = adultSafePrompt('x'.repeat(6000), 5000);
    expect(sent.length).toBe(5000);
    expect(sent.endsWith(ADULT_ANCHOR)).toBe(true);
  });

  it('prompt vazio fica vazio (a âncora não inventa pedido)', () => {
    expect(adultSafePrompt('')).toBe('');
    expect(adultSafePrompt(undefined)).toBe('');
    expect(adultSafePrompt('   ')).toBe('');
  });

  it('a âncora não tem aspas (nos modelos com voz, aspas viram fala) nem termo que a própria trava barra', () => {
    expect(ADULT_ANCHOR).not.toMatch(/["“”]/);
    expect(assessText(ADULT_ANCHOR)).toEqual({ blocked: false });
  });

  it('ADULT_ANCHOR_ENABLED=false desliga só a âncora', () => {
    expect(adultAnchorEnabled({})).toBe(true);
    expect(adultAnchorEnabled({ ADULT_ANCHOR_ENABLED: 'false' })).toBe(false);
    const previous = process.env.ADULT_ANCHOR_ENABLED;
    process.env.ADULT_ANCHOR_ENABLED = 'false';
    try {
      expect(adultSafePrompt('novinha na praia')).toBe('novinha na praia');
    } finally {
      if (previous === undefined) delete process.env.ADULT_ANCHOR_ENABLED;
      else process.env.ADULT_ANCHOR_ENABLED = previous;
    }
  });
});
