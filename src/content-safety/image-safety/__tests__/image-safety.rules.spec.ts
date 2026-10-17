import {
  DAY_ONE_IMAGE_RULES,
  isRuleEnforced,
  loadImageSafetyConfig,
} from '../image-safety.config';
import {
  aggregatePreflightStatus,
  childLabelConfidence,
  combineInputVerdicts,
  combineOutputVerdicts,
  decideInputVerdict,
  decideOutputVerdict,
  decideVideoVerdict,
  hasPersonWithoutFace,
  isChildEvident,
  isSexualRequest,
  isShadowImageRule,
  nonExplicitNudityScore,
  nudityScore,
  suggestiveScore,
  summarizeInput,
  surfaceOf,
  toScanScores,
  unavailableInputVerdict,
  unavailableOutputVerdict,
  youngestFace,
  type RuleOptions,
  type RuledInputVerdict,
  type RuledOutputVerdict,
} from '../image-safety.rules';
import type {
  FaceSignal,
  HashMatch,
  InputRuleId,
  InputSummary,
  LabelSignal,
  ModerationSignal,
  OutputRuleId,
  RequestContext,
  ScanSignals,
  ScanStage,
  ScanVerdict,
  StylizedSignal,
} from '../types';

/*
 * Só sinais SIMULADOS (idades, rótulos e scores inventados, no formato que o scanner devolve). Nenhuma imagem, nenhum
 * texto de pedido adulto além do mínimo que a trava reconhece como adulto ("lingerie").
 */

const { config } = loadImageSafetyConfig(() => undefined);
const T = config.thresholds;
const ALL_SURFACES: RuleOptions = { childBlockAllSurfaces: true };
const OPTION_B: RuleOptions = { childBlockAllSurfaces: false };

const FILTERED_MODEL = 'nano-banana';
const UNCENSORED_MODEL = 'sem-censura';
const ADULT_TEXT = 'woman in lingerie, studio light';
const NEUTRAL_TEXT = 'portrait in a garden, soft light';

/** Rosto pela faixa do AgeRange (ponto médio calculado). */
function face(
  ageLow: number,
  ageHigh: number,
  extra: Partial<FaceSignal> = {},
): FaceSignal {
  return {
    ageLow,
    ageHigh,
    ageMid: (ageLow + ageHigh) / 2,
    box: { left: 0.1, top: 0.1, width: 0.2, height: 0.2 },
    confidence: 99,
    fromCrop: false,
    ...extra,
  };
}

/** Rosto com o ponto médio exato do limite (Low 16 e High 30: fora dos cortes extremos). */
function faceMid(ageMid: number, extra: Partial<FaceSignal> = {}): FaceSignal {
  return face(16, 30, { ageMid, ...extra });
}

function label(
  name: string,
  confidence: number,
  instanceCount = 1,
): LabelSignal {
  return { name, confidence, instanceCount };
}

function moderation(
  name: string,
  confidence: number,
  parent: string | null = null,
  taxonomyLevel = 2,
): ModerationSignal {
  return { name, parent, confidence, taxonomyLevel };
}

const explicit = (confidence: number) =>
  moderation('Explicit Nudity', confidence, 'Explicit');
const swimwear = (confidence: number) =>
  moderation(
    'Female Swimwear or Underwear',
    confidence,
    'Swimwear or Underwear',
  );

function signals(partial: Partial<ScanSignals> = {}): ScanSignals {
  return {
    faces: [],
    labels: [],
    moderation: [],
    illustrated: false,
    cropPassRan: false,
    phash: '0123456789abcdef',
    sha256: 'a'.repeat(64),
    hashMatch: null,
    stylized: { status: 'not_run' },
    scanner: 'simulado',
    region: 'sa-east-1',
    latencyMs: 12,
    ...partial,
  };
}

function ctx(partial: Partial<RequestContext> = {}): RequestContext {
  const base: Omit<RequestContext, 'surface'> = {
    userId: 'user-teste-1',
    generationId: 'gen-teste-1',
    model: FILTERED_MODEL,
    tool: 'generate',
    type: null,
    hasUserMedia: true,
    sexual: { classifier: null, inputNudity: null },
    prompt: NEUTRAL_TEXT,
    negativePrompt: null,
    ...partial,
  };
  return { ...base, surface: partial.surface ?? surfaceOf(base) };
}

const sexualCtx = (partial: Partial<RequestContext> = {}) =>
  ctx({ model: UNCENSORED_MODEL, ...partial });

function hash(partial: Partial<HashMatch> = {}): HashMatch {
  return {
    source: 'blocklist',
    matcher: 'phash',
    distance: 3,
    blockId: 'block-1',
    strength: 'STRONG',
    ...partial,
  };
}

const judged = (childlike: boolean): StylizedSignal => ({
  status: 'judged',
  judge: 'juiz-simulado',
  childlike,
  confidence: 90,
});

const ALL_TRUE = {
  requireConsent: true,
  noUncensoredFallback: true,
  noPromptRewrite: true,
  fullOutputCheck: true,
};
const ALL_FALSE = {
  requireConsent: false,
  noUncensoredFallback: false,
  noPromptRewrite: false,
  fullOutputCheck: false,
};

/* ------------------------------------------------------------------ leitura dos sinais */

describe('youngestFace', () => {
  it('o mais jovem pelo ponto médio entre várias pessoas', () => {
    const adult = faceMid(34);
    const young = faceMid(16.5);
    const other = faceMid(27);
    expect(youngestFace([adult, young, other])).toBe(young);
  });

  it('empate no ponto médio: vale o de menor idade mínima', () => {
    const narrow = face(18, 22); // 20
    const wide = face(14, 26); // 20
    expect(youngestFace([narrow, wide])).toBe(wide);
  });

  it('inclui os rostos da passada recortada e devolve null sem rosto', () => {
    const fromCrop = face(5, 11, { fromCrop: true, box: null });
    expect(youngestFace([faceMid(30), fromCrop])).toBe(fromCrop);
    expect(youngestFace([])).toBeNull();
  });
});

describe('rótulos e nudez', () => {
  it('"Girl" e "Boy" nunca contam como criança', () => {
    expect(childLabelConfidence([label('Girl', 99), label('Boy', 99)])).toBe(0);
    expect(
      childLabelConfidence([
        label('Child', 90),
        label('Kid', 95),
        label('Girl', 99),
      ]),
    ).toBe(95);
    expect(childLabelConfidence([label('Baby', 86), label('Person', 99)])).toBe(
      86,
    );
  });

  it.each([
    ['rosto com High 13', signals({ faces: [face(6, 13)] }), true],
    ['rosto com High 14', signals({ faces: [face(8, 14)] }), false],
    ['rótulo de criança 85', signals({ labels: [label('Child', 85)] }), true],
    [
      'rótulo de criança 84,9',
      signals({ labels: [label('Toddler', 84.9)] }),
      false,
    ],
    ['"Girl" 99', signals({ labels: [label('Girl', 99)] }), false],
    [
      'criança achada só na passada recortada',
      signals({
        faces: [faceMid(30), face(3, 9, { fromCrop: true })],
        cropPassRan: true,
      }),
      true,
    ],
  ])('isChildEvident: %s', (_name, input, expected) => {
    expect(isChildEvident(input, T)).toBe(expected);
  });

  it('nudez é só a família Explicit; filhos contam pelo pai', () => {
    expect(nudityScore([explicit(70)])).toBe(70);
    expect(
      nudityScore([
        moderation('Exposed Female Genitalia', 81, 'Explicit Nudity', 3),
      ]),
    ).toBe(81);
    expect(
      nudityScore([moderation('Implied Nudity', 95, 'Non-Explicit Nudity', 3)]),
    ).toBe(0);
    expect(nudityScore([])).toBe(0);
  });

  it('nudez parcial conta como não explícita e sugestiva; costas e mamilo masculino não contam', () => {
    const partial = [
      moderation(
        'Partially Exposed Female Breast',
        75,
        'Non-Explicit Nudity',
        3,
      ),
    ];
    expect(nonExplicitNudityScore(partial)).toBe(75);
    expect(suggestiveScore(partial)).toBe(75);
    const ignored = [
      moderation('Bare Back', 99, 'Non-Explicit Nudity', 3),
      moderation('Exposed Male Nipple', 99, 'Non-Explicit Nudity', 3),
    ];
    expect(nudityScore(ignored)).toBe(0);
    expect(nonExplicitNudityScore(ignored)).toBe(0);
    expect(suggestiveScore(ignored)).toBe(0);
    expect(suggestiveScore([swimwear(88)])).toBe(88);
    expect(
      suggestiveScore([
        moderation(
          'Kissing on the Lips',
          64,
          'Non-Explicit Nudity of Intimate parts and Kissing',
        ),
      ]),
    ).toBe(64);
  });

  it.each([
    ['pessoa 70 sem rosto', signals({ labels: [label('Person', 70)] }), true],
    [
      'pessoa 69,9 sem rosto',
      signals({ labels: [label('Person', 69.9)] }),
      false,
    ],
    [
      'pessoa com rosto',
      signals({ labels: [label('Person', 99)], faces: [faceMid(30)] }),
      false,
    ],
    ['"Girl" sem rosto', signals({ labels: [label('Girl', 99)] }), false],
  ])('hasPersonWithoutFace: %s', (_name, input, expected) => {
    expect(hasPersonWithoutFace(input)).toBe(expected);
  });
});

/* ------------------------------------------------------------------ pedido sexual e superfície */

describe('isSexualRequest e surfaceOf', () => {
  it.each([
    ['modelo com filtro e texto neutro', ctx(), false],
    ['modelo sem censura', ctx({ model: UNCENSORED_MODEL }), true],
    ['variante Spicy', ctx({ model: 'wavespeed-ltx-spicy' }), true],
    ['despir sem texto', ctx({ tool: 'undress', prompt: null }), true],
    [
      'troca de rosto Unlocked sem texto',
      ctx({ tool: 'face_swap_unlocked', prompt: null }),
      true,
    ],
    ['troca de rosto comum', ctx({ tool: 'face_swap' }), false],
    ['texto adulto no prompt final', ctx({ prompt: ADULT_TEXT }), true],
    ['texto adulto só no negativo', ctx({ negativePrompt: ADULT_TEXT }), false],
    [
      'classificador marcou',
      ctx({ sexual: { classifier: true, inputNudity: null } }),
      true,
    ],
    [
      'classificador limpo',
      ctx({ sexual: { classifier: false, inputNudity: false } }),
      false,
    ],
    [
      'nudez em outra mídia de entrada',
      ctx({ sexual: { classifier: null, inputNudity: true } }),
      true,
    ],
  ])('%s', (_name, context, expected) => {
    expect(isSexualRequest(context)).toBe(expected);
    expect(surfaceOf(context)).toBe(expected ? 'adult' : 'common');
  });

  it.each([
    ['nudez explícita 60', [explicit(60)], true],
    ['nudez explícita 59,9', [explicit(59.9)], false],
    [
      'nudez parcial 60',
      [
        moderation(
          'Partially Exposed Female Breast',
          60,
          'Non-Explicit Nudity',
          3,
        ),
      ],
      true,
    ],
    [
      'costas nuas 99',
      [moderation('Bare Back', 99, 'Non-Explicit Nudity', 3)],
      false,
    ],
  ])('nudez na mídia: %s', (_name, mod, expected) => {
    expect(isSexualRequest(ctx(), signals({ moderation: mod }), T)).toBe(
      expected,
    );
    // sem limites, usa os padrões (60)
    expect(isSexualRequest(ctx(), signals({ moderation: mod }))).toBe(expected);
  });

  it('a superfície nunca vem de campo do pedido', () => {
    const fromSite = { ...ctx(), surface: 'adult' as const };
    expect(surfaceOf(fromSite)).toBe('common');
  });
});

/* ------------------------------------------------------------------ entrada */

interface ExpectedVerdict {
  verdict: ScanVerdict;
  ruleId: string | null;
  strength?: string;
  evidence?: string;
  addToBlocklist?: boolean;
  shadowOnly?: boolean;
}

function expectInput(
  input: ScanSignals,
  context: RequestContext,
  expected: ExpectedVerdict,
  opts: RuleOptions = ALL_SURFACES,
): RuledInputVerdict {
  const result = decideInputVerdict(input, context, T, opts);
  expect(result).toMatchObject(expected);
  return result;
}

describe('decideInputVerdict', () => {
  describe('E1 · hash', () => {
    it.each([
      ['lista própria, variante', hash({ distance: 3 }), true],
      ['lista própria, sha256 exato', hash({ distance: 0 }), false],
      ['lista própria sem distância', hash({ distance: null }), true],
      [
        'abuso conhecido',
        hash({
          source: 'known-csam',
          matcher: 'arachnid',
          distance: null,
          blockId: null,
        }),
        true,
      ],
    ])('%s', (_name, match, addToBlocklist) => {
      const result = expectInput(
        signals({ hashMatch: match, faces: [faceMid(35)] }),
        ctx(),
        {
          verdict: 'BLOCK',
          ruleId: 'E1',
          strength: 'STRONG',
          evidence: 'keep',
          addToBlocklist,
          shadowOnly: false,
        },
      );
      expect(result.restrictions).toEqual(ALL_TRUE);
    });

    it('vem antes da criança evidente', () => {
      expectInput(
        signals({ hashMatch: hash(), faces: [face(4, 10)] }),
        sexualCtx(),
        {
          verdict: 'BLOCK',
          ruleId: 'E1',
        },
      );
    });
  });

  describe('E2 · criança evidente', () => {
    it.each([
      [
        'rosto High 13, modelo sem censura',
        signals({ faces: [face(6, 13)] }),
        sexualCtx(),
      ],
      [
        'rótulo 85, texto adulto',
        signals({ labels: [label('Child', 85)] }),
        ctx({ prompt: ADULT_TEXT }),
      ],
      [
        'despir sem texto',
        signals({ faces: [face(2, 6)] }),
        ctx({ tool: 'undress', prompt: null }),
      ],
      [
        'criança no fundo, achada na passada recortada',
        signals({
          faces: [faceMid(31), face(3, 9, { fromCrop: true })],
          cropPassRan: true,
        }),
        sexualCtx(),
      ],
    ])('pedido sexual = forte: %s', (_name, input, context) => {
      expectInput(input, context, {
        verdict: 'BLOCK',
        ruleId: 'E2',
        strength: 'STRONG',
        evidence: 'keep',
        addToBlocklist: true,
        shadowOnly: false,
      });
      // na opção (b) o lado adulto continua barrando forte
      expectInput(
        input,
        context,
        { verdict: 'BLOCK', ruleId: 'E2', strength: 'STRONG' },
        OPTION_B,
      );
    });

    it('pedido não sexual = leve, foto apagada, sem hash', () => {
      const result = expectInput(signals({ faces: [face(6, 12)] }), ctx(), {
        verdict: 'BLOCK',
        ruleId: 'E2',
        strength: 'LIGHT',
        evidence: 'delete',
        addToBlocklist: false,
      });
      expect(result.restrictions).toEqual(ALL_TRUE);
    });

    it('opção (b), lado comum: segue em dúvida, sem desvio e com a saída checada', () => {
      const result = expectInput(
        signals({ labels: [label('Kid', 92)] }),
        ctx(),
        {
          verdict: 'GRAY',
          ruleId: 'E2',
          strength: 'NONE',
          evidence: 'none',
          addToBlocklist: false,
        },
        OPTION_B,
      );
      expect(result.restrictions).toEqual({
        requireConsent: false,
        noUncensoredFallback: true,
        noPromptRewrite: true,
        fullOutputCheck: true,
      });
    });

    it('opção (b) com superfície adulta já decidida pela orquestração: leve', () => {
      expectInput(
        signals({ faces: [face(6, 12)] }),
        { ...ctx(), surface: 'adult' },
        {
          verdict: 'BLOCK',
          ruleId: 'E2',
          strength: 'LIGHT',
          evidence: 'delete',
        },
        OPTION_B,
      );
    });

    it('limites: High 14 não é criança evidente; rótulo 84,9 também não', () => {
      expectInput(signals({ faces: [face(8, 14)] }), sexualCtx(), {
        verdict: 'HOLD',
        ruleId: 'E3a',
      });
      expectInput(
        signals({ labels: [label('Child', 84.9)], faces: [faceMid(30)] }),
        sexualCtx(),
        {
          verdict: 'CLEAN',
          ruleId: null,
        },
      );
    });

    it('"Girl" com 99% não conta', () => {
      expectInput(
        signals({
          labels: [label('Girl', 99), label('Person', 99)],
          faces: [faceMid(28)],
        }),
        sexualCtx(),
        { verdict: 'CLEAN', ruleId: null },
      );
      expectInput(signals({ labels: [label('Girl', 99)] }), ctx(), {
        verdict: 'CLEAN',
        ruleId: null,
      });
    });
  });

  describe('E6 · pedido de remover criança', () => {
    const removal = 'remove the children from the photo, keep the beach';

    it('pedido sexual + rosto de provável menor = forte', () => {
      expectInput(
        signals({ faces: [faceMid(34), faceMid(15.5)] }),
        sexualCtx({ prompt: removal }),
        {
          verdict: 'BLOCK',
          ruleId: 'E6',
          strength: 'STRONG',
          evidence: 'keep',
          addToBlocklist: true,
        },
      );
    });

    it('pedido comum fica com a E3b (leve), sem suspender', () => {
      expectInput(
        signals({ faces: [faceMid(34), faceMid(15.5)] }),
        ctx({ prompt: removal }),
        {
          verdict: 'BLOCK',
          ruleId: 'E3b',
          strength: 'LIGHT',
          evidence: 'delete',
        },
      );
    });

    it('rosto mais jovem adulto: não é E6', () => {
      expectInput(
        signals({ faces: [faceMid(18)] }),
        sexualCtx({ prompt: removal }),
        {
          verdict: 'GRAY',
          ruleId: 'E4',
        },
      );
    });

    it('remoção negada não é E6 (fica na E3a, médio)', () => {
      expectInput(
        signals({ faces: [faceMid(34), faceMid(15.5)] }),
        sexualCtx({ prompt: 'do not remove the kids from the photo' }),
        { verdict: 'HOLD', ruleId: 'E3a', strength: 'MEDIUM' },
      );
    });

    it('remoção só no negativo não conta', () => {
      expectInput(
        signals({ faces: [faceMid(16)] }),
        sexualCtx({ prompt: null, negativePrompt: removal }),
        {
          verdict: 'HOLD',
          ruleId: 'E3a',
        },
      );
    });
  });

  describe('E3a · provável menor em pedido sexual', () => {
    it.each([
      ['modelo sem censura', sexualCtx()],
      ['texto adulto', ctx({ prompt: ADULT_TEXT })],
      [
        'troca de rosto Unlocked sem texto',
        ctx({ tool: 'face_swap_unlocked', prompt: null }),
      ],
      [
        'classificador',
        ctx({ sexual: { classifier: true, inputNudity: null } }),
      ],
    ])('ponto médio 17,9 segura sem gerar: %s', (_name, context) => {
      const result = expectInput(signals({ faces: [faceMid(17.9)] }), context, {
        verdict: 'HOLD',
        ruleId: 'E3a',
        strength: 'MEDIUM',
        evidence: 'keep',
        addToBlocklist: false,
        shadowOnly: false,
      });
      expect(result.restrictions).toEqual(ALL_TRUE);
    });

    it('nudez na própria foto torna o pedido sexual', () => {
      expectInput(
        signals({ faces: [faceMid(17)], moderation: [explicit(60)] }),
        ctx(),
        {
          verdict: 'HOLD',
          ruleId: 'E3a',
        },
      );
      expectInput(
        signals({ faces: [faceMid(17)], moderation: [explicit(59.9)] }),
        ctx(),
        {
          verdict: 'BLOCK',
          ruleId: 'E3b',
          strength: 'LIGHT',
        },
      );
    });

    it('vale o rosto mais jovem entre várias pessoas', () => {
      const result = expectInput(
        signals({ faces: [faceMid(41), faceMid(16.5), faceMid(29)] }),
        sexualCtx(),
        { verdict: 'HOLD', ruleId: 'E3a' },
      );
      expect(result.youngestFace?.ageMid).toBe(16.5);
      expect(result.reason).toContain('16,5');
    });

    it('o motivo nunca traz o texto do pedido', () => {
      const result = decideInputVerdict(
        signals({ faces: [faceMid(16)] }),
        ctx({ prompt: ADULT_TEXT }),
        T,
        ALL_SURFACES,
      );
      expect(result.reason).not.toContain('lingerie');
    });
  });

  describe('E5 · desenhado ou pessoa sem rosto', () => {
    it('sem juiz: dúvida com a saída obrigatoriamente checada', () => {
      for (const stylized of [
        { status: 'not_run' } as const,
        { status: 'unavailable', judge: 'hive' } as const,
      ]) {
        const result = expectInput(
          signals({ illustrated: true, stylized }),
          sexualCtx(),
          {
            verdict: 'GRAY',
            ruleId: 'E5',
            strength: 'NONE',
            evidence: 'none',
            addToBlocklist: false,
            shadowOnly: true,
          },
        );
        expect(result.restrictions.fullOutputCheck).toBe(true);
        expect(result.restrictions.noUncensoredFallback).toBe(true);
      }
    });

    it('juiz aponta traço infantil = médio', () => {
      expectInput(
        signals({ illustrated: true, stylized: judged(true) }),
        sexualCtx(),
        {
          verdict: 'BLOCK',
          ruleId: 'E5',
          strength: 'MEDIUM',
          evidence: 'keep',
          addToBlocklist: true,
        },
      );
    });

    it('juiz diz adulto: segue para as próximas regras', () => {
      expectInput(
        signals({ illustrated: true, stylized: judged(false) }),
        sexualCtx(),
        {
          verdict: 'CLEAN',
          ruleId: null,
        },
      );
    });

    it('pessoa sem rosto em pedido sexual, sem juiz', () => {
      expectInput(
        signals({ labels: [label('Person', 96, 2)], cropPassRan: true }),
        sexualCtx(),
        {
          verdict: 'GRAY',
          ruleId: 'E5',
        },
      );
    });

    it('desenhado em pedido não sexual: limpo', () => {
      expectInput(signals({ illustrated: true }), ctx(), {
        verdict: 'CLEAN',
        ruleId: null,
      });
    });
  });

  describe('E4 · zona de dúvida', () => {
    it.each([
      [18, 'GRAY', 'E4'],
      [22.9, 'GRAY', 'E4'],
      [23, 'CLEAN', null],
    ])('ponto médio %s em pedido sexual', (mid, verdict, ruleId) => {
      expectInput(signals({ faces: [faceMid(mid)] }), sexualCtx(), {
        verdict: verdict as ScanVerdict,
        ruleId,
      });
    });

    it('exige atestado só com mídia do usuário; regra de sombra', () => {
      const withMedia = expectInput(
        signals({ faces: [faceMid(20)] }),
        sexualCtx(),
        {
          verdict: 'GRAY',
          ruleId: 'E4',
          shadowOnly: true,
        },
      );
      expect(withMedia.restrictions).toEqual(ALL_TRUE);
      const withoutMedia = decideInputVerdict(
        signals({ faces: [faceMid(20)] }),
        sexualCtx({ hasUserMedia: false }),
        T,
        ALL_SURFACES,
      );
      expect(withoutMedia.restrictions.requireConsent).toBe(false);
      expect(withoutMedia.restrictions.fullOutputCheck).toBe(true);
    });
  });

  describe('E3b · registro', () => {
    it.each([
      [17.9, 'BLOCK', 'E3b'],
      [18, 'CLEAN', null],
    ])('ponto médio %s em pedido não sexual', (mid, verdict, ruleId) => {
      expectInput(signals({ faces: [faceMid(mid)] }), ctx(), {
        verdict: verdict as ScanVerdict,
        ruleId,
      });
    });

    it('pedido não sexual com provável menor: leve, foto apagada, de sombra', () => {
      expectInput(signals({ faces: [faceMid(16)] }), ctx(), {
        verdict: 'BLOCK',
        ruleId: 'E3b',
        strength: 'LIGHT',
        evidence: 'delete',
        addToBlocklist: false,
        shadowOnly: true,
      });
    });

    it('opção (b), lado comum: dúvida', () => {
      expectInput(
        signals({ faces: [faceMid(16)] }),
        ctx(),
        { verdict: 'GRAY', ruleId: 'E3b', strength: 'NONE' },
        OPTION_B,
      );
    });

    it.each([
      [
        'Low 15 com ponto médio 23, pedido sexual',
        face(15, 31),
        sexualCtx(),
        'GRAY',
        'E3b',
      ],
      [
        'Low 15 com ponto médio 23, pedido comum',
        face(15, 31),
        ctx(),
        'GRAY',
        'E3b',
      ],
      ['Low 16 com ponto médio 23', face(16, 30), sexualCtx(), 'CLEAN', null],
    ])('corte extremo: %s', (_name, faceSignal, context, verdict, ruleId) => {
      expectInput(signals({ faces: [faceSignal] }), context, {
        verdict: verdict as ScanVerdict,
        ruleId,
        strength: 'NONE',
      });
    });

    it('corte extremo vale para o rosto mais jovem, não para qualquer rosto', () => {
      // mais jovem: 16–30 (23); o de faixa larga 15–41 (28) é mais velho pelo ponto médio
      expectInput(signals({ faces: [face(16, 30), face(15, 41)] }), ctx(), {
        verdict: 'CLEAN',
        ruleId: null,
      });
      const result = expectInput(
        signals({ faces: [faceMid(40), face(15, 31)] }),
        ctx(),
        { verdict: 'GRAY', ruleId: 'E3b', shadowOnly: true },
      );
      expect(result.reason).toContain('idade mínima 15');
    });
  });

  it('sem rosto, sem rótulo e sem hash: limpo, sem restrição', () => {
    const result = expectInput(signals(), sexualCtx(), {
      verdict: 'CLEAN',
      ruleId: null,
      strength: 'NONE',
      evidence: 'none',
      addToBlocklist: false,
      shadowOnly: false,
    });
    expect(result.restrictions).toEqual(ALL_FALSE);
    expect(result.youngestFace).toBeNull();
  });

  it('o negativo nunca torna o pedido sexual', () => {
    expectInput(
      signals({ faces: [faceMid(16)] }),
      ctx({ negativePrompt: ADULT_TEXT }),
      {
        verdict: 'BLOCK',
        ruleId: 'E3b',
        strength: 'LIGHT',
      },
    );
  });
});

/* ------------------------------------------------------------------ resultado */

const CLEAN_ADULT_INPUT: InputSummary = {
  verdict: 'CLEAN',
  hadFace: true,
  youngestAgeMid: 30,
};

function expectOutput(
  output: ScanSignals,
  context: RequestContext,
  expected: ExpectedVerdict & { disposition?: string },
  input: InputSummary | null = CLEAN_ADULT_INPUT,
  opts: RuleOptions = ALL_SURFACES,
): RuledOutputVerdict {
  const result = decideOutputVerdict(output, context, T, input, opts);
  expect(result).toMatchObject(expected);
  return result;
}

describe('decideOutputVerdict', () => {
  it('S6 · lista de bloqueio', () => {
    expectOutput(
      signals({ hashMatch: hash(), faces: [faceMid(30)] }),
      sexualCtx(),
      {
        verdict: 'BLOCK',
        ruleId: 'S6',
        strength: 'STRONG',
        evidence: 'keep',
        addToBlocklist: true,
        disposition: 'evidence',
      },
    );
    expectOutput(signals({ hashMatch: hash({ distance: 0 }) }), ctx(), {
      verdict: 'BLOCK',
      ruleId: 'S6',
      addToBlocklist: false,
    });
  });

  it.each([
    [
      'rosto High 13',
      signals({ faces: [face(6, 13)], moderation: [explicit(60)] }),
    ],
    [
      'rótulo de criança 85',
      signals({ labels: [label('Baby', 85)], moderation: [explicit(77)] }),
    ],
  ])('S1 · nudez com criança evidente: %s', (_name, output) => {
    expectOutput(output, sexualCtx(), {
      verdict: 'BLOCK',
      ruleId: 'S1',
      strength: 'STRONG',
      evidence: 'keep',
      addToBlocklist: true,
      disposition: 'evidence',
      shadowOnly: false,
    });
  });

  it('S2 · nudez com ponto médio 17,9', () => {
    expectOutput(
      signals({ faces: [faceMid(17.9)], moderation: [explicit(90)] }),
      sexualCtx(),
      {
        verdict: 'BLOCK',
        ruleId: 'S2',
        strength: 'STRONG',
        disposition: 'evidence',
      },
    );
  });

  it('S5 · desenhado com nudez e traço infantil pelo juiz', () => {
    expectOutput(
      signals({
        illustrated: true,
        moderation: [explicit(85)],
        stylized: judged(true),
      }),
      sexualCtx(),
      {
        verdict: 'BLOCK',
        ruleId: 'S5',
        strength: 'STRONG',
        disposition: 'evidence',
      },
    );
  });

  describe('S2b · sugestivo com provável menor em pedido sexual', () => {
    it.each([
      ['roupa de banho 60', [swimwear(60)], 'HOLD', 'S2b'],
      ['roupa de banho 59,9', [swimwear(59.9)], 'CLEAN', null],
      [
        'nudez parcial 99 (não é S2)',
        [
          moderation(
            'Partially Exposed Female Breast',
            99,
            'Non-Explicit Nudity',
            3,
          ),
        ],
        'HOLD',
        'S2b',
      ],
      [
        'costas nuas 99',
        [moderation('Bare Back', 99, 'Non-Explicit Nudity', 3)],
        'CLEAN',
        null,
      ],
    ])('%s', (_name, mod, verdict, ruleId) => {
      expectOutput(
        signals({ faces: [faceMid(17)], moderation: mod }),
        sexualCtx(),
        {
          verdict: verdict as ScanVerdict,
          ruleId,
        },
      );
    });

    it('médio, quarentena, entra na lista só na confirmação', () => {
      expectOutput(
        signals({ faces: [faceMid(16)], moderation: [swimwear(80)] }),
        ctx({ prompt: ADULT_TEXT }),
        {
          verdict: 'HOLD',
          ruleId: 'S2b',
          strength: 'MEDIUM',
          evidence: 'keep',
          addToBlocklist: false,
          disposition: 'hold',
          shadowOnly: false,
        },
      );
    });

    it('ponto médio 18 com roupa de banho: não é S2b', () => {
      expectOutput(
        signals({ faces: [faceMid(18)], moderation: [swimwear(95)] }),
        sexualCtx(),
        { verdict: 'CLEAN', ruleId: null },
      );
    });

    it('pedido não sexual: não é S2b', () => {
      expectOutput(
        signals({ faces: [faceMid(16)], moderation: [swimwear(90)] }),
        ctx(),
        {
          verdict: 'CLEAN',
          ruleId: null,
        },
      );
    });
  });

  describe('S4 · criança sem nudez', () => {
    it('barra em qualquer pedido com a env padrão', () => {
      expectOutput(signals({ faces: [face(5, 10)] }), ctx(), {
        verdict: 'HOLD',
        ruleId: 'S4',
        strength: 'NONE',
        disposition: 'hold',
        shadowOnly: false,
      });
    });

    it('opção (b): lado comum segue; lado adulto segura', () => {
      expectOutput(
        signals({ faces: [face(5, 10)] }),
        ctx(),
        {
          verdict: 'GRAY',
          ruleId: 'S4',
          disposition: 'promote',
          evidence: 'none',
        },
        CLEAN_ADULT_INPUT,
        OPTION_B,
      );
      expectOutput(
        signals({ labels: [label('Child', 90)] }),
        sexualCtx(),
        { verdict: 'HOLD', ruleId: 'S4' },
        CLEAN_ADULT_INPUT,
        OPTION_B,
      );
    });

    it('só pelo rótulo (sem rosto): 85 segura, 84,9 não', () => {
      expectOutput(signals({ labels: [label('Toddler', 85)] }), ctx(), {
        verdict: 'HOLD',
        ruleId: 'S4',
      });
      expectOutput(signals({ labels: [label('Toddler', 84.9)] }), ctx(), {
        verdict: 'CLEAN',
        ruleId: null,
      });
    });

    it('"Girl" e "Boy" com 99% não contam (nem S1 nem S4)', () => {
      const adultFace = [faceMid(30)];
      const labels = [label('Girl', 99), label('Boy', 99), label('Person', 99)];
      expectOutput(signals({ faces: adultFace, labels }), sexualCtx(), {
        verdict: 'CLEAN',
        ruleId: null,
      });
      expectOutput(
        signals({ faces: adultFace, labels, moderation: [explicit(90)] }),
        sexualCtx(),
        { verdict: 'CLEAN', ruleId: null },
      );
    });

    it('nudez 59,9 com criança: S4, não S1', () => {
      expectOutput(
        signals({ faces: [face(6, 12)], moderation: [explicit(59.9)] }),
        sexualCtx(),
        {
          verdict: 'HOLD',
          ruleId: 'S4',
        },
      );
    });
  });

  describe('S3 · nudez com rosto jovem adulto', () => {
    it.each([
      [18, 'HOLD', 'S3'],
      [20.9, 'HOLD', 'S3'],
      [21, 'CLEAN', null],
    ])('ponto médio %s', (mid, verdict, ruleId) => {
      expectOutput(
        signals({ faces: [faceMid(mid)], moderation: [explicit(70)] }),
        sexualCtx(),
        {
          verdict: verdict as ScanVerdict,
          ruleId,
        },
      );
    });

    it('quarentena sem ponto, regra de sombra', () => {
      expectOutput(
        signals({ faces: [faceMid(19)], moderation: [explicit(70)] }),
        sexualCtx(),
        {
          verdict: 'HOLD',
          ruleId: 'S3',
          strength: 'NONE',
          evidence: 'keep',
          addToBlocklist: false,
          disposition: 'hold',
          shadowOnly: true,
        },
      );
    });
  });

  describe('S7 · nudez realista sem rosto', () => {
    const noFace = (stylized: StylizedSignal = { status: 'not_run' }) =>
      signals({
        moderation: [explicit(80)],
        labels: [label('Person', 95)],
        cropPassRan: true,
        stylized,
      });

    it('juiz aponta traço infantil = médio', () => {
      expectOutput(noFace(judged(true)), sexualCtx(), {
        verdict: 'HOLD',
        ruleId: 'S7',
        strength: 'MEDIUM',
        disposition: 'hold',
      });
    });

    it('juiz diz adulto = limpo', () => {
      expectOutput(
        noFace(judged(false)),
        sexualCtx(),
        { verdict: 'CLEAN', ruleId: null },
        null,
      );
    });

    it.each<[string, InputSummary | null, ScanVerdict, string | null]>([
      [
        'entrada limpa com rosto 23',
        { verdict: 'CLEAN', hadFace: true, youngestAgeMid: 23 },
        'CLEAN',
        null,
      ],
      [
        'entrada limpa com rosto 22,9',
        { verdict: 'CLEAN', hadFace: true, youngestAgeMid: 22.9 },
        'HOLD',
        'S7',
      ],
      [
        'entrada em dúvida com rosto 30',
        { verdict: 'GRAY', hadFace: true, youngestAgeMid: 30 },
        'HOLD',
        'S7',
      ],
      [
        'entrada limpa sem rosto',
        { verdict: 'CLEAN', hadFace: false, youngestAgeMid: null },
        'HOLD',
        'S7',
      ],
      [
        'pedido sem mídia (resumo nulo)',
        { verdict: null, hadFace: false, youngestAgeMid: null },
        'HOLD',
        'S7',
      ],
      ['só texto', null, 'HOLD', 'S7'],
    ])('sem juiz, herança: %s', (_name, input, verdict, ruleId) => {
      expectOutput(
        noFace(),
        sexualCtx(),
        { verdict, ruleId, strength: 'NONE' },
        input,
      );
    });

    it('desenhado não é S7', () => {
      expectOutput(
        signals({ illustrated: true, moderation: [explicit(80)] }),
        sexualCtx(),
        {
          verdict: 'CLEAN',
          ruleId: null,
        },
      );
    });
  });

  it('nudez com adulto fora da zona de revisão: limpo e promovido', () => {
    expectOutput(
      signals({ faces: [faceMid(30)], moderation: [explicit(95)] }),
      sexualCtx(),
      {
        verdict: 'CLEAN',
        ruleId: null,
        evidence: 'none',
        addToBlocklist: false,
        disposition: 'promote',
      },
    );
  });
});

/* ------------------------------------------------------------------ vídeo */

const at = (index: number, timeMs: number) => ({ index, timeMs });

describe('decideVideoVerdict', () => {
  it('entrada: vale o pior quadro (no meio), como E7 com a causa', () => {
    const frames = [
      signals({ faces: [faceMid(30)], frame: at(0, 0) }),
      signals({ faces: [faceMid(16)], frame: at(1, 2000) }),
      signals({ faces: [faceMid(30)], frame: at(2, 4000) }),
    ];
    const video = decideVideoVerdict(
      frames,
      sexualCtx(),
      T,
      'input',
      null,
      ALL_SURFACES,
    );
    expect(video.stage).toBe('input');
    expect(video.worst).toMatchObject({
      verdict: 'HOLD',
      ruleId: 'E7',
      cause: 'E3a',
      strength: 'MEDIUM',
      evidence: 'keep',
      shadowOnly: false,
    });
    expect(video.worst.reason).toMatch(/^quadro 1: /);
    expect(video.worstFrame).toEqual(at(1, 2000));
    expect(video.frames.map((item) => item.verdict.ruleId)).toEqual([
      null,
      'E3a',
      null,
    ]);
    expect(video.priorityReview).toBe(false);
  });

  it('entrada: criança num quadro de pedido sexual = forte', () => {
    const video = decideVideoVerdict(
      [signals({ faces: [faceMid(30)] }), signals({ faces: [face(4, 9)] })],
      sexualCtx(),
      T,
      'input',
      null,
      ALL_SURFACES,
    );
    expect(video.worst).toMatchObject({
      verdict: 'BLOCK',
      ruleId: 'E7',
      cause: 'E2',
      strength: 'STRONG',
      addToBlocklist: true,
    });
    // quadro sem posição recebe o índice na lista
    expect(video.worstFrame).toEqual({ index: 1, timeMs: null });
  });

  it('entrada: nudez num quadro torna o vídeo inteiro um pedido sexual', () => {
    const video = decideVideoVerdict(
      [
        signals({ faces: [faceMid(16)] }),
        signals({ moderation: [explicit(70)] }),
      ],
      ctx(),
      T,
      'input',
      null,
      ALL_SURFACES,
    );
    expect(video.worst).toMatchObject({
      verdict: 'HOLD',
      ruleId: 'E7',
      cause: 'E3a',
    });
  });

  it('entrada: causa de sombra continua de sombra', () => {
    const video = decideVideoVerdict(
      [signals({ faces: [faceMid(20)] })],
      sexualCtx(),
      T,
      'input',
      null,
      ALL_SURFACES,
    );
    expect(video.worst).toMatchObject({
      verdict: 'GRAY',
      ruleId: 'E7',
      cause: 'E4',
      shadowOnly: true,
    });
  });

  it('entrada: todos limpos = limpo, sem E7', () => {
    const video = decideVideoVerdict(
      [signals(), signals({ faces: [faceMid(40)] })],
      ctx(),
      T,
      'input',
      null,
      ALL_SURFACES,
    );
    expect(video.worst).toMatchObject({ verdict: 'CLEAN', ruleId: null });
    expect(video.worst.cause).toBeUndefined();
  });

  it('entrada sem quadros = indisponível', () => {
    const video = decideVideoVerdict(
      [],
      sexualCtx(),
      T,
      'input',
      null,
      ALL_SURFACES,
    );
    expect(video.worst).toMatchObject({
      verdict: 'UNAVAILABLE',
      ruleId: 'UNAVAILABLE',
    });
    expect(video.worst.restrictions).toEqual(ALL_TRUE);
    expect(video.worstFrame).toBeNull();
    expect(video.frames).toEqual([]);
  });

  it('saída: 1 quadro BLOCK leva o vídeo para a evidência (BLOCK vence HOLD)', () => {
    const video = decideVideoVerdict(
      [
        signals({
          faces: [faceMid(19)],
          moderation: [explicit(70)],
          frame: at(0, 0),
        }),
        signals({
          faces: [faceMid(17)],
          moderation: [explicit(70)],
          frame: at(1, 2000),
        }),
        signals({ faces: [faceMid(30)], frame: at(2, 4000) }),
      ],
      sexualCtx(),
      T,
      'output',
      CLEAN_ADULT_INPUT,
      ALL_SURFACES,
    );
    expect(video.stage).toBe('output');
    expect(video.worst).toMatchObject({
      verdict: 'BLOCK',
      ruleId: 'S2',
      disposition: 'evidence',
    });
    expect(video.worstFrame).toEqual(at(1, 2000));
  });

  it('saída: 1 quadro HOLD manda o vídeo para a quarentena', () => {
    const video = decideVideoVerdict(
      [
        signals({ faces: [faceMid(30)] }),
        signals({ moderation: [explicit(70)] }),
      ],
      ctx({ prompt: ADULT_TEXT }),
      T,
      'output',
      null,
      ALL_SURFACES,
    );
    expect(video.worst).toMatchObject({
      verdict: 'HOLD',
      ruleId: 'S7',
      disposition: 'hold',
    });
  });

  it('saída: 2 ou mais quadros em S3 num modelo sem censura = prioridade', () => {
    const frames = [
      signals({ faces: [faceMid(19)], moderation: [explicit(70)] }),
      signals({ faces: [faceMid(30)], moderation: [explicit(70)] }),
      signals({ faces: [faceMid(20)], moderation: [explicit(70)] }),
    ];
    const uncensored = decideVideoVerdict(
      frames,
      sexualCtx(),
      T,
      'output',
      CLEAN_ADULT_INPUT,
      ALL_SURFACES,
    );
    expect(uncensored.worst).toMatchObject({ verdict: 'HOLD', ruleId: 'S3' });
    expect(uncensored.priorityReview).toBe(true);
    const filtered = decideVideoVerdict(
      frames,
      ctx({ prompt: ADULT_TEXT }),
      T,
      'output',
      CLEAN_ADULT_INPUT,
      ALL_SURFACES,
    );
    expect(filtered.priorityReview).toBe(false);
    const single = decideVideoVerdict(
      frames.slice(0, 2),
      sexualCtx(),
      T,
      'output',
      CLEAN_ADULT_INPUT,
      ALL_SURFACES,
    );
    expect(single.priorityReview).toBe(false);
  });

  it('saída sem quadros = indisponível, nova tentativa', () => {
    const video = decideVideoVerdict(
      [],
      sexualCtx(),
      T,
      'output',
      null,
      ALL_SURFACES,
    );
    expect(video.worst).toMatchObject({
      verdict: 'UNAVAILABLE',
      ruleId: 'UNAVAILABLE',
      disposition: 'retry',
    });
  });
});

/* ------------------------------------------------------------------ juntar, resumo e status */

describe('combine*', () => {
  const decide = (input: ScanSignals, context: RequestContext = sexualCtx()) =>
    decideInputVerdict(input, context, T, ALL_SURFACES);

  it('entrada: vale o pior; restrições somadas; rosto mais jovem de todos', () => {
    const clean = decide(signals({ faces: [faceMid(40)] }));
    const gray = decide(signals({ faces: [faceMid(21)] }));
    const hold = decide(signals({ faces: [faceMid(17)] }));
    const combined = combineInputVerdicts([clean, gray, hold]);
    expect(combined).toMatchObject({
      verdict: 'HOLD',
      ruleId: 'E3a',
      strength: 'MEDIUM',
    });
    expect(combined.restrictions).toEqual(ALL_TRUE);
    expect(combined.youngestFace?.ageMid).toBe(17);
  });

  it('entrada: mesma gravidade, vale a força maior', () => {
    const light = decide(signals({ faces: [face(5, 9)] }), ctx());
    const strong = decide(signals({ hashMatch: hash() }), ctx());
    expect(combineInputVerdicts([light, strong])).toMatchObject({
      ruleId: 'E1',
      strength: 'STRONG',
    });
    expect(combineInputVerdicts([strong, light])).toMatchObject({
      ruleId: 'E1',
      strength: 'STRONG',
    });
  });

  it('entrada: uma dúvida aperta o pedido todo; lista vazia = indisponível', () => {
    const clean = decide(signals());
    const gray = decide(
      signals({ faces: [faceMid(19)] }),
      sexualCtx({ hasUserMedia: false }),
    );
    const combined = combineInputVerdicts([clean, gray]);
    expect(combined.verdict).toBe('GRAY');
    expect(combined.restrictions).toEqual({
      ...ALL_TRUE,
      requireConsent: false,
    });
    expect(combineInputVerdicts([])).toMatchObject({
      verdict: 'UNAVAILABLE',
      ruleId: 'UNAVAILABLE',
    });
  });

  it('saída: vale o pior; lista vazia = nova tentativa', () => {
    const promote = decideOutputVerdict(
      signals({ faces: [faceMid(35)] }),
      sexualCtx(),
      T,
      null,
      ALL_SURFACES,
    );
    const hold = decideOutputVerdict(
      signals({ faces: [faceMid(19)], moderation: [explicit(70)] }),
      sexualCtx(),
      T,
      null,
      ALL_SURFACES,
    );
    const block = decideOutputVerdict(
      signals({ faces: [face(5, 12)], moderation: [explicit(70)] }),
      sexualCtx(),
      T,
      null,
      ALL_SURFACES,
    );
    const combined = combineOutputVerdicts([promote, hold, block]);
    expect(combined).toMatchObject({
      verdict: 'BLOCK',
      ruleId: 'S1',
      disposition: 'evidence',
    });
    expect(combined.youngestFace?.ageHigh).toBe(12);
    expect(combineOutputVerdicts([])).toMatchObject({
      verdict: 'UNAVAILABLE',
      disposition: 'retry',
    });
  });
});

describe('vereditos de indisponível', () => {
  it('entrada: nunca limpo, todas as restrições', () => {
    expect(unavailableInputVerdict('rekognition fora')).toEqual({
      verdict: 'UNAVAILABLE',
      ruleId: 'UNAVAILABLE',
      strength: 'NONE',
      evidence: 'none',
      addToBlocklist: false,
      reason: 'rekognition fora',
      restrictions: ALL_TRUE,
      youngestFace: null,
      shadowOnly: false,
    });
  });

  it('saída: nova tentativa', () => {
    expect(unavailableOutputVerdict('rekognition fora')).toMatchObject({
      verdict: 'UNAVAILABLE',
      ruleId: 'UNAVAILABLE',
      disposition: 'retry',
      evidence: 'none',
      addToBlocklist: false,
      shadowOnly: false,
    });
  });
});

describe('summarizeInput', () => {
  it('rosto mais jovem de todas as mídias e o veredito juntado', () => {
    const media = [signals(), signals({ faces: [faceMid(30), faceMid(25)] })];
    const verdict = combineInputVerdicts(
      media.map((item) =>
        decideInputVerdict(item, sexualCtx(), T, ALL_SURFACES),
      ),
    );
    expect(summarizeInput(media, verdict)).toEqual({
      verdict: 'CLEAN',
      hadFace: true,
      youngestAgeMid: 25,
    });
  });

  it('pedido sem mídia', () => {
    expect(summarizeInput([], null)).toEqual({
      verdict: null,
      hadFace: false,
      youngestAgeMid: null,
    });
  });
});

describe('aggregatePreflightStatus', () => {
  const row = (stage: ScanStage, verdict: ScanVerdict) => ({ stage, verdict });
  const both = { image: true, text: true };

  it.each<
    [
      string,
      Array<{ stage: ScanStage; verdict: ScanVerdict }>,
      { image: boolean; text: boolean },
      string,
    ]
  >([
    ['nenhuma linha', [], both, 'unavailable'],
    [
      'nenhuma linha e nada esperado',
      [],
      { image: false, text: false },
      'unavailable',
    ],
    [
      'imagem e texto limpos',
      [row('INPUT', 'CLEAN'), row('TEXT', 'CLEAN')],
      both,
      'clean',
    ],
    [
      'quadros e texto limpos',
      [
        row('INPUT_FRAME', 'CLEAN'),
        row('INPUT_FRAME', 'CLEAN'),
        row('TEXT', 'CLEAN'),
      ],
      both,
      'clean',
    ],
    ['faltou o texto esperado', [row('INPUT', 'CLEAN')], both, 'unavailable'],
    ['faltou a imagem esperada', [row('TEXT', 'CLEAN')], both, 'unavailable'],
    [
      'só texto, sem imagem esperada',
      [row('TEXT', 'CLEAN')],
      { image: false, text: true },
      'clean',
    ],
    [
      'HOLD numa mídia',
      [row('INPUT', 'HOLD'), row('TEXT', 'CLEAN')],
      both,
      'flagged',
    ],
    [
      'BLOCK num quadro, mesmo faltando o texto',
      [row('INPUT_FRAME', 'BLOCK')],
      both,
      'flagged',
    ],
    [
      'BLOCK do texto',
      [row('INPUT', 'CLEAN'), row('TEXT', 'BLOCK')],
      both,
      'flagged',
    ],
    [
      'indisponível numa mídia',
      [row('INPUT', 'UNAVAILABLE'), row('TEXT', 'CLEAN')],
      both,
      'unavailable',
    ],
    [
      'dúvida e indisponível',
      [row('INPUT', 'GRAY'), row('TEXT', 'UNAVAILABLE')],
      both,
      'unavailable',
    ],
    ['dúvida', [row('INPUT', 'GRAY'), row('TEXT', 'CLEAN')], both, 'gray'],
    [
      'resultado não conta',
      [
        row('INPUT', 'CLEAN'),
        row('TEXT', 'CLEAN'),
        row('OUTPUT', 'BLOCK'),
        row('OUTPUT_FRAME', 'HOLD'),
      ],
      both,
      'clean',
    ],
    [
      'só resultado = sem preflight',
      [row('OUTPUT', 'CLEAN')],
      { image: false, text: false },
      'unavailable',
    ],
  ])('%s', (_name, scans, expect_, status) => {
    expect(aggregatePreflightStatus(scans, expect_)).toBe(status);
  });
});

describe('toScanScores', () => {
  it('sem caixa do rosto, sem rótulo fora das regras, sem moderação abaixo de 50', () => {
    const input = signals({
      faces: [
        faceMid(27, { box: { left: 0.3, top: 0.2, width: 0.1, height: 0.1 } }),
      ],
      labels: [
        label('Person', 98, 2),
        label('Girl', 97),
        label('Car', 90),
        label('Child', 60),
      ],
      moderation: [
        explicit(72),
        swimwear(49.9),
        moderation('Suggestive', 50, null, 1),
      ],
      hashMatch: hash({ blockId: 'block-secreto' }),
      frame: at(3, 6000),
    });
    const scores = toScanScores(input, {
      surface: 'adult',
      sexual: true,
      reason: 'motivo interno',
    });
    expect(scores.faces).toEqual([
      { ageLow: 16, ageHigh: 30, ageMid: 27, confidence: 99, fromCrop: false },
    ]);
    expect(scores.labels?.map((item) => item.name)).toEqual([
      'Person',
      'Child',
    ]);
    expect(scores.moderation?.map((item) => item.name)).toEqual([
      'Explicit Nudity',
      'Suggestive',
    ]);
    expect(scores.nudity).toBe(72);
    expect(scores.suggestive).toBe(49.9);
    expect(scores.hashMatch).toEqual({
      source: 'blocklist',
      matcher: 'phash',
      distance: 3,
    });
    expect(scores.frame).toEqual(at(3, 6000));
    expect(scores).toMatchObject({
      surface: 'adult',
      sexual: true,
      reason: 'motivo interno',
      illustrated: false,
      cropPassRan: false,
    });
    const serialized = JSON.stringify(scores);
    expect(serialized).not.toContain('box');
    expect(serialized).not.toContain('block-secreto');
  });

  it('extras ausentes não viram campo', () => {
    const scores = toScanScores(signals(), {});
    expect(scores).not.toHaveProperty('surface');
    expect(scores).not.toHaveProperty('hashMatch');
    expect(scores).not.toHaveProperty('frame');
    expect(scores.faces).toEqual([]);
  });
});

/* ------------------------------------------------------------------ limites do env e pureza */

describe('limites vindos do env', () => {
  const custom = loadImageSafetyConfig(
    (key) =>
      ({
        SAFETY_AGE_GRAY_MAX: '25',
        SAFETY_OUTPUT_REVIEW_AGE_MAX: '22',
        SAFETY_NUDITY_MIN: '70',
        SAFETY_CHILD_LABEL_MIN: '90',
      })[key],
  );
  const C = custom.config.thresholds;

  it('as regras usam os limites recebidos, não os padrões', () => {
    expect(custom.warnings).toEqual([]);
    // zona de dúvida até 25
    expect(
      decideInputVerdict(
        signals({ faces: [faceMid(24)] }),
        sexualCtx(),
        C,
        ALL_SURFACES,
      ),
    ).toMatchObject({ verdict: 'GRAY', ruleId: 'E4' });
    // rótulo de criança só a partir de 90
    expect(
      decideInputVerdict(
        signals({ labels: [label('Child', 89.9)] }),
        ctx(),
        C,
        ALL_SURFACES,
      ),
    ).toMatchObject({ verdict: 'CLEAN', ruleId: null });
    // nudez só a partir de 70
    expect(
      decideOutputVerdict(
        signals({ faces: [faceMid(19)], moderation: [explicit(65)] }),
        sexualCtx(),
        C,
        CLEAN_ADULT_INPUT,
        ALL_SURFACES,
      ),
    ).toMatchObject({ verdict: 'CLEAN', ruleId: null });
    // revisão da S3 até 22
    expect(
      decideOutputVerdict(
        signals({ faces: [faceMid(21.5)], moderation: [explicit(80)] }),
        sexualCtx(),
        C,
        CLEAN_ADULT_INPUT,
        ALL_SURFACES,
      ),
    ).toMatchObject({ verdict: 'HOLD', ruleId: 'S3' });
    // herança da S7 só acima da zona de dúvida (25)
    expect(
      decideOutputVerdict(
        signals({ moderation: [explicit(80)] }),
        sexualCtx(),
        C,
        { verdict: 'CLEAN', hadFace: true, youngestAgeMid: 24 },
        ALL_SURFACES,
      ),
    ).toMatchObject({ verdict: 'HOLD', ruleId: 'S7' });
    // pedido sexual pela nudez da mídia também segue o limite
    expect(
      isSexualRequest(ctx(), signals({ moderation: [explicit(65)] }), C),
    ).toBe(false);
  });
});

describe('funções puras', () => {
  function deepFreeze<V>(value: V): V {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const inner of Object.values(value as object)) deepFreeze(inner);
    }
    return value;
  }

  it('não alteram os sinais nem o contexto, e repetem o mesmo veredito', () => {
    const frames = deepFreeze([
      signals({ faces: [faceMid(30), face(15, 31)], frame: at(0, 0) }),
      signals({
        faces: [faceMid(17)],
        labels: [label('Person', 99, 2)],
        moderation: [explicit(70), swimwear(80)],
        hashMatch: hash(),
        stylized: judged(true),
        frame: at(1, 2000),
      }),
    ]);
    const context = deepFreeze(sexualCtx());
    const input = deepFreeze({ ...CLEAN_ADULT_INPUT });
    const run = () => ({
      input: frames.map((item) =>
        decideInputVerdict(item, context, T, ALL_SURFACES),
      ),
      output: frames.map((item) =>
        decideOutputVerdict(item, context, T, input, ALL_SURFACES),
      ),
      inputVideo: decideVideoVerdict(
        frames,
        context,
        T,
        'input',
        null,
        ALL_SURFACES,
      ),
      outputVideo: decideVideoVerdict(
        frames,
        context,
        T,
        'output',
        input,
        ALL_SURFACES,
      ),
      summary: summarizeInput(frames, null),
      scores: frames.map((item) => toScanScores(item, {})),
    });
    const first = run();
    expect(run()).toEqual(first);
    expect(combineInputVerdicts(deepFreeze(first.input))).toMatchObject({
      verdict: 'BLOCK',
      ruleId: 'E1',
    });
    expect(combineOutputVerdicts(deepFreeze(first.output))).toMatchObject({
      verdict: 'BLOCK',
      ruleId: 'S6',
    });
  });
});

/* ------------------------------------------------------------------ sombra × isRuleEnforced */

describe('marca de sombra', () => {
  const shadowConfig = {
    imageMode: 'shadow' as const,
    textMode: 'off' as const,
    enforceStrong: true,
  };
  const imageRules: Array<InputRuleId | OutputRuleId> = [
    'E1',
    'E2',
    'E3a',
    'E3b',
    'E4',
    'E5',
    'E6',
    'S1',
    'S2',
    'S2b',
    'S3',
    'S4',
    'S5',
    'S6',
    'S7',
  ];

  it.each(imageRules)(
    '%s: sombra = não age na sombra com as fortes ligadas',
    (ruleId) => {
      for (const strength of ['STRONG', 'MEDIUM', 'NONE'] as const) {
        expect(isShadowImageRule(ruleId, undefined, strength)).toBe(
          !isRuleEnforced({ layer: 'image', ruleId, strength }, shadowConfig),
        );
      }
      expect(isShadowImageRule(ruleId)).toBe(!DAY_ONE_IMAGE_RULES.has(ruleId));
    },
  );

  it('E5 julgada (força média) age já na sombra; sem juiz (NONE) só registra', () => {
    expect(isShadowImageRule('E5', undefined, 'MEDIUM')).toBe(false);
    expect(isShadowImageRule('E5', undefined, 'NONE')).toBe(true);
    expect(isShadowImageRule('E7', 'E5', 'MEDIUM')).toBe(false);
    expect(isShadowImageRule('E7', 'E5', 'NONE')).toBe(true);
  });

  it('as de sombra são E3b, E4, E5 e S3; E7 segue a causa; CLEAN e UNAVAILABLE não', () => {
    expect(imageRules.filter((ruleId) => isShadowImageRule(ruleId))).toEqual([
      'E3b',
      'E4',
      'E5',
      'S3',
    ]);
    expect(isShadowImageRule('E7', 'E4')).toBe(true);
    expect(isShadowImageRule('E7', 'E3a')).toBe(false);
    expect(isShadowImageRule('E7')).toBe(false);
    expect(isShadowImageRule(null)).toBe(false);
    expect(isShadowImageRule('UNAVAILABLE')).toBe(false);
  });
});
