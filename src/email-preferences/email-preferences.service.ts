import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { signUnsubscribe, verifyUnsubscribe } from './unsubscribe-token.util';

@Injectable()
export class EmailPreferencesService {
  private readonly logger = new Logger(EmailPreferencesService.name);
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.secret =
      this.config.get<string>('EMAIL_UNSUBSCRIBE_SECRET') ||
      this.config.get<string>('JWT_ACCESS_SECRET') ||
      'insecure-fallback-secret-change-me';
  }

  sign(email: string): string {
    return signUnsubscribe(email, this.secret);
  }

  /**
   * Verifica o token e marca o usuário como opt-out de marketing.
   * Retorna true se o token era válido (idempotente — re-clicar não quebra).
   */
  async unsubscribe(email: string, token: string): Promise<boolean> {
    const normalized = (email || '').trim().toLowerCase();
    if (!normalized || !verifyUnsubscribe(normalized, token, this.secret)) {
      return false;
    }
    // updateMany não estoura se o email não existir — mantém idempotente/seguro.
    const res = await this.prisma.user.updateMany({
      where: { email: normalized },
      data: { marketingOptOut: true },
    });
    this.logger.log(`Unsubscribe marketing: ${normalized} (${res.count} row)`);
    return true;
  }
}
