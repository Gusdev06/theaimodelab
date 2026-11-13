import {
  ULTRA_REALISM_BLOCK,
  isStylizedPrompt,
  ultraRealismEnabled,
  ultraRealismFor,
} from '../ultra-realism';

describe('ultra-realismo nos prompts (dono 13/11)', () => {
  it('a env liga e desliga: vazia ou off = nada muda', () => {
    expect(ultraRealismEnabled(undefined)).toBe(false);
    expect(ultraRealismEnabled('')).toBe(false);
    expect(ultraRealismEnabled('off')).toBe(false);
    expect(ultraRealismEnabled('on')).toBe(true);
    expect(ultraRealismEnabled(' TRUE ')).toBe(true);
    expect(ultraRealismFor(false, 'adult woman, 24, bedroom selfie')).toBe('');
  });

  it('pedido fotográfico ganha o bloco; estilizado não', () => {
    expect(ultraRealismFor(true, 'adult woman, 24, mirror selfie in lingerie')).toBe(ULTRA_REALISM_BLOCK);
    for (const stylized of ['anime girl, 25, adult', 'mangá estilo', 'hentai style', 'pixar 3d render', 'pencil drawing of a woman', 'watercolor portrait', 'webtoon panel', 'Ghibli style']) {
      expect(isStylizedPrompt(stylized)).toBe(true);
      expect(ultraRealismFor(true, stylized)).toBe('');
    }
    expect(isStylizedPrompt('woman in animal print bikini')).toBe(false);
  });

  it('não repete o bloco quando o prompt já o tem', () => {
    expect(ultraRealismFor(true, `adult woman. ${ULTRA_REALISM_BLOCK}`)).toBe('');
  });
});
