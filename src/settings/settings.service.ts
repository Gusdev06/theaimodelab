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
} as const;

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

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
