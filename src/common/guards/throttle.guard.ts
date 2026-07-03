import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerGuard,
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  constructor(
    options: ThrottlerModuleOptions,
    storageService: ThrottlerStorage,
    reflector: Reflector,
  ) {
    super(options, storageService, reflector);
  }

  protected async shouldSkip(_context: ExecutionContext): Promise<boolean> {
    return false;
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    // Use user ID from JWT if available, otherwise fall back to IP
    if (req.user?.sub) {
      return req.user.sub;
    }
    return req.ip;
  }

  // TODO: Override handleRequest to apply plan-based rate limits:
  // Free: 30 req/min, Starter: 60, Pro: 120, Business: 300
}
