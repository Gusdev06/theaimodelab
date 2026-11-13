import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService, SETTING_KEYS } from '../settings/settings.service';

/**
 * Concede créditos de boas-vindas (bônus, nunca expiram) a novos usuários,
 * dando a eles saldo suficiente para viver a primeira geração antes de pagar.
 *
 * - Controlado pela chave `welcome_credits_amount` na tabela `app_settings`
 *   (ajustável em runtime, sem deploy). Se a chave não existe, cai no env
 *   `WELCOME_CREDITS_AMOUNT` (compatibilidade). Valor inválido ou <= 0 em
 *   qualquer fonte => feature DESLIGADA (default OFF).
 * - Concessão atômica ($transaction): incrementa bonusCreditsRemaining no
 *   CreditBalance (upsert) + registra CreditTransaction (ONBOARDING_BONUS).
 * - Idempotente: nunca concede 2x para o mesmo usuário (marcador
 *   description === WELCOME_CREDITS_MARKER no ledger).
 * - Falha na concessão NUNCA quebra o signup (o chamador faz fire-and-forget /
 *   este método captura e loga qualquer erro).
 * - Quando cai (jornada 13/11): cadastro por e-mail recebe na CONFIRMAÇÃO do e-mail
 *   (AuthService.verifyEmail); Google, que já vem verificado, recebe no cadastro.
 *   Assim a conta entra no app sem a tela de código e o bônus maior não vira
 *   brecha para conta em série com e-mail falso.
 */
@Injectable()
export class WelcomeCreditsService {
  private readonly logger = new Logger(WelcomeCreditsService.name);

  /** Marcador usado como description da transação, também usado para idempotência. */
  static readonly WELCOME_CREDITS_MARKER = 'welcome_credits';

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly settings: SettingsService,
  ) {}

  /** Quantidade configurada via env (fallback quando não há linha no banco). */
  private getEnvAmount(): number {
    const raw = this.configService.get<string>('WELCOME_CREDITS_AMOUNT');
    if (raw == null || raw === '') return 0;
    const parsed = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return parsed;
  }

  /**
   * Quantidade configurada de créditos de boas-vindas (0 = feature OFF).
   * Banco (app_settings.welcome_credits_amount) manda; sem linha, vale o env.
   */
  async getConfiguredAmount(): Promise<number> {
    // Chave ausente => sentinela -1 e cai no env; linha com valor inválido => null => OFF.
    const fromDb = await this.settings.getInt(
      SETTING_KEYS.welcomeCreditsAmount,
      -1,
    );
    if (fromDb === null) return 0;
    if (fromDb >= 0) return fromDb;
    return this.getEnvAmount();
  }

  /** True se a conta já recebeu os créditos de boas-vindas. */
  private async alreadyGranted(userId: string): Promise<boolean> {
    const existing = await this.prisma.creditTransaction.findFirst({
      where: {
        userId,
        type: 'ONBOARDING_BONUS',
        description: WelcomeCreditsService.WELCOME_CREDITS_MARKER,
      },
      select: { id: true },
    });
    return existing !== null;
  }

  /**
   * Quanto a conta ainda vai receber ao confirmar o e-mail (0 = feature desligada ou
   * já recebeu). Usado na promessa do e-mail do código ("+150 créditos"). Nunca lança.
   */
  async pendingAmountFor(userId: string): Promise<number> {
    try {
      const amount = await this.getConfiguredAmount();
      if (amount <= 0) return 0;
      return (await this.alreadyGranted(userId)) ? 0 : amount;
    } catch (err) {
      this.logger.warn(
        `pendingAmountFor(${userId}) falhou: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * Concede os créditos de boas-vindas ao usuário, se a feature estiver ligada
   * e o usuário ainda não os tiver recebido. Nunca lança — sempre resolve.
   * Devolve quantos créditos entraram agora (0 = nada concedido nesta chamada).
   */
  async grantIfEligible(userId: string): Promise<number> {
    try {
      const amount = await this.getConfiguredAmount();
      if (amount <= 0) {
        // Feature desligada (default). Não faz nada.
        return 0;
      }

      // Idempotência: já concedido antes?
      if (await this.alreadyGranted(userId)) {
        return 0;
      }

      const granted = await this.prisma.$transaction(async (tx) => {
        // Re-checa dentro da transação para reduzir corrida entre chamadas
        // concorrentes (ex.: dois signups/logins quase simultâneos).
        const already = await tx.creditTransaction.findFirst({
          where: {
            userId,
            type: 'ONBOARDING_BONUS',
            description: WelcomeCreditsService.WELCOME_CREDITS_MARKER,
          },
          select: { id: true },
        });

        if (already) {
          return false;
        }

        await tx.creditBalance.upsert({
          where: { userId },
          create: {
            userId,
            bonusCreditsRemaining: amount,
          },
          update: {
            bonusCreditsRemaining: { increment: amount },
          },
        });

        await tx.creditTransaction.create({
          data: {
            userId,
            type: 'ONBOARDING_BONUS',
            amount,
            source: 'bonus',
            description: WelcomeCreditsService.WELCOME_CREDITS_MARKER,
          },
        });
        return true;
      });

      if (!granted) return 0;
      this.logger.log(
        `Welcome credits granted: userId=${userId} amount=${amount}`,
      );
      return amount;
    } catch (err) {
      // Falha na concessão NÃO pode quebrar o signup.
      this.logger.error(
        `Failed to grant welcome credits for userId=${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    }
  }
}
