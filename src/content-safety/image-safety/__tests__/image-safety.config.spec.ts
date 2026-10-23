import { join, resolve } from 'path';
import {
  describeImageSafetyConfig,
  enforcesMediaPreflight,
  isRuleEnforced,
  loadImageSafetyConfig,
  RULES_VERSION,
  type ImageSafetyConfig,
} from '../image-safety.config';
import { CONTRACT_MATCHES_PRISMA_SCHEMA } from '../types';

const APP_ROOT = resolve(__dirname, 'app-root-de-teste');
const OUTSIDE_POLICY = resolve(APP_ROOT, '..', 'fora-do-app', 'politica.md');

function load(env: Record<string, string>) {
  return loadImageSafetyConfig((key) => env[key], APP_ROOT);
}

function enforcementConfig(
  imageMode: ImageSafetyConfig['imageMode'],
  textMode: ImageSafetyConfig['textMode'],
  enforceStrong: boolean,
) {
  return { imageMode, textMode, enforceStrong };
}

describe('loadImageSafetyConfig', () => {
  it('sem env: tudo desligado, padrões das regras e nenhum aviso', () => {
    const { config, warnings } = load({});
    expect(warnings).toEqual([]);
    expect(config.imageMode).toBe('off');
    expect(config.textMode).toBe('off');
    expect(config.enforceStrong).toBe(true);
    expect(config.rulesVersion).toBe(RULES_VERSION);
    expect(config.thresholds).toEqual({
      ageGrayMax: 23,
      outputReviewAgeMax: 21,
      nudityMin: 60,
      childLabelMin: 85,
      phashMaxDistance: 8,
      adultAge: 18,
      childFaceAgeHighMax: 13,
      teenFaceAgeLowMax: 15,
    });
    expect(config.video).toEqual({
      maxFrames: 12,
      everySeconds: 2,
      sceneThreshold: 0.3,
    });
    expect(config.rekognitionRegion).toBe('sa-east-1');
    expect(config.rekognitionFallbackRegion).toBe('us-east-1');
    expect(config.bedrockRegion).toBe('sa-east-1');
    expect(config.bedrockFallbackRegion).toBe('us-east-1');
    expect(config.awsCredentials).toBeNull();
    expect(config.policySource).toBeNull();
    expect(config.trustedFilterModels.size).toBe(0);
    expect(config.reviewerIds.size).toBe(0);
    expect(config.childBlockAllSurfaces).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.thresholds)).toBe(true);
  });

  it('modo aceita maiúsculas e espaços; valor inválido vira off com aviso', () => {
    expect(
      load({ IMAGE_SAFETY_MODE: ' Shadow ', S3_EVIDENCE_BUCKET: 'taml-evid' })
        .config.imageMode,
    ).toBe('shadow');
    const invalid = load({ IMAGE_SAFETY_MODE: 'enforcing' });
    expect(invalid.config.imageMode).toBe('off');
    expect(invalid.warnings.join(' ')).toContain('IMAGE_SAFETY_MODE');
  });

  it('IMAGE_SAFETY_ENFORCE_STRONG inválido continua true (padrão seguro)', () => {
    const { config, warnings } = load({
      IMAGE_SAFETY_ENFORCE_STRONG: 'talvez',
    });
    expect(config.enforceStrong).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(
      load({ IMAGE_SAFETY_ENFORCE_STRONG: 'false' }).config.enforceStrong,
    ).toBe(false);
  });

  it('limite fora da faixa ou não numérico volta ao padrão com aviso', () => {
    const { config, warnings } = load({
      SAFETY_NUDITY_MIN: '99',
      SAFETY_CHILD_LABEL_MIN: 'oitenta',
      SAFETY_AGE_GRAY_MAX: '25',
      SAFETY_PHASH_MAX_DISTANCE: '40',
      SAFETY_VIDEO_EVERY_SECONDS: '1.5',
      SAFETY_VIDEO_SCENE_THRESHOLD: '0.05',
    });
    expect(config.thresholds.nudityMin).toBe(60);
    expect(config.thresholds.childLabelMin).toBe(85);
    expect(config.thresholds.ageGrayMax).toBe(25);
    expect(config.thresholds.phashMaxDistance).toBe(8);
    expect(config.video.everySeconds).toBe(1.5);
    expect(config.video.sceneThreshold).toBe(0.3);
    expect(warnings).toHaveLength(4);
  });

  it('a faixa da S3 nunca passa da zona de dúvida', () => {
    const { config, warnings } = load({
      SAFETY_AGE_GRAY_MAX: '20',
      SAFETY_OUTPUT_REVIEW_AGE_MAX: '22',
    });
    expect(config.thresholds.outputReviewAgeMax).toBe(20);
    expect(warnings.join(' ')).toContain('SAFETY_OUTPUT_REVIEW_AGE_MAX');
  });

  it('região reserva: "none" desliga, igual à principal desliga com aviso, inválida usa o padrão', () => {
    expect(
      load({ AWS_REGION_SAFETY_FALLBACK: 'none' }).config
        .rekognitionFallbackRegion,
    ).toBeNull();
    const same = load({ AWS_REGION_SAFETY_FALLBACK: 'sa-east-1' });
    expect(same.config.rekognitionFallbackRegion).toBeNull();
    expect(same.warnings).toHaveLength(1);
    const invalid = load({ AWS_REGION_SAFETY: 'sao-paulo' });
    expect(invalid.config.rekognitionRegion).toBe('sa-east-1');
    expect(invalid.warnings).toHaveLength(1);
  });

  it('Bedrock herda as regiões do Rekognition, inclusive a reserva desligada', () => {
    const { config } = load({
      AWS_REGION_SAFETY: 'us-east-1',
      AWS_REGION_SAFETY_FALLBACK: 'none',
    });
    expect(config.bedrockRegion).toBe('us-east-1');
    expect(config.bedrockFallbackRegion).toBeNull();
  });

  describe('classificador de texto', () => {
    const ready = {
      TEXT_CLASSIFIER_MODE: 'shadow',
      BEDROCK_SAFEGUARD_MODEL_ID: 'modelo.de-teste-1:0',
    };

    it('sem política o classificador fica desligado', () => {
      const { config, warnings } = load(ready);
      expect(config.textMode).toBe('off');
      expect(warnings.join(' ')).toContain('SAFETY_POLICY_SOURCE');
    });

    it('política com caminho relativo ou dentro da aplicação é recusada', () => {
      const relative = load({ ...ready, SAFETY_POLICY_SOURCE: 'politica.md' });
      expect(relative.config.policySource).toBeNull();
      expect(relative.config.textMode).toBe('off');
      const inside = load({
        ...ready,
        SAFETY_POLICY_SOURCE: join(APP_ROOT, 'segredos', 'politica.md'),
      });
      expect(inside.config.policySource).toBeNull();
      expect(inside.config.textMode).toBe('off');
    });

    it('política fora da aplicação + modelo: liga no modo pedido', () => {
      const { config, warnings } = load({
        ...ready,
        SAFETY_POLICY_SOURCE: OUTSIDE_POLICY,
      });
      expect(warnings).toEqual([]);
      expect(config.textMode).toBe('shadow');
      expect(config.policySource).toBe(OUTSIDE_POLICY);
    });

    it('sem o id do modelo fica desligado', () => {
      const { config } = load({
        TEXT_CLASSIFIER_MODE: 'enforce',
        SAFETY_POLICY_SOURCE: OUTSIDE_POLICY,
      });
      expect(config.textMode).toBe('off');
    });
  });

  it('provedores de confiança nunca incluem sem censura, Grok, Spicy, Kling ou Seedance', () => {
    const { config, warnings } = load({
      SAFETY_TRUSTED_FILTER_MODELS:
        'nano-banana, Grok-Imagine, wavespeed-seedance-spicy, sem-censura, kling-v3-turbo, seedance-2, wavespeed-minimax-h3, gpt-image-2',
    });
    expect([...config.trustedFilterModels]).toEqual([
      'nano-banana',
      'gpt-image-2',
    ]);
    expect(warnings).toHaveLength(6);
  });

  it('revisores: ids fora do formato são ignorados com aviso', () => {
    const { config, warnings } = load({
      SAFETY_REVIEWER_IDS: 'clx0000000000000000000001, x, ;drop',
    });
    expect([...config.reviewerIds]).toEqual(['clx0000000000000000000001']);
    expect(warnings).toHaveLength(1);
  });

  it('modo ligado sem bucket de evidência nem bucket privado de entradas: a imagem NÃO liga (a prova não teria onde ficar)', () => {
    const { config, warnings } = load({
      IMAGE_SAFETY_MODE: 'enforce',
      TEXT_CLASSIFIER_MODE: 'off',
    });
    expect(config.imageMode).toBe('off');
    expect(warnings.join(' ')).toContain('S3_EVIDENCE_BUCKET');
    // bucket privado igual ao público não conta como privado
    expect(
      load({
        IMAGE_SAFETY_MODE: 'shadow',
        S3_BUCKET_NAME: 'ai-generations',
        S3_INPUT_PRIVATE_BUCKET: 'ai-generations',
      }).config.imageMode,
    ).toBe('off');
  });

  it('modo ligado só com o bucket privado de entradas: liga, avisando da evidência, da quarentena e do revisor', () => {
    const { config, warnings } = load({
      IMAGE_SAFETY_MODE: 'shadow',
      S3_INPUT_PRIVATE_BUCKET: 'taml-inputs-private',
    });
    expect(config.imageMode).toBe('shadow');
    expect(warnings).toHaveLength(3);
    expect(warnings.join(' ')).toContain('não pode ter regra de expiração');
    expect(warnings.join(' ')).toContain('sem link para a cliente');
  });

  it('bucket de quarentena ou de evidência igual ao público é ignorado', () => {
    const { config, warnings } = load({
      S3_BUCKET_NAME: 'ai-generations',
      S3_QUARANTINE_BUCKET: 'ai-generations',
      S3_EVIDENCE_BUCKET: 'taml-evidencia',
    });
    expect(config.quarantineBucket).toBeNull();
    expect(config.evidenceBucket).toBe('taml-evidencia');
    expect(warnings).toHaveLength(1);
  });

  it('credencial AWS só vale com as duas partes, e o resumo do boot nunca mostra segredo', () => {
    const half = load({ AWS_SAFETY_ACCESS_KEY_ID: 'AKIAEXEMPLO' });
    expect(half.config.awsCredentials).toBeNull();
    expect(half.warnings).toHaveLength(1);

    const full = load({
      AWS_SAFETY_ACCESS_KEY_ID: 'AKIAEXEMPLO',
      AWS_SAFETY_SECRET_ACCESS_KEY: 'segredo-de-exemplo',
      HIVE_API_KEY: 'chave-hive-exemplo',
      OPENAI_MODERATION_API_KEY: 'chave-omni-exemplo',
    });
    expect(full.config.awsCredentials).toEqual({
      accessKeyId: 'AKIAEXEMPLO',
      secretAccessKey: 'segredo-de-exemplo',
    });
    const summary = describeImageSafetyConfig(full.config);
    for (const secret of [
      'AKIAEXEMPLO',
      'segredo-de-exemplo',
      'chave-hive-exemplo',
      'chave-omni-exemplo',
    ]) {
      expect(summary).not.toContain(secret);
    }
    for (const warning of full.warnings) {
      expect(warning).not.toContain('segredo-de-exemplo');
    }
  });

  it('SAFETY_CHILD_BLOCK_ALL_SURFACES false barra criança só no lado adulto', () => {
    expect(
      load({ SAFETY_CHILD_BLOCK_ALL_SURFACES: 'false' }).config
        .childBlockAllSurfaces,
    ).toBe(false);
  });
});

describe('enforcesMediaPreflight', () => {
  it('só o porteiro ligado (shadow ou enforce) faz o desvio com mídia depender da checagem; padrão off não', () => {
    expect(enforcesMediaPreflight({ imageMode: 'off' })).toBe(false);
    expect(enforcesMediaPreflight({ imageMode: 'shadow' })).toBe(true);
    expect(enforcesMediaPreflight({ imageMode: 'enforce' })).toBe(true);
    expect(enforcesMediaPreflight(load({}).config)).toBe(false);
  });
});

describe('isRuleEnforced', () => {
  it('off nunca age, enforce sempre age, CLEAN nunca age', () => {
    const off = enforcementConfig('off', 'off', true);
    expect(
      isRuleEnforced({ layer: 'image', ruleId: 'E1', strength: 'STRONG' }, off),
    ).toBe(false);
    const enforce = enforcementConfig('enforce', 'enforce', false);
    expect(
      isRuleEnforced(
        { layer: 'image', ruleId: 'E4', strength: 'NONE' },
        enforce,
      ),
    ).toBe(true);
    expect(
      isRuleEnforced(
        { layer: 'text', ruleId: 'T_AMBIGUOUS', strength: 'NONE' },
        enforce,
      ),
    ).toBe(true);
    expect(
      isRuleEnforced(
        { layer: 'image', ruleId: null, strength: 'NONE' },
        enforce,
      ),
    ).toBe(false);
  });

  it('sombra com as fortes ligadas: regras do 1º dia agem, a zona de dúvida só registra', () => {
    const shadow = enforcementConfig('shadow', 'shadow', true);
    for (const ruleId of [
      'E1',
      'E2',
      'E3a',
      'E6',
      'S1',
      'S2',
      'S2b',
      'S4',
      'S5',
      'S6',
      'S7',
      'UNAVAILABLE',
    ] as const) {
      expect(
        isRuleEnforced({ layer: 'image', ruleId, strength: 'MEDIUM' }, shadow),
      ).toBe(true);
    }
    for (const ruleId of ['E3b', 'E4', 'S3'] as const) {
      expect(
        isRuleEnforced({ layer: 'image', ruleId, strength: 'MEDIUM' }, shadow),
      ).toBe(false);
    }
  });

  it('E5: julgada pelo juiz (força média) age já na sombra; sem juiz (NONE) só registra; E7 segue a causa', () => {
    const shadow = enforcementConfig('shadow', 'off', true);
    expect(
      isRuleEnforced({ layer: 'image', ruleId: 'E5', strength: 'MEDIUM' }, shadow),
    ).toBe(true);
    expect(
      isRuleEnforced({ layer: 'image', ruleId: 'E5', strength: 'NONE' }, shadow),
    ).toBe(false);
    expect(
      isRuleEnforced(
        { layer: 'image', ruleId: 'E7', strength: 'MEDIUM', cause: 'E5' },
        shadow,
      ),
    ).toBe(true);
    expect(
      isRuleEnforced(
        { layer: 'image', ruleId: 'E7', strength: 'NONE', cause: 'E5' },
        shadow,
      ),
    ).toBe(false);
  });

  it('E7 age conforme a regra do pior quadro', () => {
    const shadow = enforcementConfig('shadow', 'off', true);
    expect(
      isRuleEnforced(
        { layer: 'image', ruleId: 'E7', strength: 'STRONG', cause: 'E2' },
        shadow,
      ),
    ).toBe(true);
    expect(
      isRuleEnforced(
        { layer: 'image', ruleId: 'E7', strength: 'NONE', cause: 'E4' },
        shadow,
      ),
    ).toBe(false);
  });

  it('texto na sombra: só refinador e sinal forte agem; indisponível não segura a fila', () => {
    const shadow = enforcementConfig('off', 'shadow', true);
    expect(
      isRuleEnforced(
        { layer: 'text', ruleId: 'T_REFINER', strength: 'MEDIUM' },
        shadow,
      ),
    ).toBe(true);
    expect(
      isRuleEnforced(
        { layer: 'text', ruleId: 'T_CLASSIFIER', strength: 'STRONG' },
        shadow,
      ),
    ).toBe(true);
    expect(
      isRuleEnforced(
        { layer: 'text', ruleId: 'T_CLASSIFIER', strength: 'MEDIUM' },
        shadow,
      ),
    ).toBe(false);
    expect(
      isRuleEnforced(
        { layer: 'text', ruleId: 'T_NEGATIVE', strength: 'MEDIUM' },
        shadow,
      ),
    ).toBe(false);
    expect(
      isRuleEnforced(
        { layer: 'text', ruleId: 'UNAVAILABLE', strength: 'NONE' },
        shadow,
      ),
    ).toBe(false);
    expect(
      isRuleEnforced(
        { layer: 'text', ruleId: 'UNAVAILABLE', strength: 'NONE' },
        enforcementConfig('off', 'enforce', true),
      ),
    ).toBe(true);
  });

  it('sombra com as fortes desligadas: só observa', () => {
    const observe = enforcementConfig('shadow', 'shadow', false);
    expect(
      isRuleEnforced(
        { layer: 'image', ruleId: 'E2', strength: 'STRONG' },
        observe,
      ),
    ).toBe(false);
    expect(
      isRuleEnforced(
        { layer: 'image', ruleId: 'UNAVAILABLE', strength: 'NONE' },
        observe,
      ),
    ).toBe(false);
    expect(
      isRuleEnforced(
        { layer: 'text', ruleId: 'T_REFINER', strength: 'MEDIUM' },
        observe,
      ),
    ).toBe(false);
  });
});

describe('contrato × schema', () => {
  it('as uniões do contrato batem com os enums do Prisma (conferido pelo tsc)', () => {
    expect(CONTRACT_MATCHES_PRISMA_SCHEMA).toBe(true);
  });
});
