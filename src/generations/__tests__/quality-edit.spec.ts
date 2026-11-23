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
