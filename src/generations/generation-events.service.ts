import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable, Subject, filter } from 'rxjs';
import Redis from 'ioredis';

export interface GenerationEvent {
  userId: string;
  generationId: string;
  status: 'completed' | 'failed';
  data: Record<string, unknown>;
}

const CHANNEL = 'generation-events';

@Injectable()
export class GenerationEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GenerationEventsService.name);
  private readonly events$ = new Subject<GenerationEvent>();
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
        const event = JSON.parse(message) as GenerationEvent;
        this.events$.next(event);
      } catch {
        // ignore malformed messages
      }
    });

    this.logger.log('Redis Pub/Sub connected for generation events');
  }

  onModuleDestroy(): void {
    this.subscriber?.unsubscribe(CHANNEL);
    this.subscriber?.disconnect();
    this.publisher?.disconnect();
  }

  emit(event: GenerationEvent): void {
    this.publisher.publish(CHANNEL, JSON.stringify(event));
  }

  subscribe(userId: string): Observable<MessageEvent> {
    return this.events$.pipe(
      filter((event) => event.userId === userId),
    ) as unknown as Observable<MessageEvent>;
  }

  subscribeToGeneration(
    userId: string,
    generationId: string,
  ): Observable<MessageEvent> {
    return this.events$.pipe(
      filter(
        (event) =>
          event.userId === userId && event.generationId === generationId,
      ),
    ) as unknown as Observable<MessageEvent>;
  }
}
