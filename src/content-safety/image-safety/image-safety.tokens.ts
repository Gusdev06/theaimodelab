import type { PreflightStatus } from '../preflight-status';

/**
 * Tokens de injeção da segurança de imagem. Este arquivo NÃO importa valor de nenhum outro: o ContentSafetyService
 * (que o interceptor importa, e que a config importa via isUncensoredModel) lê o status do preflight por aqui sem
 * criar import circular com image-safety.config.ts / image-safety.rules.ts.
 */

/** Leitor de imagem (ScannerPort). null com IMAGE_SAFETY_MODE=off: nenhum cliente da AWS é criado. */
export const IMAGE_SCANNER = Symbol('IMAGE_SCANNER');
/** Hash de abuso conhecido (KnownHashPort); Noop sem contrato. */
export const KNOWN_HASH_MATCHER = Symbol('KNOWN_HASH_MATCHER');
/** Juiz de imagem estilizada (StylizedJudgePort); Noop sem chave. */
export const STYLIZED_JUDGE = Symbol('STYLIZED_JUDGE');
/** Lista de bloqueio própria (BlocklistPort). */
export const BLOCKLIST = Symbol('BLOCKLIST');
/** Ferramentas de mídia (normalizar, quadros de vídeo, pHash): trocáveis nos testes. */
export const SAFETY_MEDIA_TOOLKIT = Symbol('SAFETY_MEDIA_TOOLKIT');
/** Leitor do status do preflight de uma geração (content_safety_scans), usado pelo ContentSafetyService. */
export const PREFLIGHT_STATUS_READER = Symbol('PREFLIGHT_STATUS_READER');

/** Para onde o desvio levaria a mídia: o modelo sem censura reavalia a entrada como pedido sexual. */
export type PreflightStatusTarget = 'uncensored' | 'same_provider';

/** Status do preflight de uma geração a partir das checagens gravadas. Nunca lança: erro de leitura = 'unavailable'. */
export interface PreflightStatusReader {
  /**
   * o porteiro de imagem está ligado (enforcesMediaPreflight da config): só então o desvio de um pedido com mídia
   * depende do veredito (safetyFallbackVerdict.enforceMediaPreflight)
   */
  readonly enforcesMediaPreflight: boolean;
  statusFor(
    generationId: string,
    target?: PreflightStatusTarget,
  ): Promise<PreflightStatus>;
}
