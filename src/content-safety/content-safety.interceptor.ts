import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { ContentSafetyEventKind } from '@prisma/client';
import { Observable } from 'rxjs';
import { BusinessException } from '../common/exceptions/business.exception';
import { ContentSafetyService } from './content-safety.service';
import { assessBody, assessText, collectTexts } from './minor-guard';

/**
 * Rotas de ferramenta que colocam a foto de uma PESSOA em conteúdo íntimo: exigem que o usuário ateste, a cada
 * pedido, que a foto é de uma pessoa gerada por IA ou de um adulto que autorizou. Sem o atestado, recusa.
 * - troca de rosto (sempre: o rosto enviado é de alguém)
 * - ferramenta de despir (modelo `deepdeep`, nas duas rotas de imagem)
 */
export function requiresConsent(path: string, body: unknown): boolean {
  const p = path.split('?')[0].replace(/\/+$/, '');
  if (/\/generations\/face-swap$/.test(p)) return true;
  const model = body && typeof body === 'object' ? (body as Record<string, unknown>).model : undefined;
  if (/\/generations\/generate-image(?:-auto)?$/.test(p) && model === 'deepdeep') return true;
  return false;
}

/**
 * Camada de segurança de conteúdo da plataforma, aplicada nos controllers que recebem pedido de geração
 * (gerações, avatares falantes, turbinar prompt). Roda ANTES de qualquer provedor de IA e de qualquer cobrança:
 *  1. qualquer texto livre do pedido que faça referência a menor de idade → recusa (422 CONTENT_POLICY_MINOR)
 *  2. ferramenta de foto de pessoa sem o atestado de consentimento → recusa (400 CONSENT_REQUIRED)
 * Os dois casos e cada atestado aceito ficam na trilha de auditoria (content_safety_events).
 * Um interceptor no lugar de 23 alterações no generations.service: cobre rota nova sem depender de lembrar.
 */
@Injectable()
export class ContentSafetyInterceptor implements NestInterceptor {
  constructor(private readonly safety: ContentSafetyService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<{
      method: string; path?: string; url?: string; originalUrl?: string; body?: unknown; user?: { sub?: string };
    }>();
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next.handle();

    const path = req.originalUrl ?? req.url ?? req.path ?? '';
    const route = `${req.method} ${path.split('?')[0]}`;
    const userId = req.user?.sub ?? null;
    const body = req.body;

    const assessment = assessBody(body);
    if (assessment.blocked) {
      const excerpt = collectTexts(body).find((text) => assessText(text).blocked) ?? null;
      await this.safety.record({ userId, kind: ContentSafetyEventKind.MINOR_BLOCKED, route, match: assessment.match ?? null, excerpt });
      throw new BusinessException('CONTENT_POLICY_MINOR');
    }

    if (requiresConsent(path, body)) {
      const confirmed = Boolean(body && typeof body === 'object' && (body as Record<string, unknown>).consent_confirmed === true);
      if (!confirmed) {
        await this.safety.record({ userId, kind: ContentSafetyEventKind.CONSENT_MISSING, route });
        throw new BusinessException('CONSENT_REQUIRED');
      }
      await this.safety.record({ userId, kind: ContentSafetyEventKind.CONSENT_ATTESTED, route });
    }

    return next.handle();
  }
}
