import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreditTransactionType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from './credits.service';
import { CreditBalanceResponseDto } from './dto/credit-balance-response.dto';

export const DAILY_CREDITS_ENV = 'DAILY_CREDITS_AMOUNT';

/** `source` gravado no extrato: é o que identifica um claim diário (sem migration). */
export const DAILY_CREDITS_SOURCE = 'daily';

/**
 * Tipo de transação reaproveitado (WEEKLY_BONUS = "bônus recorrente"). Um valor de
 * enum próprio (DAILY_BONUS) exigiria migration; o claim é identificado por
 * type + source 'daily', então dá para migrar depois sem perder histórico.
 */
const DAILY_CREDITS_TX_TYPE = CreditTransactionType.WEEKLY_BONUS;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DailyCreditsStatus {
  enabled: boolean;
  amount: number;
  claimedToday: boolean;
  streakDays: number;
}

export interface DailyClaimResult {
  granted: number;
  streakDays: number;
  balance: CreditBalanceResponseDto;
}

interface LastClaim {
  dayKey: string;
  streakDays: number;
}

/** Dia UTC no formato YYYY-MM-DD. */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function previousUtcDayKey(date: Date): string {
  return utcDayKey(new Date(date.getTime() - DAY_MS));
}

/**
 * "Créditos de hoje" (molde CreatePorn: gems diárias): 1 claim por dia UTC,
 * crédito de bônus (não expira), com sequência de dias consecutivos.
 *
 * - Env DAILY_CREDITS_AMOUNT (inteiro). Ausente, inválida ou <= 0 => DESLIGADO.
 * - Sem tabela nova: o claim é uma CreditTransaction (WEEKLY_BONUS, source 'daily')
 *   com metadata { dayKey, streakDays }. A corrida de dois claims simultâneos é
 *   serializada por advisory lock por usuário dentro da transaction (mesmo padrão
 *   de PaymentsService.lockExternalPayment).
 * - Só conta ativa e com e-mail verificado (barreira contra farm de contas).
 */
@Injectable()
export class DailyCreditsService {
  private readonly logger = new Logger(DailyCreditsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly creditsService: CreditsService,
  ) {}

  /** Créditos por dia configurados (0 = feature desligada). */
  getConfiguredAmount(): number {
    const raw = this.configService.get<string>(DAILY_CREDITS_ENV);
    if (raw == null || String(raw).trim() === '') return 0;
    const parsed = Number.parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return parsed;
  }

  async getStatus(userId: string, now: Date = new Date()): Promise<DailyCreditsStatus> {
    const amount = this.getConfiguredAmount();
    if (amount <= 0) {
      return { enabled: false, amount: 0, claimedToday: false, streakDays: 0 };
    }

    const last = await this.findLastClaim(this.prisma, userId);
    const today = utcDayKey(now);
    // A sequência segue viva se o último claim foi hoje ou ontem; passou disso, zerou.
    const streakAlive =
      last !== null && (last.dayKey === today || last.dayKey === previousUtcDayKey(now));

    return {
      enabled: true,
      amount,
      claimedToday: last?.dayKey === today,
      streakDays: last !== null && streakAlive ? last.streakDays : 0,
    };
  }

  async claim(userId: string, now: Date = new Date()): Promise<DailyClaimResult> {
    const amount = this.getConfiguredAmount();
    if (amount <= 0) {
      throw new NotFoundException({
        code: 'DAILY_CREDITS_DISABLED',
        message: 'Os créditos diários não estão ativos.',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isActive: true, emailVerified: true },
    });
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }
    if (!user.isActive) {
      throw new ForbiddenException({
        code: 'ACCOUNT_SUSPENDED',
        message: 'Conta suspensa: não é possível resgatar créditos.',
      });
    }
    if (!user.emailVerified) {
      throw new ForbiddenException({
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Confirme seu e-mail para resgatar os créditos de hoje.',
      });
    }

    const today = utcDayKey(now);
    const yesterday = previousUtcDayKey(now);

    const streakDays = await this.prisma.$transaction(async (tx) => {
      // Serializa claims simultâneos do mesmo usuário (duplo clique, 2 abas, script).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`daily-credits:${userId}`}, 0))`;

      const last = await this.findLastClaim(tx, userId);
      if (last?.dayKey === today) {
        throw new ConflictException({
          code: 'DAILY_ALREADY_CLAIMED',
          message: 'Você já pegou os créditos de hoje. Volte amanhã.',
        });
      }

      const newStreak = last?.dayKey === yesterday ? last.streakDays + 1 : 1;

      await tx.creditBalance.upsert({
        where: { userId },
        create: {
          userId,
          bonusCreditsRemaining: amount,
          planCreditsRemaining: 0,
          planCreditsUsed: 0,
        },
        update: { bonusCreditsRemaining: { increment: amount } },
      });

      await tx.creditTransaction.create({
        data: {
          userId,
          type: DAILY_CREDITS_TX_TYPE,
          amount,
          source: DAILY_CREDITS_SOURCE,
          description: 'Créditos de hoje',
          metadata: { dayKey: today, streakDays: newStreak },
        },
      });

      return newStreak;
    });

    this.logger.log(
      `Créditos diários concedidos: userId=${userId} amount=${amount} streak=${streakDays}`,
    );

    const balance = await this.creditsService.getBalance(userId);
    return { granted: amount, streakDays, balance };
  }

  /** Último claim do usuário (dia UTC + sequência gravada), ou null se nunca pegou. */
  private async findLastClaim(
    client: Pick<Prisma.TransactionClient, 'creditTransaction'>,
    userId: string,
  ): Promise<LastClaim | null> {
    const row = await client.creditTransaction.findFirst({
      where: { userId, type: DAILY_CREDITS_TX_TYPE, source: DAILY_CREDITS_SOURCE },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, metadata: true },
    });
    if (!row) return null;

    const metadata =
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {};
    const dayKey = typeof metadata.dayKey === 'string' ? metadata.dayKey : utcDayKey(row.createdAt);
    const streakDays =
      typeof metadata.streakDays === 'number' && metadata.streakDays > 0 ? metadata.streakDays : 1;
    return { dayKey, streakDays };
  }
}
