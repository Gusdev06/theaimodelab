import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Chaves conhecidas da tabela app_settings. Centralizadas aqui pra evitar
 * strings soltas espalhadas entre crons, controllers e frontend.
 */
export const SETTING_KEYS = {
  /** Liga/desliga o cron das sequências automáticas de email (onboarding + pós-assinatura). */
  onboardingSequenceEnabled: 'onboarding_sequence_enabled',
  /** Créditos de boas-vindas concedidos no cadastro (0 ou ausente = desligado). */
  welcomeCreditsAmount: 'welcome_credits_amount',
  /** Créditos que quem indicou ganha por indicado que conclui a 1ª geração (0 = desligado; ausente = env/200). */
  referralRewardCredits: 'referral_reward_credits',
  /** Indicações premiadas por indicador antes de as próximas irem para revisão do admin. */
  referralMaxRewardsPerReferrer: 'referral_max_rewards_per_referrer',
  /** Indicações premiadas por indicador em 24 h; o excedente espera o dia seguinte. */
  referralMaxRewardsPerDay: 'referral_max_rewards_per_day',
  /** Indicações premiadas na plataforma inteira em 24 h; acima disso tudo vai para revisão (disjuntor anti-farm). */
  referralMaxRewardsGlobalPerDay: 'referral_max_rewards_global_per_day',
} as const;

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Valor cru da chave; undefined = a linha não existe (o chamador separa "ausente" de "inválido"). */
  async getRaw(key: string): Promise<string | undefined> {
    const row = await this.prisma.appSetting.findUnique({ where: { key } });
    return row ? row.value : undefined;
  }

  async getBool(key: string, defaultValue: boolean): Promise<boolean> {
    const row = await this.prisma.appSetting.findUnique({ where: { key } });
    if (!row) return defaultValue;
    return row.value === 'true';
  }

  async setBool(key: string, value: boolean): Promise<void> {
    const str = value ? 'true' : 'false';
    await this.prisma.appSetting.upsert({
      where: { key },
      update: { value: str },
      create: { key, value: str },
    });
  }

  /**
   * Lê um inteiro. Retorna `defaultValue` se a chave não existe; retorna null
   * se a linha existe mas o valor não é um inteiro válido (o chamador decide
   * o fallback).
   */
  async getInt(key: string, defaultValue: number): Promise<number | null> {
    const row = await this.prisma.appSetting.findUnique({ where: { key } });
    if (!row) return defaultValue;
    const parsed = Number.parseInt(row.value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async setInt(key: string, value: number): Promise<void> {
    const str = String(Math.trunc(value));
    await this.prisma.appSetting.upsert({
      where: { key },
      update: { value: str },
      create: { key, value: str },
    });
  }
}
