import { canonical } from '../adult-only-rules';

/**
 * Prompt negativo lido com a regra INVERTIDA (seção 2, camada 1, item 4 da pesquisa de 16/10):
 *  - termo de menor no negativo ("o que evitar") continua sendo boa prática e NÃO conta; por isso esta função nem
 *    procura termo de menor;
 *  - marcador de maturidade no negativo de um pedido sexual empurra a idade para baixo sem escrever termo de menor:
 *    vira sinal médio (regra T_NEGATIVE).
 * Os marcadores vêm da política privada (SAFETY_POLICY_SOURCE), nunca do código: o repositório é público.
 * Função pura: sem rede, sem banco.
 */
export interface NegativeAssessment {
  /** marcador de maturidade no negativo de um pedido sexual */
  flagged: boolean;
  /** quantos marcadores distintos apareceram (vai para o registro; nunca o termo) */
  markerHits: number;
}

/**
 * Palavras na forma canônica da trava de texto (NFKC, confusáveis, dígitos de outros alfabetos, minúsculas, sem
 * acento), separadas por qualquer coisa que não seja letra ou número (pontuação, emoji, hífen).
 */
export function maturityTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  return canonical(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Procura cada marcador como palavra inteira (ou sequência de palavras inteiras) no negativo. `markers` pode vir em
 * qualquer forma: é normalizado aqui do mesmo jeito que o texto.
 */
export function assessNegative(
  negative: string | null | undefined,
  options: { sexualRequest: boolean; markers: readonly string[] },
): NegativeAssessment {
  const words = maturityTokens(negative);
  if (!words.length || !options.markers.length) {
    return { flagged: false, markerHits: 0 };
  }
  const haystack = ` ${words.join(' ')} `;
  const seen = new Set<string>();
  for (const marker of options.markers) {
    const needle = maturityTokens(marker).join(' ');
    if (needle && !seen.has(needle) && haystack.includes(` ${needle} `)) {
      seen.add(needle);
    }
  }
  return {
    flagged: options.sexualRequest && seen.size > 0,
    markerHits: seen.size,
  };
}
