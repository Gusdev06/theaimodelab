import { Logger } from '@nestjs/common';
import type { ImageSafetyConfig } from './image-safety.config';
import {
  HashMatch,
  KnownHashPort,
  NormalizedImage,
  ProviderFailureKind,
  SafetyCallOptions,
  SafetyProviderUnavailableError,
} from './types';

/**
 * Hash de abuso conhecido (regras E1 e S6, fonte 'known-csam'): Arachnid Shield, PhotoDNA (sublicença da Tech
 * Coalition) ou IWF. Só pega material JÁ CONHECIDO; não substitui o resto da checagem.
 *
 * DESLIGADO por padrão. Nenhum fornecedor está ligado nesta versão: o formato da API só entra com contrato e
 * documentação oficial conferidos (nada de chute). Até lá a fábrica devolve o Noop, que não faz chamada de rede.
 * Quando houver contrato, o fornecedor entra como um KnownHashTransport (a chamada HTTP) e o
 * TransportKnownHashMatcher cuida de prazo, erro e do formato do acerto.
 */

/** Resposta normalizada de um fornecedor de hash conhecido. */
export interface KnownHashLookup {
  matched: boolean;
  /** distância informada pelo fornecedor; null quando ele não informa */
  distance: number | null;
}

/** A chamada ao fornecedor (HTTP), escrita só quando o contrato e a documentação estiverem conferidos. */
export interface KnownHashTransport {
  readonly name: string;
  lookup(jpeg: Buffer, signal: AbortSignal): Promise<KnownHashLookup>;
}

/** Desligado: nunca chama rede, nunca acusa. */
export class NoopKnownHashMatcher implements KnownHashPort {
  readonly name = 'none';
  readonly enabled = false;

  match(): Promise<HashMatch | null> {
    return Promise.resolve(null);
  }
}

/** Prazo padrão de uma consulta de hash conhecido. */
export const KNOWN_HASH_TIMEOUT_MS = 4_000;

/**
 * Adaptador genérico de um fornecedor de hash conhecido: prazo, cancelamento e erro viram
 * SafetyProviderUnavailableError (fornecedor fora nunca vira "não está na lista"). Acerto é sempre forte.
 */
export class TransportKnownHashMatcher implements KnownHashPort {
  readonly enabled = true;
  readonly name: string;

  constructor(private readonly transport: KnownHashTransport) {
    this.name = transport.name;
  }

  async match(
    image: NormalizedImage,
    options: SafetyCallOptions = {},
  ): Promise<HashMatch | null> {
    if (!image?.jpeg?.length) {
      throw new SafetyProviderUnavailableError(this.name, 'invalid_media');
    }
    const timeoutMs =
      options.timeoutMs && options.timeoutMs > 0
        ? options.timeoutMs
        : KNOWN_HASH_TIMEOUT_MS;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener('abort', onOuterAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new SafetyProviderUnavailableError(this.name, 'timeout'));
        }, timeoutMs);
      });
      const lookup = await Promise.race([
        this.transport.lookup(image.jpeg, controller.signal),
        timedOut,
      ]);
      if (!lookup || typeof lookup.matched !== 'boolean') {
        throw new SafetyProviderUnavailableError(this.name, 'invalid_response');
      }
      if (!lookup.matched) return null;
      return {
        source: 'known-csam',
        matcher: this.name,
        distance:
          typeof lookup.distance === 'number' &&
          Number.isFinite(lookup.distance)
            ? lookup.distance
            : null,
        blockId: null,
        strength: 'STRONG',
      };
    } catch (error) {
      if (error instanceof SafetyProviderUnavailableError) throw error;
      const failure: ProviderFailureKind = controller.signal.aborted
        ? 'timeout'
        : 'server_error';
      throw new SafetyProviderUnavailableError(this.name, failure);
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}

/**
 * Fábrica do provider. Hoje sempre o Noop: sem chave não há o que ligar; com ARACHNID_API_KEY o adaptador ainda não
 * existe (o Arachnid Shield pede credencial de conta e formato confirmado com eles), então avisa e segue desligado.
 * `transport` permite ligar um fornecedor conferido sem mexer no resto.
 */
export function createKnownHashMatcher(
  config: Pick<ImageSafetyConfig, 'arachnidApiKey'>,
  transport?: KnownHashTransport,
): KnownHashPort {
  if (transport) return new TransportKnownHashMatcher(transport);
  if (config.arachnidApiKey) {
    new Logger('KnownHashMatcher').warn(
      'ARACHNID_API_KEY presente, mas o adaptador do Arachnid Shield ainda não foi ligado (falta contrato e formato conferido): hash conhecido segue desligado',
    );
  }
  return new NoopKnownHashMatcher();
}
