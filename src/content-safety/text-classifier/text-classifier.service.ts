import { createHash } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { canonical } from '../adult-only-rules';
import { isUncensoredModel } from '../content-safety.interceptor';
import {
  assessText,
  mentionsMinorRemoval,
  type MinorAssessment,
} from '../minor-guard';
import {
  IMAGE_SAFETY_CONFIG,
  isRuleEnforced,
  type ImageSafetyConfig,
} from '../image-safety/image-safety.config';
import {
  SafetyProviderUnavailableError,
  type ProviderFailureKind,
  type SafetyCallOptions,
  type Strength,
  type TextClassifierInput,
  type TextClassifierResult,
  type TextRuleId,
  type TextVerdict,
  type ScanVerdict,
} from '../image-safety/types';
import { assessNegative, type NegativeAssessment } from './negative';
import type { SafetyPolicy } from './policy-loader';
import { TextVerdictCache } from './text-classifier.cache';
import {
  TEXT_CLASSIFIER_BACKENDS,
  type TextClassifierBackends,
} from './text-classifier.tokens';

/**
 * Camada 2 · leitor de sentido do texto, na fila, antes do 1º provedor (e sobre a saída do agente refinador).
 *
 *  - Só vai para fora o texto que já passou pela trava determinística (camada 1): o prompt e o prompt do servidor
 *    passam de novo por assessText aqui; acusou = decide sem chamar ninguém.
 *  - Safeguard decide; omni só registra (sombra).
 *  - Cache dos resultados no Redis por sha256 do texto canônico; o veredito é refeito a cada chamada.
 *  - Nunca lança por fornecedor: devolve UNAVAILABLE (quem chama aplica a regra de falha da camada 2).
 *  - O veredito devolvido é o REAL; o que age em cada modo é `shouldAct` (isRuleEnforced).
 */

export type TextSource = 'request' | 'refiner';

export interface TextClassifyOptions {
  /** o pedido é sexual (modelo sem censura, ferramenta sexual, termos adultos no prompt final, nudez na entrada) */
  sexualRequest: boolean;
  /** de onde veio o texto: pedido da cliente ou saída do agente refinador */
  source: TextSource;
  timeoutMs?: SafetyCallOptions['timeoutMs'];
  signal?: SafetyCallOptions['signal'];
}

/** Tudo que a decisão do texto precisa, já lido (função pura sobre isto). */
export interface TextDecisionInput {
  sha256: string;
  source: TextSource;
  /** camada 1 sobre o prompt e o prompt do servidor; null = não acusou */
  layerOne: Pick<MinorAssessment, 'blocked' | 'reason'> | null;
  negative: NegativeAssessment;
  /** o prompt ou o prompt do servidor pede para tirar criança da imagem (mentionsMinorRemoval) */
  minorRemoval?: boolean;
  /** resultado do safeguard; null = indisponível (ver safeguardFailure) */
  safeguard: TextClassifierResult | null;
  safeguardFailure: ProviderFailureKind | null;
  /** classificadores em sombra: só entram em `results` */
  shadow: readonly TextClassifierResult[];
}

function verdictOf(
  base: Pick<TextDecisionInput, 'sha256' | 'safeguard' | 'shadow'>,
  verdict: ScanVerdict,
  ruleId: TextRuleId | 'UNAVAILABLE' | null,
  strength: Strength,
  reason: string,
): TextVerdict {
  const results = [...(base.safeguard ? [base.safeguard] : []), ...base.shadow];
  return {
    verdict,
    ruleId,
    strength,
    sexualIntent: base.safeguard?.sexual ?? null,
    sha256: base.sha256,
    results,
    reason,
  };
}

/**
 * Regras do texto (seção 3, "Texto (camadas 1 e 2)"), a 1ª que casar:
 *  0. camada 1 acusou (texto que não deveria ter chegado à fila): refinador → T_REFINER médio; idade explícita →
 *     T_CLASSIFIER forte; termo → T_CLASSIFIER médio; texto que a camada 1 não confere (tamanho, alfabeto) →
 *     T_AMBIGUOUS sem ponto. Nada vai para fora;
 *  1. T_REFINER: saída do refinador com violação do safeguard (qualquer faixa) → BLOCK médio;
 *  2. T_CLASSIFIER forte: violação de confiança alta com menor explícito (safeguard) ou pedido de "remover criança"
 *     escrito no texto → BLOCK forte (vem
 *     antes do negativo: sinal forte não pode perder para o médio);
 *  3. T_NEGATIVE: marcador de maturidade no negativo de pedido sexual → HOLD médio (decidido aqui, mesmo com o
 *     classificador fora);
 *  4. safeguard indisponível → UNAVAILABLE;
 *  5. T_CLASSIFIER: violação de confiança alta → BLOCK médio;
 *  6. T_AMBIGUOUS: violação na faixa média → BLOCK sem ponto (não gera, estorno, aba Suspeitas);
 *  7. CLEAN.
 * O omni (sombra) nunca entra nestas regras.
 */
export function decideTextVerdict(input: TextDecisionInput): TextVerdict {
  const { layerOne, negative, safeguard, source } = input;

  if (layerOne?.blocked) {
    const base = { ...input, safeguard: null, shadow: [] };
    if (source === 'refiner') {
      return verdictOf(
        base,
        'BLOCK',
        'T_REFINER',
        'MEDIUM',
        'camada 1 acusou a saída do refinador',
      );
    }
    if (layerOne.reason === 'age') {
      return verdictOf(
        base,
        'BLOCK',
        'T_CLASSIFIER',
        'STRONG',
        'camada 1: idade abaixo de 18 no texto da fila',
      );
    }
    if (layerOne.reason === 'term') {
      return verdictOf(
        base,
        'BLOCK',
        'T_CLASSIFIER',
        'MEDIUM',
        'camada 1: termo de menor no texto da fila',
      );
    }
    return verdictOf(
      base,
      'BLOCK',
      'T_AMBIGUOUS',
      'NONE',
      `camada 1 não confere o texto (${layerOne.reason ?? 'desconhecido'})`,
    );
  }

  const violation = safeguard?.violation === true;
  if (source === 'refiner' && violation) {
    return verdictOf(
      input,
      'BLOCK',
      'T_REFINER',
      'MEDIUM',
      `safeguard acusou a saída do refinador (faixa ${safeguard.band})`,
    );
  }
  if (
    violation &&
    safeguard.band === 'high' &&
    (safeguard.explicitMinor || input.minorRemoval === true)
  ) {
    return verdictOf(
      input,
      'BLOCK',
      'T_CLASSIFIER',
      'STRONG',
      safeguard.explicitMinor
        ? 'safeguard: violação de confiança alta com menor explícito'
        : 'safeguard: violação de confiança alta com pedido de remover criança',
    );
  }
  if (negative.flagged) {
    return verdictOf(
      input,
      'HOLD',
      'T_NEGATIVE',
      'MEDIUM',
      `marcador de maturidade no negativo em pedido sexual (${negative.markerHits})`,
    );
  }
  if (!safeguard) {
    return verdictOf(
      input,
      'UNAVAILABLE',
      'UNAVAILABLE',
      'NONE',
      `classificador de texto indisponível (${input.safeguardFailure ?? 'server_error'})`,
    );
  }
  if (violation && safeguard.band === 'high') {
    return verdictOf(
      input,
      'BLOCK',
      'T_CLASSIFIER',
      'MEDIUM',
      'safeguard: violação de confiança alta',
    );
  }
  if (violation) {
    return verdictOf(
      input,
      'BLOCK',
      'T_AMBIGUOUS',
      'NONE',
      'safeguard: violação na faixa média (texto ambíguo)',
    );
  }
  return verdictOf(input, 'CLEAN', null, 'NONE', 'sem violação');
}

/**
 * Regra de falha da camada 2 quando o classificador não responde: modelo sem censura ou qualquer pedido com foto
 * fica na fila (nova tentativa até 10 min, depois falha com estorno); modelo com filtro em texto puro segue.
 */
export function textUnavailableAction(ctx: {
  model: string | null;
  hasUserMedia: boolean;
}): 'retry' | 'proceed' {
  return ctx.hasUserMedia || isUncensoredModel(ctx.model) ? 'retry' : 'proceed';
}

function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Camada 1 sobre o que a cliente pediu e o que o servidor montou (o negativo tem regra própria). */
export function layerOneOf(
  input: TextClassifierInput,
): Pick<MinorAssessment, 'blocked' | 'reason'> | null {
  for (const text of [input.prompt, input.serverPrompt]) {
    const assessment = assessText(text);
    if (assessment.blocked) {
      return { blocked: true, reason: assessment.reason };
    }
  }
  return null;
}

@Injectable()
export class TextClassifierService {
  private readonly logger = new Logger(TextClassifierService.name);
  /** config.textMode !== 'off' */
  readonly enabled: boolean;
  /**
   * O que decidiu cada veredito devolvido por classify (só em memória, solto com o veredito): permite refazer a
   * decisão com o pedido sexual final sem chamar o classificador de novo (withSexualRequest).
   */
  private readonly decisions = new WeakMap<
    TextVerdict,
    { input: TextDecisionInput; markerHits: number }
  >();

  constructor(
    @Inject(IMAGE_SAFETY_CONFIG) private readonly config: ImageSafetyConfig,
    @Inject(TEXT_CLASSIFIER_BACKENDS)
    private readonly backends: TextClassifierBackends,
    private readonly cache: TextVerdictCache,
  ) {
    this.enabled = config.textMode !== 'off';
  }

  /** sha256 de canonical(prompt) + '\u0000' + canonical(negative) + '\u0000' + canonical(serverPrompt). */
  textSha256(input: TextClassifierInput): string {
    const parts = [input.prompt, input.negative, input.serverPrompt].map(
      (text) => canonical(text ?? ''),
    );
    return createHash('sha256')
      .update(parts.join('\u0000'), 'utf8')
      .digest('hex');
  }

  /** O veredito age no modo atual? (off nunca; shadow só refinador e forte; enforce tudo que não é limpo) */
  shouldAct(verdict: Pick<TextVerdict, 'ruleId' | 'strength'>): boolean {
    return isRuleEnforced(
      { layer: 'text', ruleId: verdict.ruleId, strength: verdict.strength },
      this.config,
    );
  }

  /**
   * Refaz a decisão de um veredito de classify sabendo que o pedido É sexual. O texto é lido em paralelo com as fotos
   * (antes da nudez da entrada e da intenção que o próprio classificador leu), então o marcador de maturidade no
   * negativo (T_NEGATIVE) pode ter ficado de fora. Sem nova chamada externa: as mesmas entradas da decisão, com o
   * negativo marcado; a precedência das regras não muda (sinal forte e camada 1 continuam por cima). Veredito que não
   * veio de classify, ou sem marcador no negativo, volta igual.
   */
  withSexualRequest(verdict: TextVerdict): TextVerdict {
    const decision = this.decisions.get(verdict);
    if (
      !decision ||
      decision.input.negative.flagged ||
      decision.markerHits === 0
    ) {
      return verdict;
    }
    const redecided = decideTextVerdict({
      ...decision.input,
      negative: { flagged: true, markerHits: decision.markerHits },
    });
    this.decisions.set(redecided, {
      input: {
        ...decision.input,
        negative: { flagged: true, markerHits: decision.markerHits },
      },
      markerHits: decision.markerHits,
    });
    return redecided;
  }

  async classify(
    input: TextClassifierInput,
    options: TextClassifyOptions,
  ): Promise<TextVerdict> {
    const sha256 = this.textSha256(input);
    const empty = { sha256, safeguard: null, shadow: [] };
    if (!this.enabled) {
      // nenhuma chamada externa com o modo off (comportamento da Onda 0)
      return verdictOf(
        empty,
        'UNAVAILABLE',
        'UNAVAILABLE',
        'NONE',
        'classificador de texto desligado',
      );
    }

    const layerOne = layerOneOf(input);
    const noNegative = { flagged: false, markerHits: 0 };
    if (layerOne) {
      return decideTextVerdict({
        ...empty,
        source: options.source,
        layerOne,
        negative: noNegative,
        safeguardFailure: null,
      });
    }
    if (![input.prompt, input.negative, input.serverPrompt].some(hasText)) {
      return verdictOf(empty, 'CLEAN', null, 'NONE', 'sem texto');
    }

    let policy: SafetyPolicy;
    try {
      policy = await this.backends.policy();
    } catch (error) {
      const failure = this.failureOf(error, 'policy', sha256);
      return decideTextVerdict({
        ...empty,
        source: options.source,
        layerOne: null,
        negative: noNegative,
        safeguardFailure: failure,
      });
    }

    const negative = assessNegative(input.negative, {
      sexualRequest: options.sexualRequest,
      markers: policy.negativeMaturityMarkers,
    });

    const minorRemoval = [input.prompt, input.serverPrompt].some((text) =>
      mentionsMinorRemoval(text),
    );

    const cached = await this.cache.get(policy.version, sha256);
    if (cached) {
      return this.decide(
        {
          sha256,
          source: options.source,
          layerOne: null,
          negative,
          minorRemoval,
          safeguard: cached.safeguard,
          safeguardFailure: null,
          shadow: cached.shadow,
        },
        negative.markerHits,
      );
    }

    const callOptions: SafetyCallOptions = {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    };
    const [safeguardOutcome, shadow] = await Promise.all([
      this.runSafeguard(input, callOptions, sha256),
      this.runShadow(input, callOptions),
    ]);
    if (safeguardOutcome.result) {
      await this.cache.set(policy.version, sha256, {
        safeguard: safeguardOutcome.result,
        shadow,
      });
    }
    return this.decide(
      {
        sha256,
        source: options.source,
        layerOne: null,
        negative,
        minorRemoval,
        safeguard: safeguardOutcome.result,
        safeguardFailure: safeguardOutcome.failure,
        shadow,
      },
      negative.markerHits,
    );
  }

  /** decideTextVerdict guardando as entradas (para withSexualRequest). */
  private decide(input: TextDecisionInput, markerHits: number): TextVerdict {
    const verdict = decideTextVerdict(input);
    this.decisions.set(verdict, { input, markerHits });
    return verdict;
  }

  private async runSafeguard(
    input: TextClassifierInput,
    options: SafetyCallOptions,
    sha256: string,
  ): Promise<{
    result: TextClassifierResult | null;
    failure: ProviderFailureKind | null;
  }> {
    const safeguard = this.backends.safeguard;
    if (!safeguard) {
      this.logger.warn(
        'classificador de texto ligado sem safeguard configurado',
      );
      return { result: null, failure: 'not_configured' };
    }
    try {
      return {
        result: await safeguard.classify(input, options),
        failure: null,
      };
    } catch (error) {
      return {
        result: null,
        failure: this.failureOf(error, safeguard.name, sha256),
      };
    }
  }

  /** Sombra: falha não muda nada (só não entra no registro). */
  private async runShadow(
    input: TextClassifierInput,
    options: SafetyCallOptions,
  ): Promise<TextClassifierResult[]> {
    const settled = await Promise.allSettled(
      this.backends.shadow.map((port) => port.classify(input, options)),
    );
    const results: TextClassifierResult[] = [];
    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      } else {
        const failure =
          outcome.reason instanceof SafetyProviderUnavailableError
            ? outcome.reason.failure
            : 'server_error';
        this.logger.debug(
          `classificador em sombra ${this.backends.shadow[index].name} indisponível (${failure})`,
        );
      }
    });
    return results;
  }

  /** Motivo da falha para o registro; o log leva só fornecedor, motivo, região e um pedaço do hash do texto. */
  private failureOf(
    error: unknown,
    provider: string,
    sha256: string,
  ): ProviderFailureKind {
    const failure =
      error instanceof SafetyProviderUnavailableError
        ? error.failure
        : 'server_error';
    const region =
      error instanceof SafetyProviderUnavailableError && error.region
        ? ` região=${error.region}`
        : '';
    this.logger.warn(
      `classificador de texto indisponível: ${provider} (${failure})${region} texto=${sha256.slice(0, 12)}`,
    );
    return failure;
  }
}
