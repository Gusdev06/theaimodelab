import { GenerationType, Resolution } from '@prisma/client';
import { liftFaceSwapResolution, liftImageResolution } from '../image-min-resolution';

describe('imagem sem 1K (TKT-291, dono 19/11)', () => {
  it('imagem pedida em 1K vira 2K', () => {
    for (const type of [GenerationType.TEXT_TO_IMAGE, GenerationType.IMAGE_TO_IMAGE, GenerationType.VIRTUAL_TRY_ON, GenerationType.FACE_SWAP]) {
      expect(liftImageResolution(type, Resolution.RES_1K, { flag: '' })).toBe(Resolution.RES_2K);
    }
  });

  it('2K, 4K e vídeo não mudam', () => {
    expect(liftImageResolution(GenerationType.TEXT_TO_IMAGE, Resolution.RES_2K, { flag: '' })).toBe(Resolution.RES_2K);
    expect(liftImageResolution(GenerationType.TEXT_TO_IMAGE, Resolution.RES_4K, { flag: '' })).toBe(Resolution.RES_4K);
    expect(liftImageResolution(GenerationType.TEXT_TO_VIDEO, Resolution.RES_1K, { flag: '' })).toBe(Resolution.RES_1K);
  });

  it('IMAGE_MIN_RES_2K=false devolve o 1K', () => {
    expect(liftImageResolution(GenerationType.TEXT_TO_IMAGE, Resolution.RES_1K, { flag: 'false' })).toBe(Resolution.RES_1K);
    expect(liftFaceSwapResolution('1K', 'FALSE')).toBe('1K');
  });

  it('GPT Image 2.5 nas proporções que só existem em 1K continua em 1K', () => {
    expect(liftImageResolution(GenerationType.TEXT_TO_IMAGE, Resolution.RES_1K, { model: 'gpt-image-2-5', aspectRatio: '27:16', flag: '' })).toBe(Resolution.RES_1K);
    expect(liftImageResolution(GenerationType.TEXT_TO_IMAGE, Resolution.RES_1K, { model: 'gpt-image-2-5', aspectRatio: '1:1', flag: '' })).toBe(Resolution.RES_2K);
  });

  it('troca de rosto: 1K vira 2K, o resto passa', () => {
    expect(liftFaceSwapResolution('1K', '')).toBe('2K');
    expect(liftFaceSwapResolution('4K', '')).toBe('4K');
    expect(liftFaceSwapResolution(undefined, '')).toBeUndefined();
  });
});
