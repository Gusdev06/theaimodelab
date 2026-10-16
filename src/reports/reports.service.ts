import {
  BadRequestException, BeforeApplicationShutdown, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ContentReport, ContentReportCategory, ContentReportStatus, Prisma } from '@prisma/client';
import { createHmac, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { assessText } from '../content-safety/minor-guard';
import type { CreateReportDto, UpdateReportDto } from './dto/create-report.dto';
import { buildUrgentDigest, type DigestReport, type UrgentReason } from './reports-alert-digest';
import { ReportsRateLimiter, type ReportLane } from './reports-rate-limiter';

export type { UrgentReason } from './reports-alert-digest';

/** Categorias que pedem ação em horas, não em dias (menor e imagem íntima sem consentimento). */
export const URGENT_CATEGORIES: ReadonlySet<ContentReportCategory> = new Set([
  ContentReportCategory.MINOR,
  ContentReportCategory.NON_CONSENSUAL,
]);

/**
 * Categorias em que a própria pessoa retratada denunciando também vira urgente (imagem íntima sem consentimento e
 * uso da imagem dela). Fora delas, marcar "sou a pessoa" não muda o prazo: senão qualquer um forçava o aviso de 24 h
 * marcando a caixa numa denúncia de outra categoria.
 */
export const DEPICTED_PERSON_URGENT_CATEGORIES: ReadonlySet<ContentReportCategory> = new Set([
  ContentReportCategory.NON_CONSENSUAL,
  ContentReportCategory.IMPERSONATION,
]);

/** Fila aberta do admin: ainda pedem ação. */
const OPEN_STATUSES: ContentReportStatus[] = [ContentReportStatus.OPEN, ContentReportStatus.IN_REVIEW];
/** Encerradas: o andamento grava quando encerrou (handledAt). A evidência só é liberada da confirmada (ACTIONED). */
const CLOSED_STATUSES: ContentReportStatus[] = [ContentReportStatus.ACTIONED, ContentReportStatus.DISMISSED];

/*
 * Estado do aviso por e-mail (alertSentAt / alertError / alertAttempts):
 * - pendente: alertError null (o aviso logo depois da resposta ainda vai sair, ou a API reiniciou antes);
 * - reservado: alertError 'sending' (um processo está mandando; vence em ALERT_CLAIM_STALE_MS);
 * - no resumo: alertError ALERT_DIGEST_QUEUED (teto de avisos avulsos da hora, ou várias do mesmo cliente);
 * - sem destinatário: alertError ALERT_NO_RECIPIENT (sai quando REPORTS_ALERT_EMAIL existir; não gasta tentativa);
 * - falhou: alertError = motivo; a varredura tenta de novo com espera crescente até ALERT_MAX_ATTEMPTS tentativas;
 * - avisado: alertSentAt preenchido.
 * Cada reserva soma uma tentativa (alertAttempts), inclusive a que caiu no meio do envio.
 */

/**
 * Aviso por e-mail reservado por um processo (alertError = 'sending'): ninguém mais manda o mesmo aviso. Se o processo
 * cair no meio, a reserva vence em ALERT_CLAIM_STALE_MS e a varredura (retryPendingAlerts) manda de novo.
 */
export const ALERT_SENDING = 'sending';
/** Denúncia urgente que espera o resumo da varredura (sem aviso avulso). */
export const ALERT_DIGEST_QUEUED = 'aguardando o resumo de denúncias urgentes (teto de avisos da hora ou várias do mesmo cliente)';
/** REPORTS_ALERT_EMAIL ausente: a denúncia espera a variável existir (não conta como tentativa). */
export const ALERT_NO_RECIPIENT = 'REPORTS_ALERT_EMAIL ausente';
/** reserva de aviso parada há mais que isso = o processo caiu no meio do envio */
export const ALERT_CLAIM_STALE_MS = 10 * 60_000;
/** a varredura só pega denúncia pendente com pelo menos 2 min (o aviso logo depois da resposta ainda está saindo) */
export const ALERT_RETRY_MIN_AGE_MS = 2 * 60_000;
/** e no máximo 48 h: aviso mais velho que isso já não serve de alerta (a denúncia está no admin e no cockpit) */
export const ALERT_RETRY_MAX_AGE_MS = 48 * 3_600_000;
/** tentativas de aviso por denúncia (o aviso logo depois da resposta e as da varredura somadas) */
export const ALERT_MAX_ATTEMPTS = 5;
/** espera depois da 1ª, 2ª, 3ª e 4ª tentativa que falhou, contada da falha: 5, 15, 45 e 120 min */
export const ALERT_RETRY_BACKOFF_MS: readonly number[] = [5, 15, 45, 120].map((minutes) => minutes * 60_000);
/** um resumo a cada 10 min (com 30 s de folga: a varredura roda de 5 em 5 min e o relógio dela anda um pouco) */
export const ALERT_DIGEST_INTERVAL_MS = 10 * 60_000;
const ALERT_DIGEST_SLACK_MS = 30_000;
/** denúncias lidas por varredura; as que passam do teto de avisos avulsos vão todas no mesmo resumo */
export const ALERT_SCAN_BATCH = 1_000;
/** "REPORTS_ALERT_EMAIL ausente" no log da varredura: no máximo 1 vez por hora */
const NO_RECIPIENT_LOG_EVERY_MS = 60 * 60_000;

/** Estados com significado próprio em alertError (o resto é motivo de falha). */
const ALERT_STATES = [ALERT_SENDING, ALERT_DIGEST_QUEUED, ALERT_NO_RECIPIENT];

export type ReportsSort = 'newest' | 'oldest';
export const REPORTS_SORTS: readonly ReportsSort[] = ['newest', 'oldest'];

export interface AlertSweepResult {
  /** avisos avulsos enviados */
  sent: number;
  /** denúncias com aviso (avulso ou resumo) que falhou nesta rodada */
  failed: number;
  /** denúncias que outro processo já pegou */
  skipped: number;
  /** denúncias avisadas no resumo */
  digested: number;
  /** denúncias que esperam o próximo resumo (o desta janela de 10 min já saiu) */
  waiting: number;
}

/** Denúncia como o admin vê: a linha gravada + por que é urgente (calculado agora, com a guarda atual). */
export type AdminReport = ContentReport & { citesMinor: boolean; urgentReasons: UrgentReason[] };

/** O texto cita menor (termo ou idade)? Tamanho não conta: o DTO já limita descrição e alvo. */
function citesMinor(text: string): boolean {
  const assessment = assessText(text);
  return assessment.blocked && (assessment.reason === 'term' || assessment.reason === 'age');
}

/** Descrição ou alvo cita menor: a mesma conferência que deixa a denúncia urgente. */
export function reportCitesMinor(input: { target: string; description: string }): boolean {
  return citesMinor(input.description) || citesMinor(input.target);
}

type UrgencyInput = {
  category: ContentReportCategory;
  isDepictedPerson?: boolean | null;
  target: string;
  description: string;
};

/**
 * Prazo de 24 h: categoria urgente (menor, imagem íntima sem consentimento), a própria pessoa que aparece no
 * conteúdo denunciando imagem íntima sem consentimento ou uso da imagem dela, ou descrição/alvo que cita menor (a
 * mesma guarda das gerações), qualquer que seja a categoria escolhida.
 */
export function isUrgentReport(input: UrgencyInput): boolean {
  if (URGENT_CATEGORIES.has(input.category)) return true;
  if (input.isDepictedPerson === true && DEPICTED_PERSON_URGENT_CATEGORIES.has(input.category)) return true;
  return reportCitesMinor(input);
}

/** Todos os motivos de urgência da denúncia (vazio = não urgente). Mesma regra de isUrgentReport, sem atalho. */
export function urgentReasons(input: UrgencyInput, cites: boolean = reportCitesMinor(input)): UrgentReason[] {
  const reasons: UrgentReason[] = [];
  if (URGENT_CATEGORIES.has(input.category)) reasons.push('category');
  if (input.isDepictedPerson === true && DEPICTED_PERSON_URGENT_CATEGORIES.has(input.category)) reasons.push('depicted_person');
  if (cites) reasons.push('cites_minor');
  return reasons;
}

/** A linha do admin com citesMinor e urgentReasons (o cockpit usa para saber se a denúncia fura o mudo). */
export function toAdminReport(report: ContentReport): AdminReport {
  const cites = reportCitesMinor(report);
  return { ...report, citesMinor: cites, urgentReasons: urgentReasons(report, cites) };
}

/**
 * Faixa da denúncia no limite: isca preenchida = robô (janelas próprias, nunca gasta o limite de humano); urgente
 * (menor, íntima sem consentimento, a própria pessoa retratada ou texto que cita menor) = só o teto que protege o
 * banco, nunca recusada pela enxurrada comum nem pelo limite por cliente; o resto = comum.
 */
export function reportLane(input: { urgent: boolean; suspectedBot: boolean }): ReportLane {
  if (input.suspectedBot) return 'bot';
  return input.urgent ? 'priority' : 'standard';
}

/** Espera antes da próxima tentativa depois de `attempts` tentativas (null = acabaram as tentativas). */
export function alertRetryDelayMs(attempts: number): number | null {
  if (attempts >= ALERT_MAX_ATTEMPTS) return null;
  return ALERT_RETRY_BACKOFF_MS[Math.max(attempts, 1) - 1] ?? null;
}

/**
 * Id no formato do cuid do Prisma ("c" + 24 caracteres base36, começando pelo instante): a resposta à isca é igual
 * à de uma denúncia gravada, para o robô não aprender qual campo o denuncia.
 */
export function fakeReportId(): string {
  const time = Date.now().toString(36).padStart(8, '0').slice(-8);
  let rest = '';
  for (const byte of randomBytes(16)) rest += (byte % 36).toString(36);
  return `c${time}${rest}`;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Denúncias de conteúdo (canal público exigido pela política de remoção e pelos processadores de pagamento).
 *
 * Toda denúncia de humano é gravada; a urgente nunca é recusada pela enxurrada (só pelo teto de 5.000/h que protege
 * o banco). As urgentes avisam a equipe por e-mail (REPORTS_ALERT_EMAIL): no máximo 30 avisos avulsos por hora, logo
 * depois da resposta; passou disso, ou o mesmo cliente mandou mais de 5 em 10 min, a denúncia vai no resumo que a
 * varredura manda a cada 10 min ("N novas denúncias urgentes"). O resultado do aviso fica na própria denúncia. Aviso
 * que falhou é refeito pela varredura de 5 em 5 min com espera crescente (5, 15, 45, 120 min), até 5 tentativas e
 * enquanto a denúncia tiver menos de 48 h.
 *
 * A revisão e a remoção são feitas pela equipe no admin. Conteúdo denunciado como envolvendo menor NÃO é apagado
 * automaticamente: é retirado do ar pela equipe e a evidência é preservada para as autoridades até o admin liberar
 * (evidenceReleased, só com a denúncia confirmada; qualquer troca de status desfaz a liberação).
 */
@Injectable()
export class ReportsService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(ReportsService.name);
  /** avisos por e-mail em andamento (o desligamento do servidor espera por eles) */
  private readonly pendingAlerts = new Set<Promise<void>>();
  /** varredura de avisos perdidos em andamento (a seguinte não começa por cima) */
  private retrying = false;
  /** último resumo mandado por este processo (um a cada 10 min) */
  private lastDigestAt = Number.NEGATIVE_INFINITY;
  private lastNoRecipientLogAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
    private readonly limiter: ReportsRateLimiter,
  ) {}

  onModuleInit(): void {
    if (!this.config.get<string>('REPORTS_IP_SALT')) {
      this.logger.error(
        'REPORTS_IP_SALT ausente: as denúncias são gravadas sem o hash do IP. Defina uma chave secreta longa no ambiente.',
      );
    }
    if (this.config.get<string>('NODE_ENV') === 'production' && !this.alertRecipient()) {
      this.logger.error(
        'REPORTS_ALERT_EMAIL ausente em produção: denúncia urgente (menor, imagem íntima sem consentimento) não avisa a equipe por e-mail, só aparece no admin.',
      );
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.drainAlerts();
  }

  /** HMAC-SHA256 do IP com a chave secreta (nunca o IP puro). Sem a chave, não grava hash nenhum. */
  private hashIp(ip: string | null | undefined): string | null {
    const salt = this.config.get<string>('REPORTS_IP_SALT');
    if (!ip || !salt) return null;
    return createHmac('sha256', salt).update(ip).digest('hex').slice(0, 32);
  }

  private alertRecipient(): string | null {
    return this.config.get<string>('REPORTS_ALERT_EMAIL')?.trim() || null;
  }

  /**
   * Como a urgente avisa a equipe: aviso avulso logo depois da resposta, ou o resumo da varredura (cliente acima do
   * limite por cliente, ou teto de avisos avulsos da hora esgotado). Sem destinatário vai avulso, só para registrar o
   * motivo na denúncia, sem gastar o teto.
   */
  private alertRoute(input: { urgent: boolean; suspectedBot: boolean; overClientLimit: boolean }): 'none' | 'individual' | 'digest' {
    if (!input.urgent || input.suspectedBot) return 'none';
    if (input.overClientLimit) return 'digest';
    if (!this.alertRecipient()) return 'individual';
    return this.limiter.takeAlertSlot() ? 'individual' : 'digest';
  }

  /**
   * Recebe a denúncia. O limite vale para todo pedido (inclusive robô), antes de qualquer gravação, mas a isca é
   * olhada ANTES: robô cai na faixa dele e nunca gasta o limite de quem é humano, e denúncia urgente só esbarra no
   * teto que protege o banco (reportLane). A isca preenchida nunca se revela: a resposta é a mesma de uma denúncia
   * gravada.
   *
   * Urgente acima do limite por cliente (mais de 5 em 10 min): gravada assim mesmo (recusar a 6ª denúncia de menor de
   * quem divide o IP, ou da vítima denunciando várias imagens dela, é pior que gravar uma a mais), sem aviso avulso:
   * vai no resumo, então quem insiste não gasta o teto de avisos de todo mundo.
   */
  async create(dto: CreateReportDto, meta: { ip?: string | null; userId?: string | null }): Promise<{ ok: true; id: string }> {
    const target = dto.target.trim();
    const description = dto.description.trim();
    const urgent = isUrgentReport({ category: dto.category, isDepictedPerson: dto.isDepictedPerson, target, description });
    const suspectedBot = Boolean(dto.website?.trim());

    const { overClientLimit } = this.limiter.consume(meta.ip, reportLane({ urgent, suspectedBot }));

    // isca + não urgente: descarta sem gravar. Isca + urgente: guarda para revisão (pode ser autopreenchimento do
    // navegador de alguém de verdade), mas sem aviso por e-mail.
    if (suspectedBot && !urgent) {
      this.logger.warn('reports: isca preenchida em denúncia não urgente; descartada sem gravar');
      return { ok: true, id: fakeReportId() };
    }

    const route = this.alertRoute({ urgent, suspectedBot, overClientLimit });
    const report = await this.prisma.contentReport.create({
      data: {
        category: dto.category,
        target,
        description,
        reporterEmail: dto.reporterEmail?.trim().toLowerCase() ?? null,
        reporterUserId: meta.userId ?? null,
        isDepictedPerson: dto.isDepictedPerson ?? false,
        urgent,
        suspectedBot,
        ipHash: this.hashIp(meta.ip),
        ...(route === 'digest' ? { alertError: ALERT_DIGEST_QUEUED } : {}),
      },
    });

    // a que vai no resumo não loga uma a uma (na enxurrada seriam milhares de linhas): a varredura loga o resumo
    if (suspectedBot) {
      this.logger.warn(`reports: isca preenchida na denúncia urgente ${report.id} (${report.category}); guardada para revisão, sem aviso`);
    } else if (route === 'individual') {
      this.scheduleAlert(report);
    }
    return { ok: true, id: report.id };
  }

  /**
   * Aviso à equipe depois da resposta HTTP (setImmediate): o pedido nunca espera o provedor de e-mail, e a falha do
   * aviso nunca vira erro para quem denunciou. O resultado fica gravado na denúncia. Se a API reiniciar antes do
   * envio, ou o envio falhar, a varredura de 5 em 5 min manda o aviso (retryPendingAlerts).
   */
  private scheduleAlert(report: ContentReport): void {
    void this.track(
      new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
        const to = this.alertRecipient();
        if (!to) {
          await this.markNoRecipient(report);
          return;
        }
        await this.claimAndSend(report, to, Date.now());
      }),
      `aviso da denúncia ${report.id}`,
    );
  }

  /** Guarda a tarefa até ela acabar (o desligamento espera por ela); erro inesperado só vai para o log. */
  private track(work: Promise<void>, label: string): Promise<void> {
    const task: Promise<void> = work
      .catch((error: unknown) => {
        this.logger.error(`reports: ${label} falhou de forma inesperada: ${messageOf(error)}`);
      })
      .finally(() => {
        this.pendingAlerts.delete(task);
      });
    this.pendingAlerts.add(task);
    return task;
  }

  /**
   * Estado lido da denúncia que a reserva exige (a reserva só pega se nada mudou desde a leitura): pendente, no resumo
   * ou sem destinatário pelo próprio valor; reserva vencida ('sending' parada há mais de 10 min); falha pelo motivo e
   * pelo número de tentativas (outro processo que tentou de novo muda as tentativas, e a 2ª reserva já não casa).
   */
  private claimState(report: ContentReport, now: number): Prisma.ContentReportWhereInput {
    if (report.alertError === null) return { alertError: null };
    if (report.alertError === ALERT_SENDING) {
      return { alertError: ALERT_SENDING, updatedAt: { lt: new Date(now - ALERT_CLAIM_STALE_MS) } };
    }
    if (report.alertError === ALERT_DIGEST_QUEUED || report.alertError === ALERT_NO_RECIPIENT) return { alertError: report.alertError };
    return { alertError: report.alertError, alertAttempts: report.alertAttempts };
  }

  /**
   * Reserva o aviso da denúncia (alertError = 'sending', +1 tentativa). A reserva é atômica (updateMany com o estado
   * lido): dois processos, ou o aviso logo depois da resposta e a varredura, nunca mandam o mesmo e-mail duas vezes.
   * false = outro já pegou (ou o aviso já saiu).
   */
  private async claim(report: ContentReport, now: number): Promise<boolean> {
    const claimed = await this.prisma.contentReport.updateMany({
      where: { id: report.id, alertSentAt: null, ...this.claimState(report, now) },
      // updatedAt explícito: é por ele que a reserva vence (e a 2ª reserva da mesma linha vencida já não casa)
      data: { alertError: ALERT_SENDING, alertAttempts: { increment: 1 }, updatedAt: new Date(now) },
    });
    return claimed.count === 1;
  }

  /** Reserva e manda o aviso avulso. 'taken' = outro já pegou (ou o aviso já saiu). */
  private async claimAndSend(report: ContentReport, to: string, now: number): Promise<'sent' | 'failed' | 'taken'> {
    if (!(await this.claim(report, now))) return 'taken';
    return (await this.sendAlert(report, to, now)) ? 'sent' : 'failed';
  }

  /**
   * Sem REPORTS_ALERT_EMAIL: registra o motivo (só se a denúncia ainda está pendente) sem contar tentativa. A
   * varredura manda o aviso quando a variável existir.
   */
  private async markNoRecipient(report: ContentReport): Promise<void> {
    this.logger.error(`reports: denúncia urgente ${report.id} (${report.category}) sem aviso: REPORTS_ALERT_EMAIL ausente`);
    try {
      await this.prisma.contentReport.updateMany({
        where: { id: report.id, alertSentAt: null, alertError: null },
        data: { alertError: ALERT_NO_RECIPIENT },
      });
    } catch (error) {
      this.logger.error(`reports: não deu para registrar a falta de destinatário na denúncia ${report.id}: ${messageOf(error)}`);
    }
  }

  /**
   * Manda o aviso avulso e grava o resultado (alertSentAt, ou o motivo em alertError com a hora da falha, que conta a
   * espera da próxima tentativa). Se o e-mail sair e a gravação falhar, a reserva vence e a varredura manda de novo:
   * para denúncia urgente, aviso repetido é melhor que nenhum.
   */
  private async sendAlert(report: ContentReport, to: string, now: number): Promise<boolean> {
    let failure = 'o envio do e-mail falhou (detalhe no log da API)';
    let sent = false;
    try {
      sent = await this.email.sendContentReportAlert(to, {
        id: report.id,
        category: report.category,
        urgent: true,
        target: report.target,
        description: report.description,
        reporterEmail: report.reporterEmail,
        isDepictedPerson: report.isDepictedPerson,
        createdAt: report.createdAt,
      });
    } catch (error) {
      failure = messageOf(error);
    }

    if (sent) {
      await this.recordAlert([report.id], { alertSentAt: new Date(), alertError: null });
      return true;
    }
    this.logger.error(`reports: denúncia urgente ${report.id} (${report.category}) gravada, mas o aviso por e-mail falhou: ${failure}`);
    await this.recordAlert([report.id], { alertError: failure.slice(0, 500), updatedAt: new Date(now) });
    return false;
  }

  /**
   * Varredura de 5 em 5 min: manda o aviso das denúncias urgentes (não robô, ainda abertas, com menos de 48 h) que
   * ficaram sem ele: pendentes há 2 min ou mais (a API reiniciou antes do envio), reserva vencida (caiu no meio),
   * falha passageira na hora da nova tentativa, sem destinatário (quando REPORTS_ALERT_EMAIL passa a existir) e as que
   * esperam o resumo. Sem argumento de propósito: o agendador chama o método com argumentos dele (o `now` sairia
   * errado).
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'reports-alert-retry' })
  async handleAlertRetry(): Promise<void> {
    try {
      await this.retryPendingAlerts();
    } catch (error) {
      this.logger.error(`reports: a varredura de avisos de denúncia falhou: ${messageOf(error)}`);
    }
  }

  /** Denúncias que a varredura pode avisar agora (a espera de cada falha conta da hora da falha, `updatedAt`). */
  private pendingAlertsWhere(now: number): Prisma.ContentReportWhereInput {
    const retryable: Prisma.ContentReportWhereInput[] = ALERT_RETRY_BACKOFF_MS.map((wait, index) => ({
      alertError: { notIn: ALERT_STATES },
      // falha de antes da contagem de tentativas (0) espera como a 1ª
      alertAttempts: index === 0 ? { lte: 1 } : index + 1,
      updatedAt: { lte: new Date(now - wait) },
    }));
    return {
      urgent: true,
      suspectedBot: false,
      alertSentAt: null,
      status: { in: OPEN_STATUSES },
      createdAt: { gte: new Date(now - ALERT_RETRY_MAX_AGE_MS) },
      OR: [
        { alertError: null, createdAt: { lte: new Date(now - ALERT_RETRY_MIN_AGE_MS) } },
        { alertError: ALERT_DIGEST_QUEUED },
        { alertError: ALERT_NO_RECIPIENT },
        { alertError: ALERT_SENDING, alertAttempts: { lt: ALERT_MAX_ATTEMPTS }, updatedAt: { lt: new Date(now - ALERT_CLAIM_STALE_MS) } },
        ...retryable,
      ],
    };
  }

  /**
   * Uma rodada da varredura (testável com o relógio). Cada denúncia vai avulsa enquanto houver teto de avisos na
   * hora; as que esperam o resumo e as que passam do teto vão juntas num e-mail só, no máximo um a cada 10 min.
   */
  async retryPendingAlerts(now = Date.now()): Promise<AlertSweepResult> {
    const result: AlertSweepResult = { sent: 0, failed: 0, skipped: 0, digested: 0, waiting: 0 };
    if (this.retrying) return result;
    this.retrying = true;
    const run = async (): Promise<void> => {
      const to = this.alertRecipient();
      if (!to) {
        // nada muda nas denúncias: quando a variável existir, todas as que ficaram sem aviso saem
        if (now - this.lastNoRecipientLogAt >= NO_RECIPIENT_LOG_EVERY_MS) {
          this.lastNoRecipientLogAt = now;
          this.logger.error('reports: REPORTS_ALERT_EMAIL ausente: a varredura não manda aviso de denúncia urgente (as denúncias seguem no admin)');
        }
        return;
      }
      const where = this.pendingAlertsWhere(now);
      const pending = await this.prisma.contentReport.findMany({ where, orderBy: { createdAt: 'asc' }, take: ALERT_SCAN_BATCH });
      const forDigest: ContentReport[] = [];
      for (const report of pending) {
        if (report.alertError === ALERT_DIGEST_QUEUED || !this.limiter.takeAlertSlot(now)) {
          forDigest.push(report);
          continue;
        }
        try {
          const outcome = await this.claimAndSend(report, to, now);
          if (outcome === 'taken') result.skipped += 1;
          else result[outcome] += 1;
        } catch (error) {
          result.failed += 1;
          this.logger.error(`reports: a varredura não conseguiu mandar o aviso da denúncia ${report.id}: ${messageOf(error)}`);
        }
      }
      if (forDigest.length) {
        if (now - this.lastDigestAt >= ALERT_DIGEST_INTERVAL_MS - ALERT_DIGEST_SLACK_MS) {
          const beyondBatch = pending.length >= ALERT_SCAN_BATCH ? Math.max(0, (await this.prisma.contentReport.count({ where })) - pending.length) : 0;
          await this.sendDigest(forDigest, to, now, result, beyondBatch);
        } else {
          result.waiting += forDigest.length;
        }
      }
      if (result.sent || result.failed || result.digested) {
        this.logger.warn(
          `reports: a varredura achou denúncia(s) urgente(s) sem aviso por e-mail: ${result.sent} aviso(s) avulso(s), ${result.digested} no resumo, ${result.failed} com falha (motivo na denúncia), ${result.waiting} para o próximo resumo`,
        );
      }
    };
    try {
      await this.track(run(), 'varredura de avisos de denúncia');
    } finally {
      this.retrying = false;
    }
    return result;
  }

  /**
   * Resumo: reserva cada denúncia (a mesma reserva atômica do aviso avulso: nenhuma vai em dois e-mails) e manda um
   * e-mail só com todas as reservadas. Falhou: cada uma guarda o motivo e volta pela espera de falha.
   */
  private async sendDigest(reports: ContentReport[], to: string, now: number, result: AlertSweepResult, beyondBatch: number): Promise<void> {
    const claimed: ContentReport[] = [];
    for (const report of reports) {
      try {
        if (await this.claim(report, now)) claimed.push(report);
        else result.skipped += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.error(`reports: não deu para reservar a denúncia ${report.id} para o resumo: ${messageOf(error)}`);
      }
    }
    if (!claimed.length) return;
    this.lastDigestAt = now;

    const digest = buildUrgentDigest(claimed.map(toDigestReport), {
      adminUrl: this.config.get<string>('REPORTS_ADMIN_URL')?.trim() || null,
      waiting: beyondBatch,
    });
    let failure = 'o envio do resumo falhou (detalhe no log da API)';
    let sent = false;
    try {
      const { id } = await this.email.sendRawEmail({ to, subject: digest.subject, html: digest.html });
      sent = Boolean(id);
      if (!sent) failure = 'o serviço de e-mail não está configurado (RESEND_API_KEY / RESEND_FROM_EMAIL)';
    } catch (error) {
      failure = messageOf(error);
    }

    const ids = claimed.map((report) => report.id);
    if (sent) {
      await this.recordAlert(ids, { alertSentAt: new Date(), alertError: null });
      result.digested += ids.length;
      return;
    }
    this.logger.error(`reports: o resumo de ${ids.length} denúncia(s) urgente(s) falhou: ${failure}`);
    await this.recordAlert(ids, { alertError: failure.slice(0, 500), updatedAt: new Date(now) });
    result.failed += ids.length;
  }

  private async recordAlert(ids: string[], data: Prisma.ContentReportUpdateManyMutationInput): Promise<void> {
    try {
      if (ids.length === 1) await this.prisma.contentReport.update({ where: { id: ids[0] }, data });
      else await this.prisma.contentReport.updateMany({ where: { id: { in: ids } }, data });
    } catch (error) {
      this.logger.error(`reports: não deu para registrar o resultado do aviso de ${ids.length} denúncia(s) (${ids.slice(0, 5).join(', ')}): ${messageOf(error)}`);
    }
  }

  /** Espera os avisos em andamento (desligamento do servidor; teto para nunca travar o desligamento). */
  async drainAlerts(timeoutMs = 10_000): Promise<void> {
    if (!this.pendingAlerts.size) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    });
    const drain = (async () => {
      while (this.pendingAlerts.size) await Promise.allSettled([...this.pendingAlerts]);
    })();
    await Promise.race([drain, timeout]);
    if (timer) clearTimeout(timer);
  }

  async listForAdmin(page = 1, limit = 50, status?: ContentReportStatus, sort: ReportsSort = 'newest') {
    const take = Math.min(Math.max(limit, 1), 200);
    const skip = (Math.max(page, 1) - 1) * take;
    const where = status ? { status } : {};
    // abertas primeiro (ordem do enum: OPEN, IN_REVIEW, ACTIONED, DISMISSED); dentro do status, pela data pedida
    const createdAt: Prisma.SortOrder = sort === 'oldest' ? 'asc' : 'desc';
    const [rows, total, open, urgentOpen] = await Promise.all([
      this.prisma.contentReport.findMany({ where, orderBy: [{ status: 'asc' }, { createdAt }], skip, take }),
      this.prisma.contentReport.count({ where }),
      this.prisma.contentReport.count({ where: { status: { in: OPEN_STATUSES } } }),
      this.prisma.contentReport.count({ where: { urgent: true, status: { in: OPEN_STATUSES } } }),
    ]);
    return { data: rows.map(toAdminReport), total, open, urgentOpen, page: Math.max(page, 1), limit: take };
  }

  async getForAdmin(id: string): Promise<AdminReport> {
    const report = await this.prisma.contentReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundException('Denúncia não encontrada');
    return toAdminReport(report);
  }

  /**
   * Andamento pelo admin: status, nota e liberação da evidência.
   * - Liberar (evidenceReleased) só com a denúncia confirmada (removido, ACTIONED), já gravada assim ou no mesmo pedido.
   *   Descartada já não segura a exclusão LGPD; liberar uma descartada deixava a liberação valer quando ela fosse
   *   confirmada depois, e a denúncia de menor confirmada parava de segurar a conta sem ninguém ter liberado.
   * - Repetir a liberação não muda a data nem quem liberou.
   * - Toda troca de status desfaz a liberação (a decisão que liberou mudou): a denúncia volta a segurar a exclusão até
   *   ser confirmada e liberada de novo. A exceção é o pedido que confirma e libera junto: vale a data e o admin dele.
   * - A gravação só vale se o status e a liberação ainda forem os que foram lidos: outro admin mexendo ao mesmo tempo
   *   = 409, e nada muda (senão a liberação de um podia sobreviver à troca de status do outro).
   */
  async update(id: string, dto: UpdateReportDto, admin: { id: string; email: string }): Promise<AdminReport> {
    if (dto.status === undefined && dto.adminNote === undefined && dto.evidenceReleased === undefined) {
      throw new BadRequestException('Nada para mudar: mande status, adminNote ou evidenceReleased');
    }
    const existing = await this.prisma.contentReport.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Denúncia não encontrada');

    const nextStatus = (dto.status as ContentReportStatus | undefined) ?? existing.status;
    const statusChanged = nextStatus !== existing.status;
    if (dto.evidenceReleased && nextStatus !== ContentReportStatus.ACTIONED) {
      throw new BadRequestException(
        'A evidência só pode ser liberada com a denúncia confirmada (removido). Descartada já não segura a exclusão da conta; aberta ou em análise segura até ser confirmada e liberada. Confirme a denúncia antes, ou no mesmo pedido.',
      );
    }

    const closedNext = CLOSED_STATUSES.includes(nextStatus);
    const data: Prisma.ContentReportUpdateInput = {};
    if (dto.status !== undefined || dto.adminNote !== undefined) data.handledBy = admin.email;
    if (dto.status !== undefined) {
      data.status = nextStatus;
      data.handledAt = closedNext ? new Date() : existing.handledAt;
    }
    if (dto.adminNote !== undefined) data.adminNote = dto.adminNote;
    if (dto.evidenceReleased && (statusChanged || !existing.evidenceReleasedAt)) {
      // liberação nova: a primeira, ou a do pedido que confirma a denúncia (a antiga era de outra decisão)
      data.evidenceReleasedAt = new Date();
      data.evidenceReleasedBy = admin.id;
    } else if (statusChanged && existing.evidenceReleasedAt) {
      data.evidenceReleasedAt = null;
      data.evidenceReleasedBy = null;
      this.logger.warn(
        `reports: denúncia ${id} mudou de ${existing.status} para ${nextStatus} por ${admin.email}: a evidência volta a ser preservada (liberação desfeita)`,
      );
    }

    try {
      // where com o status e a liberação lidos: se outro admin mudou um dos dois no meio, o Prisma não acha a linha (P2025)
      const updated = await this.prisma.contentReport.update({
        where: { id, status: existing.status, evidenceReleasedAt: existing.evidenceReleasedAt },
        data,
      });
      return toAdminReport(updated);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new ConflictException('A denúncia mudou enquanto isso (outro admin mexeu no andamento). Recarregue e tente de novo.');
      }
      throw error;
    }
  }
}

function toDigestReport(report: ContentReport): DigestReport {
  return {
    id: report.id,
    category: report.category,
    target: report.target,
    description: report.description,
    createdAt: report.createdAt,
    reasons: urgentReasons(report),
  };
}
