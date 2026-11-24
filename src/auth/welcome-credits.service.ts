import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService, SETTING_KEYS } from '../settings/settings.service';

/**
 * A/B das boas-vindas (dono 23/11/2026). Desde 16/11 a 1ª foto sem censura 2K custa 235 e a conta nova ganha
 * 50 + 150 = 200: a ativação em 48 h caiu de 71–80% para 23–29%, mas o pagante por conta nova subiu de 2,6% para
 * 5,7% no mesmo período. Por isso é teste, não troca: `WELCOME_CREDITS_AB_PCT` (0–100; vazio/0 = desligado) é a
 * fatia de contas que ganha `WELCOME_CREDITS_AB_EXTRA` créditos a mais (padrão 50, o que paga a 1ª foto 2K).
 * Sorteio fixo por conta (hash do id). A variante fica no extrato: o `amount` da transação `welcome_credits`
 * (base = A, base + extra = B), então a leitura não precisa de tabela nova.
 */
export function welcomeAbExtraFor(userId: string, pctRaw?: string | null, extraRaw?: string | null): number {
  const pct = Number.parseInt(String(pctRaw ?? '').trim(), 10);
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  const extraText = String(extraRaw ?? '').trim();
  const extra = extraText === '' ? 50 : Number.parseInt(extraText, 10);
  if (!Number.isFinite(extra) || extra <= 0) return 0;
  const bucket = createHash('sha256').update(`welcome-ab:${userId}`).digest().readUInt32BE(0) % 100;
  return bucket < Math.min(pct, 100) ? extra : 0;
}

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

  /** Créditos a mais do A/B das boas-vindas para esta conta (0 = variante A ou teste desligado). */
  private abExtraFor(userId: string): number {
    return welcomeAbExtraFor(
      userId,
      this.configService.get<string>('WELCOME_CREDITS_AB_PCT'),
      this.configService.get<string>('WELCOME_CREDITS_AB_EXTRA'),
    );
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
      return (await this.alreadyGranted(userId)) ? 0 : amount + this.abExtraFor(userId);
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
      const baseAmount = await this.getConfiguredAmount();
      if (baseAmount <= 0) {
        // Feature desligada (default). Não faz nada.
        return 0;
      }
      // A/B das boas-vindas: a variante B leva o extra na MESMA transação (o amount do extrato marca a variante).
      const abExtra = this.abExtraFor(userId);
      const amount = baseAmount + abExtra;

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
        `Welcome credits granted: userId=${userId} amount=${amount}${abExtra > 0 ? ` [AB_BOAS_VINDAS] B +${abExtra}` : ''}`,
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
