import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import {
  IMAGE_SAFETY_CONFIG,
  type ImageSafetyConfig,
} from '../image-safety/image-safety.config';
import { SAFETY_REVIEWER_FORBIDDEN } from '../safety-event-kinds';

export { SAFETY_REVIEWER_FORBIDDEN };

/**
 * Revisão de segurança (camada 7; ECA, art. 241-B): só o papel ADMIN não basta. A pessoa precisa estar na lista
 * SAFETY_REVIEWER_IDS (o dono e no máximo 2 designados por escrito). Sem a configuração ou com a lista vazia, ninguém
 * entra. O id vem do token já validado pelo JwtAuthGuard global (que confere a conta ativa).
 */
@Injectable()
export class SafetyReviewerGuard implements CanActivate {
  private readonly logger = new Logger(SafetyReviewerGuard.name);

  constructor(
    @Optional()
    @Inject(IMAGE_SAFETY_CONFIG)
    private readonly config: Pick<ImageSafetyConfig, 'reviewerIds'> | null = null,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ user?: { sub?: unknown; role?: unknown } }>();
    const user = request.user;
    const userId = typeof user?.sub === 'string' ? user.sub : null;
    const allowed =
      !!userId &&
      user?.role === 'ADMIN' &&
      !!this.config?.reviewerIds?.has(userId);
    if (!allowed) {
      if (userId && user?.role === 'ADMIN') {
        this.logger.warn(
          `[SAFETY_REVIEW] admin ${userId} fora de SAFETY_REVIEWER_IDS tentou abrir a revisão de segurança`,
        );
      }
      throw new ForbiddenException(SAFETY_REVIEWER_FORBIDDEN);
    }
    return true;
  }
}
