import {
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';

/** Código e mensagem da conta desativada (bloqueio pelo admin, guarda legal, exclusão ou a própria pessoa desativou). */
export const ACCOUNT_DISABLED_CODE = 'ACCOUNT_DISABLED';
export const ACCOUNT_DISABLED_MESSAGE =
  'Esta conta está desativada e não pode mais entrar. Se precisar de ajuda, fale com o suporte.';

export function accountDisabledException(): UnauthorizedException {
  return new UnauthorizedException({
    code: ACCOUNT_DISABLED_CODE,
    message: ACCOUNT_DISABLED_MESSAGE,
  });
}

/** Quanto tempo a resposta "a conta está ativa?" vale sem ir ao banco: conta bloqueada perde o acesso em até 1 minuto. */
export const ACTIVE_USER_CACHE_TTL_MS = 60_000;
/** Teto de contas guardadas (memória limitada); cheio, sai a entrada mais antiga. */
export const ACTIVE_USER_CACHE_MAX_ENTRIES = 10_000;

interface JwtAccessPayload {
  sub: string;
  email: string;
  role: string;
}

interface CachedAccess {
  active: boolean;
  expiresAt: number;
}

/**
 * Cache em memória de "conta existe e está ativa", por id, com validade curta e tamanho limitado. Guarda também o
 * "não" (conta bloqueada tentando de novo não vira uma consulta por requisição) e junta consultas simultâneas da mesma
 * conta numa só.
 */
export class ActiveUserCache {
  private readonly entries = new Map<string, CachedAccess>();
  private readonly pending = new Map<string, Promise<boolean>>();

  constructor(
    private readonly ttlMs = ACTIVE_USER_CACHE_TTL_MS,
    private readonly maxEntries = ACTIVE_USER_CACHE_MAX_ENTRIES,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  async resolve(
    userId: string,
    lookup: (userId: string) => Promise<boolean>,
  ): Promise<boolean> {
    const cached = this.entries.get(userId);
    if (cached) {
      if (cached.expiresAt > Date.now()) return cached.active;
      this.entries.delete(userId);
    }
    const inFlight = this.pending.get(userId);
    if (inFlight) return inFlight;

    const request: Promise<boolean> = lookup(userId)
      .then((active) => {
        // invalidada durante a consulta (a conta foi bloqueada no meio): a resposta pode ser de antes do bloqueio
        if (this.pending.get(userId) === request) this.store(userId, active);
        return active;
      })
      .finally(() => {
        if (this.pending.get(userId) === request) this.pending.delete(userId);
      });
    this.pending.set(userId, request);
    return request;
  }

  /**
   * Esquece a conta (bloqueio, guarda legal, exclusão): a próxima requisição dela vai ao banco. Uma consulta que já
   * estava em andamento não grava a resposta (pode ter sido lida antes do bloqueio).
   */
  invalidate(userId: string): void {
    this.entries.delete(userId);
    this.pending.delete(userId);
  }

  private store(userId: string, active: boolean): void {
    // reinserir põe a conta no fim: a ordem do Map é a ordem de vencimento (todas têm a mesma validade)
    this.entries.delete(userId);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(userId, { active, expiresAt: Date.now() + this.ttlMs });
  }
}

/**
 * Cache único do processo: o JwtStrategy lê dele e quem bloqueia a conta (exclusão LGPD, guarda legal, suspensão por
 * segurança) chama invalidateActiveUser logo depois de gravar no banco, e a sessão aberta cai na requisição seguinte.
 * Sem o aviso entre instâncias (setActiveUserBroadcast), as outras instâncias da API continuam com a resposta antiga
 * até a validade (ACTIVE_USER_CACHE_TTL_MS) vencer.
 */
export const activeUserCache = new ActiveUserCache();

/** Avisa as outras instâncias da API que a conta mudou (Redis); melhor esforço: sem aviso, o cache delas vence. */
export type ActiveUserBroadcast = (userId: string) => void;

let activeUserBroadcast: ActiveUserBroadcast | null = null;

/**
 * Liga (ou desliga, com null) o aviso entre instâncias. Quem registra é o módulo de segurança de conteúdo, só com a
 * checagem de imagem ligada; sem registro, invalidateActiveUser vale só para este processo (como antes).
 */
export function setActiveUserBroadcast(
  broadcast: ActiveUserBroadcast | null,
): void {
  activeUserBroadcast = broadcast;
}

/** Esquece a conta no cache deste processo e avisa as outras instâncias, quando o aviso está ligado. */
export function invalidateActiveUser(userId: string): void {
  activeUserCache.invalidate(userId);
  if (!activeUserBroadcast) return;
  try {
    activeUserBroadcast(userId);
  } catch {
    // o aviso é melhor esforço: a conta já está gravada como inativa e o cache das outras instâncias vence sozinho
  }
}

/** Só este processo: quem recebe o aviso de outra instância chama isto (sem reenviar o aviso). */
export function invalidateActiveUserLocally(userId: string): void {
  activeUserCache.invalidate(userId);
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly logger = new Logger(JwtStrategy.name);
  private readonly activeUsers: ActiveUserCache;

  constructor(
    private configService: ConfigService,
    private readonly prisma: PrismaService,
    // sem provider no módulo, usa o cache único do processo (o que a exclusão invalida); os testes passam um próprio
    @Optional() activeUsers?: ActiveUserCache,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
    this.activeUsers = activeUsers ?? activeUserCache;
  }

  /**
   * Token válido não basta: a conta precisa existir e estar ativa. Conta bloqueada (guarda legal, exclusão, admin)
   * perde o acesso em até 1 minuto, sem esperar o token de 15 minutos vencer.
   */
  async validate(payload: JwtAccessPayload) {
    const userId = typeof payload?.sub === 'string' ? payload.sub : '';
    if (!userId) {
      throw new UnauthorizedException({
        code: 'INVALID_TOKEN',
        message: 'Sessão inválida. Entre de novo.',
      });
    }

    let active: boolean;
    try {
      active = await this.activeUsers.resolve(userId, (id) =>
        this.isUserActive(id),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `jwt: não deu para conferir se a conta ${userId} está ativa: ${reason.slice(0, 300)}`,
      );
      // 503, não 401: banco fora do ar não pode deslogar todo mundo, e sem a conferência o acesso não passa
      throw new ServiceUnavailableException({
        code: 'AUTH_CHECK_UNAVAILABLE',
        message:
          'Não deu para conferir a sua sessão agora. Tente de novo em instantes.',
      });
    }
    if (!active) throw accountDisabledException();

    return { sub: userId, email: payload.email, role: payload.role };
  }

  private async isUserActive(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isActive: true },
    });
    return user?.isActive === true;
  }
}
