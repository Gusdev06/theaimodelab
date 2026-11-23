import {
  UPSCALE_TOOL_PROMPT,
  isQualityOnlyEditRequest,
  qualityEditLockEnabled,
} from '../quality-edit';

describe('isQualityOnlyEditRequest (TKT-373)', () => {
  it.each([
    // os pedidos reais da cliente do TKT-373 (20 e 21/11)
    'Upscale',
    'Limpiar imagen y dar nitidez',
    'Dar nitidez a la imagen',
    'Solo limpiar imagen y dar nitidez',
    // pt / es / en
    'mais nítida',
    'Deixa mais nítido por favor',
    'melhorar a qualidade da foto',
    'mejorar calidad',
    'quitar lo borroso',
    'tirar o desfoque',
    'HD',
    '4K',
    'upscale 4k',
    'make it sharper',
    'enhance quality, remove blur',
    'higher resolution please',
    'denoise',
    'upscale 2x',
    'melhorar a qualidade dessa foto',
    'nitidez pfv',
    'tirar o desfoque e dar nitidez',
    'remove noise and blur',
    'sin borroso, más nítida',
    'restaurar foto',
    UPSCALE_TOOL_PROMPT,
  ])('"%s" é pedido só de qualidade', (prompt) => {
    expect(isQualityOnlyEditRequest(prompt)).toBe(true);
  });

  it.each([
    '',
    '   ',
    'Ella de rodillas chupando el pene a todos los del grupo',
    'Poner faldita muy corta blanca, en HD',
    'dar nitidez y quitarle la ropa',
    'make her naked, 4k',
    'mais nítida com fundo de praia',
    'sharp eyes, blonde adult woman in a red dress',
    'mejorar la pose',
    'upscale and change the background to a beach',
    'Corregir el defecto de la imagen el chico que está frente a ella que este totalmente de pie',
    // revisão adversarial de 23/11: pedir o defeito, negar/reduzir a qualidade, falar da pessoa
    'Blur',
    'add blur',
    'more blur',
    'desfocar a foto',
    'desenfocar la imagen',
    'add grain',
    'make it grainy',
    'mais granulado',
    'deixa pixelado',
    'make it pixelated',
    'reduce sharpness',
    'reduzir a nitidez',
    'sin nitidez',
    'sem foco',
    'tirar o foco',
    'no sharpening',
    'no hd',
    'remove details',
    'não quero nitidez',
    'limpa ela',
    'clean her',
    'limpia a ella',
    'enhance her',
    'enfocar en ella',
    'quitar a ella, mejorar calidad',
    'remove her, HD',
    'deixa ela mais alta e nítida',
    'HD sin ropa',
    // texto longo com palavra de qualidade no meio continua sendo pedido criativo
    'Edite a Foto 2 com perfeição absoluta e qualidade fotográfica profissional, mulher adulta de 30 anos na praia',
  ])('"%s" NÃO é pedido só de qualidade', (prompt) => {
    expect(isQualityOnlyEditRequest(prompt)).toBe(false);
  });

  it('null e undefined não são pedido de qualidade', () => {
    expect(isQualityOnlyEditRequest(null)).toBe(false);
    expect(isQualityOnlyEditRequest(undefined)).toBe(false);
  });

  it('a trava vem ligada; só off/false/0 desliga', () => {
    expect(qualityEditLockEnabled(undefined)).toBe(true);
    expect(qualityEditLockEnabled('')).toBe(true);
    expect(qualityEditLockEnabled('on')).toBe(true);
    expect(qualityEditLockEnabled(' OFF ')).toBe(false);
    expect(qualityEditLockEnabled('false')).toBe(false);
    expect(qualityEditLockEnabled('0')).toBe(false);
  });
});
