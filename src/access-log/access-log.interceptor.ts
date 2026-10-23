import {
  Inject,
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { finalize, tap, type Observable } from 'rxjs';
import { normalizePath } from '../content-safety/content-safety.interceptor';
import { ACCESS_LOG_CONFIG, type AccessLogConfig } from './access-log.config';
import {
  accountIdOf,
  generationIdsOf,
  matchAccessRoute,
  type AccessRoute,
} from './access-log.routes';
import { AccessLogService, type AccessLogEntry } from './access-log.service';
import { resolveClientAddress, type ClientAddress } from './client-address';

type HeaderValue = string | string[] | undefined;

export interface AccessLogRequest {
  method?: string;
  path?: string;
  url?: string;
  originalUrl?: string;
  /** rota declarada que o Express casou (ex.: /api/v1/avatars/:id/generate-video) */
  route?: { path?: unknown };
  headers?: Record<string, HeaderValue>;
  socket?: { remoteAddress?: string; remotePort?: number } | null;
  /** conta do token (JwtAuthGuard) ou, no callback do Google, o perfil do Google */
  user?: unknown;
}

/** O que já se sabe na entrada do pedido; a conta e as gerações saem da resposta. */
interface PendingAccess {
  route: AccessRoute;
  label: string;
  requestUser: unknown;
  address: ClientAddress;
  userAgent: string | null;
  at: Date;
  done: boolean;
}

function header(
  headers: Record<string, HeaderValue> | undefined,
  name: string,
): HeaderValue {
  return headers ? headers[name] : undefined;
}

function firstHeader(value: HeaderValue): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : null;
}

/**
 * Registro de acesso (Marco Civil, art. 15; camada 8): em login, cadastro, login com Google, renovação da sessão e
 * pedido de geração, grava IP, porta de origem quando o proxy da frente repassa, user agent, conta, rota e horário UTC
 * do pedido. Global (APP_INTERCEPTOR), então roda antes do ContentSafetyInterceptor dos controllers: o pedido barrado
 * pela trava de menor também fica gravado, com a conta do token. Tentativa que falha (senha errada, 4xx, 5xx) é
 * gravada sem conta nas rotas de entrada, porque só a resposta de sucesso diz quem entrou.
 *
 * Vale em qualquer modo da trava de imagem (obrigação legal). Nunca derruba o pedido: a gravação vai para o
 * AccessLogService fora do caminho da resposta, e qualquer erro aqui só vira aviso.
 */
@Injectable()
export class AccessLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AccessLogInterceptor.name);

  constructor(
    private readonly accessLog: AccessLogService,
    @Inject(ACCESS_LOG_CONFIG) private readonly config: AccessLogConfig,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    let pending: PendingAccess | null = null;
    try {
      pending = this.begin(
        context.switchToHttp().getRequest<AccessLogRequest>(),
      );
    } catch (error) {
      this.warn('leitura do pedido', error);
    }
    if (!pending) return next.handle();
    const access = pending;
    return next.handle().pipe(
      tap({
        next: (response) => this.finish(access, response, true),
        error: () => this.finish(access, undefined, false),
      }),
      // pedido que termina sem resposta (conexão encerrada antes): fica a tentativa
      finalize(() => this.finish(access, undefined, false)),
    );
  }

  private begin(req: AccessLogRequest | undefined): PendingAccess | null {
    if (!req) return null;
    const method = String(req.method ?? '').toUpperCase();
    // a rota que o Express casou é a fonte mais fiel (sem o id no caminho); sem ela, a URL normalizada
    const declared =
      typeof req.route?.path === 'string' ? req.route.path : undefined;
    const path = normalizePath(
      declared ?? req.originalUrl ?? req.url ?? req.path,
    );
    const route = matchAccessRoute(method, path);
    if (!route) return null;
    const headers = req.headers;
    const address = resolveClientAddress(
      {
        remoteAddress: req.socket?.remoteAddress ?? null,
        remotePort: req.socket?.remotePort ?? null,
        forwardedFor: header(headers, 'x-forwarded-for'),
        realIp: header(headers, 'x-real-ip'),
        sourcePort: header(headers, this.config.sourcePortHeader),
      },
      this.config.trust,
    );
    return {
      route,
      label: `${method} ${path}`,
      requestUser: req.user,
      address,
      userAgent: firstHeader(header(headers, 'user-agent')),
      at: new Date(),
      done: false,
    };
  }

  private finish(
    access: PendingAccess,
    response: unknown,
    succeeded: boolean,
  ): void {
    if (access.done) return;
    access.done = true;
    try {
      const userId = accountIdOf(
        access.route,
        access.requestUser,
        response,
        succeeded,
      );
      const generationIds = succeeded
        ? generationIdsOf(access.route, response)
        : [];
      const base: Omit<AccessLogEntry, 'generationId'> = {
        userId,
        route: access.label,
        ip: access.address.ip,
        port: access.address.port,
        userAgent: access.userAgent,
        at: access.at,
      };
      const entries: AccessLogEntry[] = generationIds.length
        ? generationIds.map((generationId) => ({ ...base, generationId }))
        : [{ ...base, generationId: null }];
      this.accessLog.record(entries);
    } catch (error) {
      this.warn('montagem do registro', error);
    }
  }

  private warn(stage: string, error: unknown): void {
    const name = error instanceof Error ? error.name : typeof error;
    this.logger.warn(
      `registro de acesso: falha na ${stage} (${name}); o pedido segue`,
    );
  }
}
