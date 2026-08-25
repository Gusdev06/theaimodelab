import {
  ONBOARDING_STARTER_KIT,
  estimateMonthlyCredits,
  recommendPlan,
  resolveFirstRun,
  resolveSegment,
  type OnboardingAnswers,
} from '../onboarding.constants';

function answers(overrides: Partial<OnboardingAnswers> = {}): OnboardingAnswers {
  return {
    role: 'solo_creator',
    platform: 'onlyfans',
    modelStatus: 'has_one',
    contentMix: 'photos',
    weeklyVolume: 'under_20',
    ...overrides,
  };
}

describe('resolveSegment', () => {
  it('trata agência como fábrica, independente do volume', () => {
    expect(resolveSegment(answers({ role: 'agency' }))).toBe('factory');
  });

  it('trata várias modelos como fábrica mesmo para criador solo', () => {
    expect(resolveSegment(answers({ modelStatus: 'has_many' }))).toBe('factory');
  });

  it('trata operador de OFM como escala', () => {
    expect(resolveSegment(answers({ role: 'ofm_operator' }))).toBe('scale');
  });

  it('volume alto vira escala mesmo para criador solo', () => {
    expect(resolveSegment(answers({ weeklyVolume: 'over_150' }))).toBe('scale');
  });

  it('quem não tem modelo cai em identidade', () => {
    expect(resolveSegment(answers({ modelStatus: 'needs_first' }))).toBe(
      'identity',
    );
  });

  it('persona pronta com volume baixo cai em volume', () => {
    expect(resolveSegment(answers())).toBe('volume');
  });
});

describe('resolveFirstRun', () => {
  it('manda criar a modelo antes de qualquer outra coisa', () => {
    expect(
      resolveFirstRun(
        answers({ modelStatus: 'needs_first', contentMix: 'video_heavy' }),
      ),
    ).toBe('create_model');
  });

  it('manda para vídeo quando vídeo é o forte e a persona existe', () => {
    expect(resolveFirstRun(answers({ contentMix: 'video_heavy' }))).toBe(
      'generate_video',
    );
  });

  it('cai em fotos por padrão', () => {
    expect(resolveFirstRun(answers())).toBe('generate_photos');
  });
});

describe('estimateMonthlyCredits', () => {
  it('usa só o custo de imagem quando o mix é foto', () => {
    // 15/semana × 4.33 ≈ 65 ativos × 90 créditos
    expect(estimateMonthlyCredits(answers())).toBe(5846);
  });

  it('cresce quando entra vídeo no mix', () => {
    const photos = estimateMonthlyCredits(answers());
    const mixed = estimateMonthlyCredits(answers({ contentMix: 'mixed' }));
    const video = estimateMonthlyCredits(answers({ contentMix: 'video_heavy' }));

    expect(mixed).toBeGreaterThan(photos);
    expect(video).toBeGreaterThan(mixed);
  });
});

describe('recommendPlan', () => {
  it('recomenda o Creator para quem está começando com foto', () => {
    expect(recommendPlan(answers()).recommendedPlan).toBe('creator');
  });

  it('nunca recomenda abaixo do piso do segmento', () => {
    // Agência com volume mínimo ainda precisa de API e slots de clone.
    const result = recommendPlan(answers({ role: 'agency' }));
    expect(result.recommendedPlan).toBe('advanced');
  });

  it('sobe de plano conforme o volume declarado', () => {
    const low = recommendPlan(answers({ weeklyVolume: 'under_20' }));
    const high = recommendPlan(
      answers({ weeklyVolume: 'from_60_to_150', contentMix: 'mixed' }),
    );
    expect(high.estimatedMonthlyCredits).toBeGreaterThan(
      low.estimatedMonthlyCredits,
    );
  });

  it('admite quando o volume passa do maior plano em vez de fingir que cabe', () => {
    const result = recommendPlan(
      answers({ weeklyVolume: 'over_150', contentMix: 'video_heavy' }),
    );
    expect(result.exceedsTopPlan).toBe(true);
    expect(result.recommendedPlan).toBe('studio');
  });

  it('não marca excesso quando o Studio cobre o volume', () => {
    expect(recommendPlan(answers()).exceedsTopPlan).toBe(false);
  });
});

describe('ONBOARDING_STARTER_KIT', () => {
  it('cobre as três provas da oferta: rosto, sem censura e vídeo', () => {
    expect(ONBOARDING_STARTER_KIT.NB2).toBeGreaterThan(0);
    expect(ONBOARDING_STARTER_KIT.SEM_CENSURA).toBeGreaterThan(0);
    expect(ONBOARDING_STARTER_KIT.THEAIMODELAB_FAST).toBeGreaterThan(0);
  });
});
