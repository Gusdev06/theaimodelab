import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface SuccessResponse<T> {
  success: true;
  data: T;
  meta?: Record<string, any>;
}

@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, SuccessResponse<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<SuccessResponse<T>> {
    return next.handle().pipe(
      map((responseData) => {
        // If response already has success field, pass through (e.g. from webhooks)
        if (responseData && typeof responseData === 'object' && 'success' in responseData) {
          return responseData;
        }

        // If response has data + meta (paginated), extract them
        if (
          responseData &&
          typeof responseData === 'object' &&
          'data' in responseData &&
          'meta' in responseData
        ) {
          return {
            success: true as const,
            data: responseData.data,
            meta: responseData.meta,
          };
        }

        return {
          success: true as const,
          data: responseData,
        };
      }),
    );
  }
}
