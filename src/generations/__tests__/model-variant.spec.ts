import { BadRequestException } from '@nestjs/common';
import {
  MODEL_VARIANT_MISMATCH,
  getModelVariant,
  resolveModelVariant,
} from '../model-variant';

describe('model-variant (TKT-097)', () => {
  it('deriva a variante do modelo', () => {
    expect(getModelVariant('veo3')).toBe('VEO_MAX');
    expect(getModelVariant('veo3_fast')).toBe('VEO_FAST');
    expect(getModelVariant('nano-banana-2')).toBe('NB2');
    expect(getModelVariant('gemini-3.1-flash-image-preview')).toBe('NB2');
    expect(getModelVariant('wavespeed-minimax-h3')).toBe('WAVESPEED_MINIMAX_H3');
    expect(getModelVariant(undefined)).toBeNull();
    expect(getModelVariant('modelo-inventado')).toBeNull();
  });

  it('ignora o model_variant do cliente quando bate com o servidor', () => {
    expect(resolveModelVariant('veo3', 'VEO_MAX')).toBe('VEO_MAX');
    expect(resolveModelVariant('veo3', undefined)).toBe('VEO_MAX');
    expect(resolveModelVariant('veo3', null)).toBe('VEO_MAX');
  });

  it('recusa variante barata num modelo caro (o golpe do veo3 cobrado como grok)', () => {
    expect.assertions(3);
    try {
      resolveModelVariant('veo3', 'GROK_IMAGINE');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const body = (error as BadRequestException).getResponse() as Record<string, unknown>;
      expect(body.code).toBe(MODEL_VARIANT_MISMATCH);
      expect(body.statusCode).toBe(400);
    }
  });

  it('recusa a variante do ilimitado num modelo que não é ilimitado', () => {
    expect(() => resolveModelVariant('bytedance-seedance-2-5', 'THEAIMODELAB_FAST')).toThrow(
      BadRequestException,
    );
  });

  it('modelo fora do mapa: nunca aceita a variante do cliente', () => {
    expect(resolveModelVariant('modelo-inventado', undefined)).toBeNull();
    expect(() => resolveModelVariant('modelo-inventado', 'NB2')).toThrow(BadRequestException);
  });
});
