import type { TextClassifierPort } from '../image-safety/types';
import type { SafetyPolicy } from './policy-loader';

/** Classificadores e política que o TextClassifierService usa (trocáveis nos testes). */
export interface TextClassifierBackends {
  /** decide (safeguard na Bedrock); null = classificador sem modelo configurado */
  safeguard: TextClassifierPort | null;
  /** só registram (omni-moderation nesta onda) */
  shadow: readonly TextClassifierPort[];
  policy: () => Promise<SafetyPolicy>;
}

export const TEXT_CLASSIFIER_BACKENDS = Symbol('TEXT_CLASSIFIER_BACKENDS');
