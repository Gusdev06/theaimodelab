import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { CreditTransactionType, GenerationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { CronLoggerService } from './cron-logger.service';
import { firstUrl, ORIGIN_SITE_URL, resolveBrand } from '../brand/brand';
import { brandBannerUrl, mailLocaleFor } from '../email/brand-email';
import { buildFirstGenerationEmail, FirstGenerationEmailKind } from '../email-sequences/first-generation-templates';

/** A cada 10 min. */
const SCHEDULE = '*/10 * * * *';
/** Mesma chave dos e-mails de ciclo de vida (já true em produção). */
const ENABLED_ENV = 'LIFECYCLE_EMAILS_ENABLED';
const SEQUENCE_NAME = 'first_generation';
/** O aviso sai ~10 min depois de a geração terminar (tempo de a cliente voltar sozinha). */
const DELAY_MINUTES = 10;
/** Janela de busca depois do atraso: geração mais velha que isso não ganha aviso (sem rajada retroativa). */
const WINDOW_MINUTES = 60;
/** "Pronta" só avisa se a geração levou mais que isso (a rápida a cliente viu na tela). */
const MIN_DURATION_MS = 60_000;
/** Teto por rodada. */
const BATCH = 200;
/**
 * Geração que termina na janela foi criada no máximo há tanto tempo. Limita a busca pelo índice de created_at
 * (completed_at e updated_at não têm índice; sem isso, cada rodada varreria todas as gerações concluídas).
 */
const MAX_RUNTIME_MS = 3 * 60 * 60_000;

const keyFor = (kind: FirstGenerationEmailKind, userId: string) => `first-gen-${kind}-${userId}`;

interface Candidate {
  id: string;
  userId: string;
  createdAt: Date;
  completedAt: Date | null;
  updatedAt: Date;
  user: { email: string; locale: string | null; country: string | null; signupBrand: string | null };
}

/**
 * Aviso da 1ª cena (D-04): "ficou pronta" para a 1ª geração CONCLUÍDA da conta que levou > 60 s, e "não saiu, os
 * créditos voltaram" para a 1ª falha com estorno registrado. Sem schema novo: a idempotência é a tabela
 * email_sequence_logs (único por conta + chave), gravada ANTES do envio para duas instâncias nunca mandarem 2×.
 * Quem já voltou e gerou de novo depois não recebe (ela já viu). Só roda com LIFECYCLE_EMAILS_ENABLED=true.
 */
@Injectable()
export class FirstGenerationEmailsService {
  private readonly logger = new Logger(FirstGenerationEmailsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    private readonly cronLogger: CronLoggerService,
  ) {}

  @Cron(SCHEDULE)
  async processFirstGenerationEmails(): Promise<void> {
    if (this.configService.get<string>(ENABLED_ENV) !== 'true') return;
    try {
      await this.cronLogger.wrap(
        { cronName: 'FirstGenerationEmailsService.processFirstGenerationEmails', schedule: SCHEDULE },
        async () => this.runOnce(new Date()),
      );
    } catch (err) {
      this.logger.error(`processFirstGenerationEmails falhou: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Uma rodada (público para teste). */
  async runOnce(now: Date): Promise<{ ready: number; failed: number }> {
    const appUrl = firstUrl(this.configService.get<string>('FRONTEND_URL')) || ORIGIN_SITE_URL;
    const to = new Date(now.getTime() - DELAY_MINUTES * 60_000);
    const from = new Date(to.getTime() - WINDOW_MINUTES * 60_000);
    const ready = await this.processReady(from, to, appUrl);
    const failed = await this.processFailed(from, to, appUrl);
    if (ready + failed > 0) this.logger.log(`Aviso da 1ª cena: ${ready} pronta(s), ${failed} falha(s)`);
    return { ready, failed };
  }

  private candidateSelect() {
    return {
      id: true,
      userId: true,
      createdAt: true,
      completedAt: true,
      updatedAt: true,
      user: { select: { email: true, locale: true, country: true, signupBrand: true } },
    } as const;
  }

  private async processReady(from: Date, to: Date, appUrl: string): Promise<number> {
    const candidates: Candidate[] = await this.prisma.generation.findMany({
      where: {
        status: GenerationStatus.COMPLETED,
        createdAt: { gte: new Date(from.getTime() - MAX_RUNTIME_MS) },
        completedAt: { gte: from, lte: to },
        isDeleted: false,
        user: {
          isActive: true,
          emailSequenceLogs: { none: { sequence: SEQUENCE_NAME, emailKey: { startsWith: 'first-gen-ready-' } } },
          // Pré-filtro no banco: quem já tinha cena concluída antes da janela não é 1ª vez. Sem isso, as contas que
          // geram muito ocupam o lote de 200 e a cliente nova do fim da janela nunca é vista.
          generations: { none: { status: GenerationStatus.COMPLETED, completedAt: { lt: from } } },
        },
      },
      orderBy: { completedAt: 'asc' },
      take: BATCH,
      select: this.candidateSelect(),
    });

    let sent = 0;
    const seen = new Set<string>();
    for (const gen of candidates) {
      if (seen.has(gen.userId) || !gen.completedAt) continue;
      seen.add(gen.userId);
      if (gen.completedAt.getTime() - gen.createdAt.getTime() <= MIN_DURATION_MS) continue;

      // Só a 1ª concluída da conta.
      const earlier = await this.prisma.generation.count({
        where: { userId: gen.userId, status: GenerationStatus.COMPLETED, completedAt: { lt: gen.completedAt } },
      });
      if (earlier > 0) continue;
      // Já voltou e gerou de novo: ela viu.
      if (await this.cameBack(gen.userId, gen.completedAt)) continue;

      if (await this.send('ready', gen, appUrl)) sent++;
    }
    return sent;
  }

  private async processFailed(from: Date, to: Date, appUrl: string): Promise<number> {
    const candidates: Candidate[] = await this.prisma.generation.findMany({
      where: {
        status: GenerationStatus.FAILED,
        createdAt: { gte: new Date(from.getTime() - MAX_RUNTIME_MS) },
        updatedAt: { gte: from, lte: to },
        isDeleted: false,
        user: {
          isActive: true,
          emailSequenceLogs: { none: { sequence: SEQUENCE_NAME, emailKey: { startsWith: 'first-gen-failed-' } } },
          // Pré-filtro no banco (a regra exata fica no laço abaixo): conta com cena concluída antes da janela fica fora.
          generations: { none: { status: GenerationStatus.COMPLETED, completedAt: { lt: from } } },
        },
      },
      orderBy: { updatedAt: 'asc' },
      take: BATCH,
      select: this.candidateSelect(),
    });

    let sent = 0;
    const seen = new Set<string>();
    for (const gen of candidates) {
      if (seen.has(gen.userId)) continue;
      seen.add(gen.userId);

      // 1ª cena da conta: nenhuma falha antes e nenhuma concluída antes.
      const before = await this.prisma.generation.count({
        where: {
          userId: gen.userId,
          createdAt: { lt: gen.createdAt },
          status: { in: [GenerationStatus.FAILED, GenerationStatus.COMPLETED] },
        },
      });
      if (before > 0) continue;
      if (await this.cameBack(gen.userId, gen.createdAt)) continue;

      // "Os créditos voltaram" só com o estorno gravado.
      const refunds = await this.prisma.creditTransaction.count({
        where: { generationId: gen.id, type: CreditTransactionType.GENERATION_REFUND },
      });
      if (refunds === 0) continue;

      if (await this.send('failed', gen, appUrl)) sent++;
    }
    return sent;
  }

  /** A conta criou outra geração depois deste momento. */
  private async cameBack(userId: string, after: Date): Promise<boolean> {
    const later = await this.prisma.generation.count({ where: { userId, createdAt: { gt: after } } });
    return later > 0;
  }

  private async send(kind: FirstGenerationEmailKind, gen: Candidate, appUrl: string): Promise<boolean> {
    const emailKey = keyFor(kind, gen.userId);
    // Reserva antes de enviar (único por conta + chave): outra instância que chegar junto bate no P2002 e sai.
    let logId: string;
    try {
      const log = await this.prisma.emailSequenceLog.create({
        data: { userId: gen.userId, sequence: SEQUENCE_NAME, emailKey },
        select: { id: true },
      });
      logId = log.id;
    } catch (err: any) {
      if (err?.code === 'P2002') return false;
      this.logger.error(`Aviso ${emailKey}: não reservei o envio: ${err?.message ?? String(err)}`);
      return false;
    }

    const brand = resolveBrand(gen.user.signupBrand);
    const locale = mailLocaleFor(gen.user);
    const { subject, html } = buildFirstGenerationEmail(kind, locale, {
      appUrl,
      bannerUrl: brand.key === 'taml' ? brandBannerUrl(locale, gen.user.email) : null,
    });

    try {
      const { id } = await this.emailService.sendRawEmail({ to: gen.user.email, subject, html, brand });
      if (!id) throw new Error('serviço de e-mail não configurado');
      await this.prisma.emailSequenceLog.update({ where: { id: logId }, data: { resendEmailId: id } });
      return true;
    } catch (err: any) {
      // Não saiu: libera a reserva para a próxima rodada tentar de novo (dentro da janela).
      await this.prisma.emailSequenceLog.delete({ where: { id: logId } }).catch(() => undefined);
      this.logger.error(`Aviso ${emailKey} falhou para ${gen.user.email}: ${err?.message ?? String(err)}`);
      return false;
    }
  }
}
