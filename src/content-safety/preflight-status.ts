/**
 * Veredito do porteiro de imagem (checagem da mídia de entrada ANTES do provedor) sobre uma geração:
 *  - `clean`: toda mídia de entrada foi checada e passou limpa;
 *  - `gray`: zona de dúvida (idade aparente perto do limite, rosto não lido…);
 *  - `flagged`: sinal de menor ou de abuso;
 *  - `unavailable`: não há checagem registrada para a geração (porteiro desligado, fora do ar ou ainda não rodou).
 *
 * Só `clean` deixa a foto do usuário seguir num desvio depois de uma recusa (decideSafetyFallback). Função e tipos
 * puros: sem rede, sem banco.
 */
export const PREFLIGHT_STATUSES = [
  'clean',
  'gray',
  'flagged',
  'unavailable',
] as const;

export type PreflightStatus = (typeof PREFLIGHT_STATUSES)[number];

/** Valor desconhecido (coluna nova, JSON antigo) nunca vira `clean`: conta como sem checagem. */
export function toPreflightStatus(value: unknown): PreflightStatus {
  return typeof value === 'string' &&
    (PREFLIGHT_STATUSES as readonly string[]).includes(value)
    ? (value as PreflightStatus)
    : 'unavailable';
}
