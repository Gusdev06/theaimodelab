import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable, Subject, filter } from 'rxjs';
import Redis from 'ioredis';
import { AvatarStatus, AvatarConsentStatus } from '@prisma/client';

export interface AvatarEvent {
  userId: string;
  userAvatarId: string;
  status: AvatarStatus;
  consentStatus?: AvatarConsentStatus;
  data?: Record<string, unknown>;
}

const CHANNEL = 'avatar-events';

/**
 * Mirrors GenerationEventsService: cross-instance pub/sub via Redis,
 * locally re-broadcast through an RxJS Subject so SSE handlers can filter
 * per user / per avatar.
 */
@Injectable()
export class AvatarEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AvatarEventsService.name);
  private readonly events$ = new Subject<AvatarEvent>();
  private publisher: Redis;
  private subscriber: Redis;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const redisUrl = this.configService.getOrThrow<string>('REDIS_URL');

    this.publisher = new Redis(redisUrl);
    this.subscriber = new Redis(redisUrl);

    this.subscriber.subscribe(CHANNEL);
    this.subscriber.on('message', (_channel: string, message: string) => {
      try {
        const event = JSON.parse(message) as AvatarEvent;
        this.events$.next(event);
      } catch {
        // ignore malformed messages
      }
    });

    this.logger.log('Redis Pub/Sub connected for avatar events');
  }

  onModuleDestroy(): void {
    this.subscriber?.unsubscribe(CHANNEL);
    this.subscriber?.disconnect();
    this.publisher?.disconnect();
  }

  emit(event: AvatarEvent): void {
    this.publisher.publish(CHANNEL, JSON.stringify(event));
  }

  subscribeToAvatar(
    userId: string,
    userAvatarId: string,
  ): Observable<MessageEvent> {
    return this.events$.pipe(
      filter(
        (event) =>
          event.userId === userId && event.userAvatarId === userAvatarId,
      ),
    ) as unknown as Observable<MessageEvent>;
  }
}
