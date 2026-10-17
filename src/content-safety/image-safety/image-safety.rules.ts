import { hasAdultTerms } from '../adult-only-rules';
import { isUncensoredModel } from '../content-safety.interceptor';
import { mentionsMinorRemoval } from '../minor-guard';
import type { PreflightStatus } from '../preflight-status';
import {
  CHILD_LABELS,
  isDayOneImageRule,
  loadImageSafetyConfig,
  NEVER_CHILD_LABELS,
  NON_EXPLICIT_NUDITY_LABELS,
  NUDITY_LABELS,
  PERSON_LABEL_MIN_CONFIDENCE,
  PERSON_LABELS,
  SEXUAL_TOOLS,
  SUGGESTIVE_LABELS,
  type SafetyThresholds,
} from './image-safety.config';
import {
  STRENGTH_RANK,
  VERDICT_SEVERITY,
  type EvidenceAction,
  type FaceSignal,
  type FramePosition,
  type HashMatch,
  type InputRuleId,
  type InputSummary,
  type InputVerdict,
  type LabelSignal,
  type ModerationSignal,
  type OutputDisposition,
  type OutputRuleId,
  type OutputVerdict,
  type RequestContext,
  type RuleId,
  type SafetySurface,
  type ScanScores,
  type ScanSignals,
  type ScanStage,
  type ScanVerdict,
  type Strength,
  type VerdictRestrictions,
  type VideoVerdict,
} from './types';

/**
 * Regras de decisão da segurança de imagem (seção 3 do documento de decisão): a foto/vídeo de entrada (E1 a E7) e o
 * resultado (S1 a S7). Funções puras: sem rede, sem banco, sem Nest. Recebem os sinais já lidos (scanner, hash, juiz)
 * e o contexto montado no servidor, e devolvem o veredito com a regra, a força e o que fazer com o arquivo.
 *
 * Definições que valem para todas as regras:
 *  - ponto médio = (ageLow + ageHigh) / 2 (FaceSignal.ageMid); Low e High só nos cortes extremos (High ≤ 13, Low ≤ 15);
 *  - o rosto que decide é o mais jovem (inclusive os da passada recortada);
 *  - "Girl" e "Boy" nunca contam como criança (o Rekognition usa os dois para adultos);
 *  - nudez = família Explicit com SAFETY_NUDITY_MIN ou mais; nudez parcial ou implícita é da S2b, não de S1/S2/S3/S7;
 *  - pedido sexual = modelo sem censura, ferramenta sexual, texto adulto pela trava, classificador ou nudez na mídia.
 * Se uma regra age ou só registra é decisão de isRuleEnforced (image-safety.config.ts); aqui só se marca `shadowOnly`.
 */

/* ------------------------------------------------------------------ vereditos com a marca de sombra */

/**
 * Veredito com a marca de sombra: `shadowOnly` = a regra que decidiu só registra até sair da sombra (E3b, E4, a E5 sem
 * juiz e S3, fora das regras do 1º dia; a E5 julgada age). Na E7 vale a regra do pior quadro. A ação de verdade
 * continua com isRuleEnforced.
 */
export type RuledInputVerdict = InputVerdict & { shadowOnly: boolean };
export type RuledOutputVerdict = OutputVerdict & { shadowOnly: boolean };

/**
 * A regra é de sombra (fora das regras do 1º dia)? CLEAN (sem regra) e UNAVAILABLE nunca são. A força vale para a E5:
 * julgada (força média) age, sem juiz (força NONE) só registra.
 */
export function isShadowImageRule(
  ruleId: RuleId | null,
  cause?: RuleId,
  strength: Strength = 'NONE',
): boolean {
  if (!ruleId) return false;
  const effective = ruleId === 'E7' && cause ? cause : ruleId;
  return !isDayOneImageRule(effective, strength);
}

const NO_RESTRICTIONS: VerdictRestrictions = Object.freeze({
  requireConsent: false,
  noUncensoredFallback: false,
  noPromptRewrite: false,
  fullOutputCheck: false,
});

const ALL_RESTRICTIONS: VerdictRestrictions = Object.freeze({
  requireConsent: true,
  noUncensoredFallback: true,
  noPromptRewrite: true,
  fullOutputCheck: true,
});

/** Limites padrão (env vazio), para quem chama isSexualRequest com sinais e sem limites. Lidos uma vez. */
let defaultThresholds: SafetyThresholds | null = null;
function thresholdsOrDefault(t?: SafetyThresholds): SafetyThresholds {
  if (t) return t;
  defaultThresholds ??= loadImageSafetyConfig(() => undefined).config
    .thresholds;
  return defaultThresholds;
}

/** Idade curta para o motivo interno ("16,5"). */
function age(value: number): string {
  return String(Math.round(value * 10) / 10).replace('.', ',');
}

/* ------------------------------------------------------------------ leitura dos sinais */

/** O rosto mais jovem pelo ponto médio; empate → o de menor ageLow. Sem rosto → null. */
export function youngestFace(faces: readonly FaceSignal[]): FaceSignal | null {
  let youngest: FaceSignal | null = null;
  for (const face of faces) {
    if (
      !youngest ||
      face.ageMid < youngest.ageMid ||
      (face.ageMid === youngest.ageMid && face.ageLow < youngest.ageLow)
    ) {
      youngest = face;
    }
  }
  return youngest;
}

/** Maior confiança entre os rótulos de criança (Baby, Toddler, Child, Kid). "Girl" e "Boy" nunca contam. */
export function childLabelConfidence(labels: readonly LabelSignal[]): number {
  let best = 0;
  for (const label of labels) {
    if (NEVER_CHILD_LABELS.has(label.name) || !CHILD_LABELS.has(label.name)) {
      continue;
    }
    best = Math.max(best, label.confidence);
  }
  return best;
}

/** Algum rosto com ageHigh até 13, ou rótulo de criança com SAFETY_CHILD_LABEL_MIN ou mais (E2, S1, S4). */
export function isChildEvident(s: ScanSignals, t: SafetyThresholds): boolean {
  return (
    s.faces.some((face) => face.ageHigh <= t.childFaceAgeHighMax) ||
    childLabelConfidence(s.labels) >= t.childLabelMin
  );
}

/** Maior confiança de moderação do conjunto: o rótulo ou o pai dele (filhos do nível 2 contam como o pai). */
function moderationScore(
  moderation: readonly ModerationSignal[],
  names: ReadonlySet<string>,
): number {
  let best = 0;
  for (const signal of moderation) {
    if (
      names.has(signal.name) ||
      (signal.parent !== null && names.has(signal.parent))
    ) {
      best = Math.max(best, signal.confidence);
    }
  }
  return best;
}

/** Nudez explícita (família Explicit); 0 sem rótulo. */
export function nudityScore(m: readonly ModerationSignal[]): number {
  return moderationScore(m, NUDITY_LABELS);
}

/** Nudez parcial ou implícita (conta para pedido sexual, não para S1/S2/S3/S7). */
export function nonExplicitNudityScore(m: readonly ModerationSignal[]): number {
  return moderationScore(m, NON_EXPLICIT_NUDITY_LABELS);
}

/** Rótulos da S2b: lingerie, nudez parcial ou implícita, partes íntimas cobertas, beijo. */
export function suggestiveScore(m: readonly ModerationSignal[]): number {
  return moderationScore(m, SUGGESTIVE_LABELS);
}

/** Pessoa (rótulo de PERSON_LABELS com 70 ou mais) e nenhum rosto, mesmo depois da passada recortada. */
export function hasPersonWithoutFace(s: ScanSignals): boolean {
  return (
    s.faces.length === 0 &&
    s.labels.some(
      (label) =>
        PERSON_LABELS.has(label.name) &&
        label.confidence >= PERSON_LABEL_MIN_CONFIDENCE,
    )
  );
}

/** Nudez explícita ou não explícita com o mínimo na mídia (definição de pedido sexual). */
function mediaShowsNudity(s: ScanSignals, t: SafetyThresholds): boolean {
  return (
    nudityScore(s.moderation) >= t.nudityMin ||
    nonExplicitNudityScore(s.moderation) >= t.nudityMin
  );
}

/* ------------------------------------------------------------------ pedido sexual e superfície */

/**
 * Pedido sexual: modelo sem censura; ferramenta sexual por natureza (despir, troca de rosto Unlocked), mesmo sem texto;
 * texto adulto pela trava no prompt FINAL montado no servidor (o negativo nunca conta); classificador de texto; nudez
 * de 60 ou mais numa mídia de entrada (pista da orquestração) ou nos `signals` passados.
 */
export function isSexualRequest(
  ctx: Omit<RequestContext, 'surface'>,
  signals?: ScanSignals,
  t?: SafetyThresholds,
): boolean {
  if (isUncensoredModel(ctx.model)) return true;
  if (SEXUAL_TOOLS.has(ctx.tool)) return true;
  if (ctx.sexual.classifier === true || ctx.sexual.inputNudity === true) {
    return true;
  }
  if (signals && mediaShowsNudity(signals, thresholdsOrDefault(t))) return true;
  return typeof ctx.prompt === 'string' && hasAdultTerms(ctx.prompt);
}

/**
 * Lado do produto deduzido no servidor (decisão 13, opção b): `adult` com modelo sem censura, ferramenta sexual ou
 * pedido sexual; `common` no resto. Nunca vem de campo do site. A marca não é conhecida no servidor: "criança barra em
 * qualquer pedido" entra pela env SAFETY_CHILD_BLOCK_ALL_SURFACES (childBlockAllSurfaces).
 */
export function surfaceOf(
  ctx: Omit<RequestContext, 'surface'>,
  t?: SafetyThresholds,
): SafetySurface {
  return isSexualRequest(ctx, undefined, t) ? 'adult' : 'common';
}

/* ------------------------------------------------------------------ entrada (E1 a E7) */

export interface RuleOptions {
  /** SAFETY_CHILD_BLOCK_ALL_SURFACES: criança barra em qualquer pedido (padrão) ou só no lado adulto (opção b) */
  childBlockAllSurfaces: boolean;
}

/** Acerto de hash entra de novo na lista quando é variante (distância > 0, desconhecida ou abuso conhecido). */
function isNewHashVariant(match: HashMatch): boolean {
  return !(match.source === 'blocklist' && match.distance === 0);
}

function describeHash(match: HashMatch): string {
  if (match.source === 'known-csam') {
    return `hash de abuso conhecido (${match.matcher})`;
  }
  return match.distance === null
    ? 'hash na lista própria'
    : `hash na lista própria (distância ${match.distance})`;
}

function inputVerdict(
  fields: {
    verdict: ScanVerdict;
    ruleId: InputRuleId | 'UNAVAILABLE' | null;
    strength: Strength;
    evidence: EvidenceAction;
    addToBlocklist: boolean;
    reason: string;
    cause?: InputRuleId;
  },
  restrictions: VerdictRestrictions,
  youngest: FaceSignal | null,
): RuledInputVerdict {
  const verdict: RuledInputVerdict = {
    verdict: fields.verdict,
    ruleId: fields.ruleId,
    strength: fields.strength,
    evidence: fields.evidence,
    addToBlocklist: fields.addToBlocklist,
    reason: fields.reason,
    restrictions: { ...restrictions },
    youngestFace: youngest,
    shadowOnly: isShadowImageRule(fields.ruleId, fields.cause, fields.strength),
  };
  if (fields.cause) verdict.cause = fields.cause;
  return verdict;
}

/** Restrições de cada veredito: limpo nenhuma; dúvida aperta o desvio e a saída; o resto, todas. */
function restrictionsFor(
  verdict: ScanVerdict,
  ctx: Pick<RequestContext, 'hasUserMedia'>,
  sexual: boolean,
): VerdictRestrictions {
  if (verdict === 'CLEAN') return NO_RESTRICTIONS;
  if (verdict === 'GRAY') {
    return {
      requireConsent: ctx.hasUserMedia && sexual,
      noUncensoredFallback: true,
      noPromptRewrite: true,
      fullOutputCheck: true,
    };
  }
  return ALL_RESTRICTIONS;
}

/** Regras E1 a E6 sobre UMA imagem (ou um quadro), com o pedido sexual já decidido. A 1ª que casar decide. */
function decideInputCore(
  s: ScanSignals,
  ctx: RequestContext,
  t: SafetyThresholds,
  opts: RuleOptions,
  sexual: boolean,
): RuledInputVerdict {
  const youngest = youngestFace(s.faces);
  const blockAnySurface =
    opts.childBlockAllSurfaces || sexual || ctx.surface === 'adult';
  const make = (
    verdict: ScanVerdict,
    ruleId: InputRuleId | null,
    strength: Strength,
    evidence: EvidenceAction,
    addToBlocklist: boolean,
    reason: string,
  ) =>
    inputVerdict(
      { verdict, ruleId, strength, evidence, addToBlocklist, reason },
      restrictionsFor(verdict, ctx, sexual),
      youngest,
    );
  const requestKind = sexual ? 'pedido sexual' : 'pedido não sexual';

  // E1: hash da lista própria ou de abuso conhecido
  if (s.hashMatch) {
    return make(
      'BLOCK',
      'E1',
      'STRONG',
      'keep',
      isNewHashVariant(s.hashMatch),
      describeHash(s.hashMatch),
    );
  }

  // E2: criança evidente (rosto até 13 ou rótulo de criança)
  if (isChildEvident(s, t)) {
    const reason = `criança evidente (${describeChild(s, t)}) em ${requestKind}`;
    if (sexual) return make('BLOCK', 'E2', 'STRONG', 'keep', true, reason);
    if (blockAnySurface) {
      return make('BLOCK', 'E2', 'LIGHT', 'delete', false, reason);
    }
    return make('GRAY', 'E2', 'NONE', 'none', false, `${reason}, lado comum`);
  }

  const youngestMid = youngest ? youngest.ageMid : null;
  const minorFace = youngestMid !== null && youngestMid < t.adultAge;

  if (sexual) {
    // E6: pedido de tirar a criança + rosto de provável menor
    if (minorFace && mentionsMinorRemoval(ctx.prompt)) {
      return make(
        'BLOCK',
        'E6',
        'STRONG',
        'keep',
        true,
        `pedido de remover criança com rosto mais jovem ${age(youngestMid)} em pedido sexual`,
      );
    }
    // E3a: provável menor em pedido sexual → segura sem gerar
    if (minorFace) {
      return make(
        'HOLD',
        'E3a',
        'MEDIUM',
        'keep',
        false,
        `rosto mais jovem ${age(youngestMid)} em pedido sexual`,
      );
    }
    // E5: desenhado ou pessoa sem rosto → juiz de estilizado
    if (s.illustrated || hasPersonWithoutFace(s)) {
      const what = s.illustrated ? 'imagem desenhada' : 'pessoa sem rosto';
      if (s.stylized.status === 'judged') {
        if (s.stylized.childlike) {
          return make(
            'BLOCK',
            'E5',
            'MEDIUM',
            'keep',
            true,
            `${what} com traço infantil pelo juiz em pedido sexual`,
          );
        }
      } else {
        return make(
          'GRAY',
          'E5',
          'NONE',
          'none',
          false,
          `${what} em pedido sexual sem juiz de estilizado`,
        );
      }
    }
    // E4: zona de dúvida
    if (youngestMid !== null && youngestMid < t.ageGrayMax) {
      return make(
        'GRAY',
        'E4',
        'NONE',
        'none',
        false,
        `rosto mais jovem ${age(youngestMid)} na zona de dúvida em pedido sexual`,
      );
    }
  } else if (minorFace) {
    // E3b: provável menor em pedido não sexual (sem ponto)
    const reason = `rosto mais jovem ${age(youngestMid)} em pedido não sexual`;
    if (blockAnySurface) {
      return make('BLOCK', 'E3b', 'LIGHT', 'delete', false, reason);
    }
    return make('GRAY', 'E3b', 'NONE', 'none', false, `${reason}, lado comum`);
  }

  // E3b (só registro): rosto mais jovem com Low até 15 e ponto médio adulto (corte extremo, faixa larga)
  if (
    youngest &&
    youngest.ageLow <= t.teenFaceAgeLowMax &&
    youngest.ageMid >= t.adultAge
  ) {
    return make(
      'GRAY',
      'E3b',
      'NONE',
      'none',
      false,
      `rosto mais jovem com idade mínima ${age(youngest.ageLow)} e ponto médio ${age(youngest.ageMid)} em ${requestKind}`,
    );
  }

  return make('CLEAN', null, 'NONE', 'none', false, 'nenhuma regra disparou');
}

function describeChild(s: ScanSignals, t: SafetyThresholds): string {
  const childFace = s.faces.find(
    (face) => face.ageHigh <= t.childFaceAgeHighMax,
  );
  if (childFace) return `rosto com idade máxima ${age(childFace.ageHigh)}`;
  return `rótulo de criança ${age(childLabelConfidence(s.labels))}`;
}

/**
 * Veredito de UMA mídia de entrada (foto, quadro de GIF). Ordem: E1, E2, E6, E3a, E5, E4, E3b; nada casou = CLEAN.
 * O pedido sexual considera também a nudez desta mídia. Vídeo de entrada (E7) vai por decideVideoVerdict.
 */
export function decideInputVerdict(
  s: ScanSignals,
  ctx: RequestContext,
  t: SafetyThresholds,
  opts: RuleOptions,
): RuledInputVerdict {
  return decideInputCore(s, ctx, t, opts, isSexualRequest(ctx, s, t));
}

/* ------------------------------------------------------------------ resultado (S1 a S7) */

const DISPOSITION_BY_VERDICT: Readonly<Record<ScanVerdict, OutputDisposition>> =
  {
    CLEAN: 'promote',
    GRAY: 'promote',
    HOLD: 'hold',
    BLOCK: 'evidence',
    UNAVAILABLE: 'retry',
  };

function outputVerdict(
  fields: {
    verdict: ScanVerdict;
    ruleId: OutputRuleId | 'UNAVAILABLE' | null;
    strength: Strength;
    addToBlocklist?: boolean;
    reason: string;
  },
  youngest: FaceSignal | null,
): RuledOutputVerdict {
  const kept = fields.verdict === 'BLOCK' || fields.verdict === 'HOLD';
  return {
    verdict: fields.verdict,
    ruleId: fields.ruleId,
    strength: fields.strength,
    evidence: kept ? 'keep' : 'none',
    // HOLD só entra na lista na confirmação do revisor
    addToBlocklist:
      fields.verdict === 'BLOCK' ? (fields.addToBlocklist ?? true) : false,
    reason: fields.reason,
    disposition: DISPOSITION_BY_VERDICT[fields.verdict],
    youngestFace: youngest,
    shadowOnly: isShadowImageRule(fields.ruleId, undefined, fields.strength),
  };
}

/** Regras S1 a S7 sobre UMA imagem de resultado (ou um quadro), com o pedido sexual já decidido. */
function decideOutputCore(
  s: ScanSignals,
  ctx: RequestContext,
  t: SafetyThresholds,
  input: InputSummary | null,
  opts: RuleOptions,
  sexual: boolean,
): RuledOutputVerdict {
  const youngest = youngestFace(s.faces);
  const youngestMid = youngest ? youngest.ageMid : null;
  const nudity = nudityScore(s.moderation) >= t.nudityMin;
  const childEvident = isChildEvident(s, t);
  const make = (
    verdict: ScanVerdict,
    ruleId: OutputRuleId | null,
    strength: Strength,
    reason: string,
    addToBlocklist?: boolean,
  ) =>
    outputVerdict(
      { verdict, ruleId, strength, reason, addToBlocklist },
      youngest,
    );

  // S6: lista de bloqueio própria (ou abuso conhecido)
  if (s.hashMatch) {
    return make(
      'BLOCK',
      'S6',
      'STRONG',
      describeHash(s.hashMatch),
      isNewHashVariant(s.hashMatch),
    );
  }
  if (nudity) {
    // S1: nudez com criança evidente
    if (childEvident) {
      return make(
        'BLOCK',
        'S1',
        'STRONG',
        `nudez com criança evidente (${describeChild(s, t)})`,
      );
    }
    // S2: nudez com provável menor
    if (youngestMid !== null && youngestMid < t.adultAge) {
      return make(
        'BLOCK',
        'S2',
        'STRONG',
        `nudez com rosto mais jovem ${age(youngestMid)}`,
      );
    }
    // S5: desenhado com nudez e traço infantil pelo juiz
    if (
      s.illustrated &&
      s.stylized.status === 'judged' &&
      s.stylized.childlike
    ) {
      return make(
        'BLOCK',
        'S5',
        'STRONG',
        'imagem desenhada com nudez e traço infantil pelo juiz',
      );
    }
  }
  // S2b: pedido sexual, provável menor e lingerie/nudez parcial/beijo
  if (
    sexual &&
    youngestMid !== null &&
    youngestMid < t.adultAge &&
    suggestiveScore(s.moderation) >= t.nudityMin
  ) {
    return make(
      'HOLD',
      'S2b',
      'MEDIUM',
      `rosto mais jovem ${age(youngestMid)} com conteúdo sugestivo em pedido sexual`,
    );
  }
  // S4: criança evidente sem nudez
  if (!nudity && childEvident) {
    const reason = `criança evidente no resultado (${describeChild(s, t)})`;
    if (opts.childBlockAllSurfaces || sexual || ctx.surface === 'adult') {
      return make('HOLD', 'S4', 'NONE', reason);
    }
    return make('GRAY', 'S4', 'NONE', `${reason}, lado comum`);
  }
  if (nudity) {
    // S3: nudez com rosto jovem adulto → quarentena
    if (
      youngestMid !== null &&
      youngestMid >= t.adultAge &&
      youngestMid < t.outputReviewAgeMax
    ) {
      return make(
        'HOLD',
        'S3',
        'NONE',
        `nudez com rosto mais jovem ${age(youngestMid)}`,
      );
    }
    // S7: nudez realista sem rosto (mesmo depois da passada recortada)
    if (!s.illustrated && s.faces.length === 0) {
      return decideS7(s, t, input, make);
    }
  }
  return make('CLEAN', null, 'NONE', 'nenhuma regra disparou');
}

function decideS7(
  s: ScanSignals,
  t: SafetyThresholds,
  input: InputSummary | null,
  make: (
    verdict: ScanVerdict,
    ruleId: OutputRuleId | null,
    strength: Strength,
    reason: string,
  ) => RuledOutputVerdict,
): RuledOutputVerdict {
  if (s.stylized.status === 'judged') {
    return s.stylized.childlike
      ? make(
          'HOLD',
          'S7',
          'MEDIUM',
          'nudez sem rosto com traço infantil pelo juiz',
        )
      : make('CLEAN', null, 'NONE', 'nudez sem rosto julgada adulta');
  }
  // sem juiz: herda a entrada só com rosto adulto acima da zona de dúvida e entrada limpa (nunca GRAY nem só texto)
  const inputAdultAge =
    input && input.verdict === 'CLEAN' && input.hadFace
      ? input.youngestAgeMid
      : null;
  if (inputAdultAge !== null && inputAdultAge >= t.ageGrayMax) {
    return make(
      'CLEAN',
      null,
      'NONE',
      `nudez sem rosto herdando a entrada limpa (rosto ${age(inputAdultAge)})`,
    );
  }
  return make(
    'HOLD',
    'S7',
    'NONE',
    'nudez sem rosto e sem entrada adulta limpa',
  );
}

/**
 * Veredito de UMA imagem de resultado (ou quadro). Ordem: S6, S1, S2, S5, S2b, S4, S3, S7; nada casou = CLEAN.
 * `input` é o resumo da entrada (herança da S7); null = pedido sem mídia.
 */
export function decideOutputVerdict(
  s: ScanSignals,
  ctx: RequestContext,
  t: SafetyThresholds,
  input: InputSummary | null,
  opts: RuleOptions,
): RuledOutputVerdict {
  return decideOutputCore(s, ctx, t, input, opts, isSexualRequest(ctx, s, t));
}

/* ------------------------------------------------------------------ vídeo (E7 e saída por quadro) */

function frameOf(s: ScanSignals, index: number): FramePosition {
  return s.frame ?? { index, timeMs: null };
}

/**
 * Vídeo: cada quadro pela régua da sua etapa; vale o pior quadro. O pedido sexual é do vídeo inteiro (nudez num quadro
 * vale para todos). Entrada: o pior quadro vira E7 com `cause` = regra do quadro (mesma força e evidência). Saída:
 * 1 quadro BLOCK = vídeo BLOCK, 1 quadro HOLD = vídeo HOLD; 2 ou mais quadros em S3 num modelo sem censura = revisão
 * com prioridade. Sem quadros = indisponível.
 */
export function decideVideoVerdict(
  frames: readonly ScanSignals[],
  ctx: RequestContext,
  t: SafetyThresholds,
  stage: 'input',
  input: null,
  opts: RuleOptions,
): VideoVerdict<RuledInputVerdict>;
export function decideVideoVerdict(
  frames: readonly ScanSignals[],
  ctx: RequestContext,
  t: SafetyThresholds,
  stage: 'output',
  input: InputSummary | null,
  opts: RuleOptions,
): VideoVerdict<RuledOutputVerdict>;
export function decideVideoVerdict(
  frames: readonly ScanSignals[],
  ctx: RequestContext,
  t: SafetyThresholds,
  stage: 'input' | 'output',
  input: InputSummary | null,
  opts: RuleOptions,
): VideoVerdict<RuledInputVerdict> | VideoVerdict<RuledOutputVerdict> {
  const sexual =
    isSexualRequest(ctx) || frames.some((frame) => mediaShowsNudity(frame, t));
  if (stage === 'input') {
    if (frames.length === 0) {
      return {
        stage,
        worst: unavailableInputVerdict('vídeo de entrada sem quadros'),
        worstFrame: null,
        frames: [],
        priorityReview: false,
      };
    }
    const perFrame = frames.map((signals, index) => ({
      frame: frameOf(signals, index),
      verdict: decideInputCore(signals, ctx, t, opts, sexual),
    }));
    const worstIndex = worstIndexOf(perFrame.map((item) => item.verdict));
    const worstFrame = perFrame[worstIndex];
    return {
      stage,
      worst: asE7(
        combineInputVerdicts(perFrame.map((item) => item.verdict)),
        worstFrame.frame,
      ),
      worstFrame: worstFrame.frame,
      frames: perFrame,
      priorityReview: false,
    };
  }
  if (frames.length === 0) {
    return {
      stage,
      worst: unavailableOutputVerdict('vídeo de resultado sem quadros'),
      worstFrame: null,
      frames: [],
      priorityReview: false,
    };
  }
  const perFrame = frames.map((signals, index) => ({
    frame: frameOf(signals, index),
    verdict: decideOutputCore(signals, ctx, t, input, opts, sexual),
  }));
  const worstIndex = worstIndexOf(perFrame.map((item) => item.verdict));
  const reviewFrames = perFrame.filter(
    (item) => item.verdict.ruleId === 'S3',
  ).length;
  return {
    stage,
    worst: combineOutputVerdicts(perFrame.map((item) => item.verdict)),
    worstFrame: perFrame[worstIndex].frame,
    frames: perFrame,
    priorityReview: reviewFrames >= 2 && isUncensoredModel(ctx.model),
  };
}

/** O veredito do pior quadro vira E7 (a regra do quadro fica em `cause`); CLEAN continua CLEAN. */
function asE7(
  worst: RuledInputVerdict,
  frame: FramePosition,
): RuledInputVerdict {
  if (!worst.ruleId || worst.ruleId === 'UNAVAILABLE') return worst;
  const cause = worst.ruleId === 'E7' ? worst.cause : worst.ruleId;
  return {
    ...worst,
    ruleId: 'E7',
    cause,
    reason: `quadro ${frame.index}: ${worst.reason}`,
    shadowOnly: isShadowImageRule('E7', cause, worst.strength),
  };
}

/* ------------------------------------------------------------------ juntar vereditos */

/** Índice do pior veredito: maior gravidade; empate → maior força; empate → o primeiro. */
function worstIndexOf(
  verdicts: ReadonlyArray<Pick<InputVerdict, 'verdict' | 'strength'>>,
): number {
  let worst = 0;
  for (let index = 1; index < verdicts.length; index++) {
    const current = verdicts[index];
    const best = verdicts[worst];
    const severity =
      VERDICT_SEVERITY[current.verdict] - VERDICT_SEVERITY[best.verdict];
    if (
      severity > 0 ||
      (severity === 0 &&
        STRENGTH_RANK[current.strength] > STRENGTH_RANK[best.strength])
    ) {
      worst = index;
    }
  }
  return worst;
}

function youngestOf(
  faces: ReadonlyArray<FaceSignal | null>,
): FaceSignal | null {
  return youngestFace(faces.filter((face): face is FaceSignal => !!face));
}

/**
 * Junta os vereditos de várias mídias (ou quadros): vale o pior (gravidade, depois força); as restrições somam (OR);
 * o rosto mais jovem é o de todos. Lista vazia = indisponível (nunca limpo por ausência).
 */
export function combineInputVerdicts(
  v: readonly InputVerdict[],
): RuledInputVerdict {
  if (v.length === 0) return unavailableInputVerdict('nenhuma mídia checada');
  const worst = v[worstIndexOf(v)];
  const restrictions: VerdictRestrictions = {
    requireConsent: v.some((item) => item.restrictions.requireConsent),
    noUncensoredFallback: v.some(
      (item) => item.restrictions.noUncensoredFallback,
    ),
    noPromptRewrite: v.some((item) => item.restrictions.noPromptRewrite),
    fullOutputCheck: v.some((item) => item.restrictions.fullOutputCheck),
  };
  const combined: RuledInputVerdict = {
    verdict: worst.verdict,
    ruleId: worst.ruleId,
    strength: worst.strength,
    evidence: worst.evidence,
    addToBlocklist: worst.addToBlocklist,
    reason: worst.reason,
    restrictions,
    youngestFace: youngestOf(v.map((item) => item.youngestFace)),
    shadowOnly: isShadowImageRule(worst.ruleId, worst.cause, worst.strength),
  };
  if (worst.cause) combined.cause = worst.cause;
  return combined;
}

/** Junta os resultados (várias imagens ou quadros): vale o pior; o rosto mais jovem é o de todos. */
export function combineOutputVerdicts(
  v: readonly OutputVerdict[],
): RuledOutputVerdict {
  if (v.length === 0)
    return unavailableOutputVerdict('nenhum resultado checado');
  const worst = v[worstIndexOf(v)];
  return {
    verdict: worst.verdict,
    ruleId: worst.ruleId,
    strength: worst.strength,
    evidence: worst.evidence,
    addToBlocklist: worst.addToBlocklist,
    reason: worst.reason,
    disposition: worst.disposition,
    youngestFace: youngestOf(v.map((item) => item.youngestFace)),
    shadowOnly: isShadowImageRule(worst.ruleId, undefined, worst.strength),
  };
}

/** Não deu para checar a entrada: nunca limpo; todas as restrições. */
export function unavailableInputVerdict(reason: string): RuledInputVerdict {
  return inputVerdict(
    {
      verdict: 'UNAVAILABLE',
      ruleId: 'UNAVAILABLE',
      strength: 'NONE',
      evidence: 'none',
      addToBlocklist: false,
      reason,
    },
    ALL_RESTRICTIONS,
    null,
  );
}

/** Não deu para checar o resultado: segue a regra de falha (fila, quarentena até 2 h). */
export function unavailableOutputVerdict(reason: string): RuledOutputVerdict {
  return outputVerdict(
    {
      verdict: 'UNAVAILABLE',
      ruleId: 'UNAVAILABLE',
      strength: 'NONE',
      reason,
    },
    null,
  );
}

/* ------------------------------------------------------------------ resumo da entrada e status do preflight */

/**
 * Resumo da entrada para a herança da S7: veredito juntado (null = pedido sem mídia), se houve rosto e o menor ponto
 * médio entre os rostos de todas as mídias.
 */
export function summarizeInput(
  signals: readonly ScanSignals[],
  verdict: InputVerdict | null,
): InputSummary {
  const youngest = youngestFace(signals.flatMap((item) => item.faces));
  return {
    verdict: verdict ? verdict.verdict : null,
    hadFace: youngest !== null,
    youngestAgeMid: youngest ? youngest.ageMid : null,
  };
}

const PREFLIGHT_STAGES: ReadonlySet<ScanStage> = new Set<ScanStage>([
  'INPUT',
  'INPUT_FRAME',
  'TEXT',
]);

/**
 * Status do preflight sobre as checagens da geração (uma linha por mídia, quadro e texto, a mais recente de cada):
 * algum HOLD/BLOCK = flagged; faltou a etapa esperada = unavailable; algum UNAVAILABLE = unavailable; algum GRAY =
 * gray; senão clean. Nenhuma linha = unavailable (nunca clean por ausência).
 */
export function aggregatePreflightStatus(
  scans: ReadonlyArray<{ stage: ScanStage; verdict: ScanVerdict }>,
  expect: { image: boolean; text: boolean },
): PreflightStatus {
  const relevant = scans.filter((scan) => PREFLIGHT_STAGES.has(scan.stage));
  if (relevant.length === 0) return 'unavailable';
  if (
    relevant.some((scan) => scan.verdict === 'HOLD' || scan.verdict === 'BLOCK')
  ) {
    return 'flagged';
  }
  const hasImage = relevant.some((scan) => scan.stage !== 'TEXT');
  const hasText = relevant.some((scan) => scan.stage === 'TEXT');
  if ((expect.image && !hasImage) || (expect.text && !hasText)) {
    return 'unavailable';
  }
  if (relevant.some((scan) => scan.verdict === 'UNAVAILABLE')) {
    return 'unavailable';
  }
  if (relevant.some((scan) => scan.verdict === 'GRAY')) return 'gray';
  return 'clean';
}

/* ------------------------------------------------------------------ registro */

/** Rótulos do DetectLabels que vão para o registro: só os que as regras usam (pessoa e criança). */
const RECORDED_LABELS: ReadonlySet<string> = new Set([
  ...PERSON_LABELS,
  ...CHILD_LABELS,
]);
/** Rótulos de moderação abaixo disto não vão para o registro. */
const RECORDED_MODERATION_MIN = 50;

/**
 * Sinais resumidos para content_safety_scans.scores: sem caixa do rosto (nada que localize ou identifique a pessoa),
 * sem rótulos fora das regras, sem moderação abaixo de 50 e sem texto do pedido.
 */
export function toScanScores(
  s: ScanSignals,
  extras: { surface?: SafetySurface; sexual?: boolean; reason?: string },
): ScanScores {
  const scores: ScanScores = {
    faces: s.faces.map((face) => ({
      ageLow: face.ageLow,
      ageHigh: face.ageHigh,
      ageMid: face.ageMid,
      confidence: face.confidence,
      fromCrop: face.fromCrop,
    })),
    labels: s.labels
      .filter((label) => RECORDED_LABELS.has(label.name))
      .map((label) => ({
        name: label.name,
        confidence: label.confidence,
        instanceCount: label.instanceCount,
      })),
    moderation: s.moderation
      .filter((signal) => signal.confidence >= RECORDED_MODERATION_MIN)
      .map((signal) => ({
        name: signal.name,
        parent: signal.parent,
        confidence: signal.confidence,
        taxonomyLevel: signal.taxonomyLevel,
      })),
    nudity: nudityScore(s.moderation),
    suggestive: suggestiveScore(s.moderation),
    illustrated: s.illustrated,
    cropPassRan: s.cropPassRan,
    stylized: { ...s.stylized },
  };
  if (s.hashMatch) {
    scores.hashMatch = {
      source: s.hashMatch.source,
      matcher: s.hashMatch.matcher,
      distance: s.hashMatch.distance,
    };
  }
  if (s.frame) scores.frame = { index: s.frame.index, timeMs: s.frame.timeMs };
  if (extras.surface !== undefined) scores.surface = extras.surface;
  if (extras.sexual !== undefined) scores.sexual = extras.sexual;
  if (extras.reason !== undefined) scores.reason = extras.reason;
  return scores;
}
