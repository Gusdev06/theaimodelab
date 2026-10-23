import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  invalidateActiveUserLocally,
  setActiveUserBroadcast,
} from '../../auth/strategies/jwt.strategy';
import { parseRedisConfig } from '../../common/redis-config';
import {
  IMAGE_SAFETY_CONFIG,
  type ImageSafetyConfig,
} from '../image-safety/image-safety.config';
import { isUserId } from './strikes.rules';

/**
 * Aviso entre instâncias da API de que uma conta foi bloqueada (camada 6, "invalidar o JWT na hora"): quem suspende
 * chama invalidateActiveUser, que limpa o cache deste processo e publica o id no Redis; cada instância ouve o canal e
 * limpa o cache dela. A sessão aberta cai na requisição seguinte em todas, sem esperar os 60 s do cache.
 * Pub/sub do Redis não depende do db: duas instalações no mesmo Redis só fariam uma consulta a mais ao banco.
 * Só liga com IMAGE_SAFETY_MODE diferente de off e REDIS_URL; sem isso, invalidateActiveUser vale só para o processo.
 */
export const ACTIVE_USER_INVALIDATION_CHANNEL =
  'taml:auth:active-user:invalidate';

/** O mínimo do ioredis que o aviso usa (trocável nos testes). */
export interface InvalidationPublisher {
  publish(channel: string, message: string): Promise<unknown>;
}

export interface InvalidationSubscriber {
  subscribe(channel: string): Promise<unknown>;
  on(
    event: 'message',
    listener: (channel: string, message: string) => void,
  ): unknown;
}

/**
 * Liga o aviso: o que chegar no canal limpa o cache deste processo (só id com formato de id) e todo
 * invalidateActiveUser publica. Devolve a função que desliga. Publicação que falha vira nada: o cache vence sozinho.
 */
export function attachActiveUserInvalidation(
  publisher: InvalidationPublisher,
  subscriber: InvalidationSubscriber,
  onSubscribeError: (error: unknown) => void = () => undefined,
): () => void {
  subscriber.on('message', (channel, message) => {
    if (channel !== ACTIVE_USER_INVALIDATION_CHANNEL) return;
    if (isUserId(message)) invalidateActiveUserLocally(message);
  });
  subscriber
    .subscribe(ACTIVE_USER_INVALIDATION_CHANNEL)
    .catch((error: unknown) => onSubscribeError(error));
  setActiveUserBroadcast((userId) => {
    publisher
      .publish(ACTIVE_USER_INVALIDATION_CHANNEL, userId)
      .catch(() => undefined);
  });
  return () => setActiveUserBroadcast(null);
}

@Injectable()
export class ActiveUserInvalidationBus
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(ActiveUserInvalidationBus.name);
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private detach: (() => void) | null = null;

  constructor(
    @Inject(IMAGE_SAFETY_CONFIG) private readonly config: ImageSafetyConfig,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.imageMode === 'off') return;
    const url = this.configService.get<string>('REDIS_URL');
    if (!url) {
      this.logger.warn(
        'REDIS_URL ausente: a suspensão derruba a sessão só nesta instância (as outras em até 60 s)',
      );
      return;
    }
    try {
      const { host, port, password, username, db } = parseRedisConfig(
        url,
        this.configService.get<string>('REDIS_DB'),
      );
      const options = {
        host,
        port,
        password,
        username,
        db,
        connectTimeout: 5_000,
      };
      // publicar com o Redis fora responde erro na hora (o cache vence sozinho); o ouvinte reconecta e reassina
      this.publisher = new Redis({
        ...options,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      });
      this.subscriber = new Redis(options);
    } catch (error) {
      this.logger.warn(
        `aviso entre instâncias desligado: REDIS_URL inválida (${(error as Error).message?.slice(0, 120)})`,
      );
      return;
    }
    // sem ouvinte de erro, o ioredis derruba o processo na queda da conexão
    let warned = false;
    const onError = () => {
      if (warned) return;
      warned = true;
      this.logger.warn(
        'Redis do aviso entre instâncias indisponível; a sessão das outras instâncias cai em até 60 s',
      );
    };
    this.publisher.on('error', onError);
    this.subscriber.on('error', onError);
    this.detach = attachActiveUserInvalidation(
      this.publisher,
      this.subscriber,
      onError,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.detach?.();
    this.detach = null;
    await Promise.all(
      [this.publisher, this.subscriber].map((client) =>
        client?.quit().catch(() => undefined),
      ),
    );
    this.publisher = null;
    this.subscriber = null;
  }
}
