import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { UnlimitedService } from './unlimited.service';
import { UNLIMITED_REDIS } from './unlimited.constants';
import { parseRedisConfig } from '../common/redis-config';

@Global()
@Module({
  providers: [
    UnlimitedService,
    {
      provide: UNLIMITED_REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const { host, port, password, username, db } = parseRedisConfig(
          config.getOrThrow<string>('REDIS_URL'),
          config.get<string>('REDIS_DB'),
        );
        return new Redis({
          host,
          port,
          password,
          username,
          db,
          maxRetriesPerRequest: null,
        });
      },
    },
  ],
  exports: [UnlimitedService],
})
export class UnlimitedModule implements OnApplicationShutdown {
  constructor(@Inject(UNLIMITED_REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
