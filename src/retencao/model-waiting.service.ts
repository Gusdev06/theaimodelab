import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { GenerationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../email/email.service';
import { sitePathFor } from '../email/brand-email';
import { showMiaFor } from '../email-sequences/mia-email';
import { appBaseUrl, emailLocaleOf, sendMiaEmail, toMailLocale } from '../email-sequences/mia-mailer';
import {
  buildModelWaitingEmail,
  modelWaitingCtaLabel,
  modelWaitingTitle,
} from '../email-sequences/retencao-templates';
import {
  PROACTIVE_MODEL_NUDGE_ENV,
  PROACTIVE_OPT_OUT_KEY,
  isFlagOn,
} from './retencao-flags';

/**
 * "Sua modelo está esperando" (candy-retencao, L10, 24/11/2026).
 *
 * Molde: Candy, chave global "Proactive Media" (29/09/2026): a personagem manda foto por iniciativa própria e a caixa
 * de entrada já abre com ela puxando conversa; Tolan passou de 100 mil assinantes com conversa iniciada pela IA
 * (RevenueCat, 02/11/2026).
 *
 * - Gatilho: conta com modelo criada que ficou 48 h sem gerar (passo `h48`) e de novo no 5º dia (`d5`); no máximo 2
 *   por semana. Janela de 7 dias: ligar a chave não dispara para a base inteira parada.
 * - Conteúdo: a ÚLTIMA criação dela (foto já gerada, custo zero), com o nome da modelo, no sino (foto + botão) e no
 *   e-mail. O botão abre o estúdio já com o mesmo texto e a mesma modelo (1 toque); a nova geração sai dos créditos
 *   dela pelo preço de tabela. Conta de prejuízo zero: custo 0 para a casa.
 * - Chave na conta "Receber fotos da minha modelo" (linha em email_sequence_logs) e o descadastro de marketing valem.
 * - Dedupe por claim em email_sequence_logs (sequence `model_waiting`): reserva antes de enviar, apaga no erro.
 * - Desligado por padrão: PROACTIVE_MODEL_NUDGE=on liga.
 */
export const MODEL_WAITING_SEQUENCE = 'model_waiting';
export const MODEL_WAITING_TYPE = 'model-waiting';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FIRST_NUDGE_MS = 48 * HOUR_MS;
const SECOND_NUDGE_MS = 5 * DAY_MS;
/** Parada há mais disso não entra (sem rajada retroativa ao ligar). */
const MAX_IDLE_MS = 7 * DAY_MS;
export const MAX_NUDGES_PER_WEEK = 2;
const RUN_LIMIT = 300;
/** O estúdio corta o texto em 2.000; a URL fica bem abaixo disso. */
const PROMPT_URL_MAX = 900;

export type ModelWaitingStep = 'h48' | 'd5';

/** Passo devido pelo tempo parado. */
export function dueModelWaitingStep(idleMs: number): ModelWaitingStep | null {
  if (idleMs < FIRST_NUDGE_MS || idleMs >= MAX_IDLE_MS) return null;
  return idleMs >= SECOND_NUDGE_MS ? 'd5' : 'h48';
}

/** 1 ciclo por "última atividade": gerou de novo, começa outro. */
export function modelWaitingKey(userId: string, lastActivity: Date, step: ModelWaitingStep): string {
  return `${MODEL_WAITING_SEQUENCE}:${userId}:${lastActivity.getTime()}:${step}`;
}

/** Caminho do estúdio já com o texto e a modelo (sem idioma: o site põe). */
export function studioPathFor(prompt: string | null, influencerId: string | null, isVideo: boolean): string {
  const params = new URLSearchParams();
  params.set('mode', isVideo ? 'video' : 'image');
  const text = (prompt ?? '').trim().slice(0, PROMPT_URL_MAX);
  if (text) params.set('prompt', text);
  if (influencerId) params.set('pin', influencerId);
  return `/x?${params.toString()}`;
}

function isHttpsImage(url: string | null | undefined): url is string {
  return typeof url === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(url);
}

const VIDEO_TYPES = new Set(['TEXT_TO_VIDEO', 'IMAGE_TO_VIDEO', 'MOTION_CONTROL', 'REFERENCE_VIDEO', 'AVATAR_VIDEO', 'SPOKEN_VIDEO']);

@Injectable()
export class ModelWaitingService {
  private readonly logger = new Logger(ModelWaitingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  isEnabled(): boolean {
    return isFlagOn(this.configService.get<string>(PROACTIVE_MODEL_NUDGE_ENV));
  }

  /** De hora em hora (minuto 25). Com a chave desligada não lê nada. */
  @Cron('25 * * * *')
  async run(now: Date = new Date()): Promise<{ candidates: number; sent: number }> {
    const result = { candidates: 0, sent: 0 };
    if (!this.isEnabled()) return result;
    try {
      const idleSince = new Date(now.getTime() - FIRST_NUDGE_MS);
      const windowStart = new Date(now.getTime() - MAX_IDLE_MS);
      const lastByUser = await this.prisma.generation.groupBy({
        by: ['userId'],
        where: { createdAt: { gte: windowStart } },
        _max: { createdAt: true },
      });
      const idle = lastByUser
        .filter((row) => row._max.createdAt && row._max.createdAt <= idleSince)
        .slice(0, RUN_LIMIT);
      result.candidates = idle.length;
      for (const row of idle) {
        try {
          const sent = await this.nudge(row.userId, row._max.createdAt as Date, now);
          if (sent) result.sent++;
        } catch (error: unknown) {
          this.logger.error(`Modelo esperando (user ${row.userId}): ${messageOf(error)}`);
        }
      }
      if (result.sent) this.logger.log(`Modelo esperando: ${result.sent} envio(s) de ${result.candidates} parada(s)`);
    } catch (error: unknown) {
      this.logger.error(`Varredura "modelo esperando" falhou: ${messageOf(error)}`);
    }
    return result;
  }

  /** Um envio para uma conta parada. true = saiu agora. */
  async nudge(userId: string, lastActivity: Date, now: Date): Promise<boolean> {
    const step = dueModelWaitingStep(now.getTime() - lastActivity.getTime());
    if (!step) return false;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        locale: true,
        country: true,
        signupBrand: true,
        isActive: true,
        marketingOptOut: true,
      },
    });
    if (!user || !user.isActive || user.marketingOptOut) return false;

    const [optOut, sentThisWeek] = await Promise.all([
      this.prisma.emailSequenceLog.findUnique({
        where: { userId_emailKey: { userId, emailKey: PROACTIVE_OPT_OUT_KEY } },
        select: { id: true },
      }),
      this.prisma.emailSequenceLog.count({
        where: { userId, sequence: MODEL_WAITING_SEQUENCE, sentAt: { gte: new Date(now.getTime() - 7 * DAY_MS) } },
      }),
    ]);
    if (optOut || sentThisWeek >= MAX_NUDGES_PER_WEEK) return false;

    // só quem tem modelo criada
    const influencer = await this.prisma.influencers.findFirst({
      where: { user_id: userId, is_deleted: false },
      orderBy: { updated_at: 'desc' },
      select: { id: true, name: true },
    });
    if (!influencer) return false;

    // a última criação dela com foto (a da modelo primeiro)
    const lastCreation = await this.prisma.generation.findFirst({
      where: {
        userId,
        status: GenerationStatus.COMPLETED,
        isDeleted: false,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        outputs: { some: {} },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        type: true,
        prompt: true,
        creditsConsumed: true,
        influencer_id: true,
        influencers: { select: { id: true, name: true, is_deleted: true } },
        outputs: { orderBy: { order: 'asc' }, take: 1, select: { url: true, thumbnailUrl: true, mimeType: true } },
      },
    });
    const output = lastCreation?.outputs[0];
    const isVideo = !!lastCreation && VIDEO_TYPES.has(lastCreation.type);
    const imageUrl = isVideo ? output?.thumbnailUrl : output?.url;
    if (!lastCreation || !isHttpsImage(imageUrl)) return false;
    if (!isVideo && output?.mimeType && !output.mimeType.startsWith('image/')) return false;

    const model =
      lastCreation.influencers && !lastCreation.influencers.is_deleted ? lastCreation.influencers : influencer;
    const modelName = (model.name ?? '').trim().slice(0, 40) || 'Mia';

    let claimId: string;
    try {
      const claim = await this.prisma.emailSequenceLog.create({
        data: { userId, sequence: MODEL_WAITING_SEQUENCE, emailKey: modelWaitingKey(userId, lastActivity, step) },
        select: { id: true },
      });
      claimId = claim.id;
    } catch (error: unknown) {
      if ((error as { code?: string } | null)?.code === 'P2002') return false;
      throw error;
    }

    try {
      const locale = emailLocaleOf(user);
      const sitePath = sitePathFor(toMailLocale(locale));
      const studioPath = studioPathFor(lastCreation.prompt, model.id, isVideo);
      const cost = Math.max(0, lastCreation.creditsConsumed);
      const { subject, body } = buildModelWaitingEmail(
        {
          modelName,
          imageUrl,
          ctaUrl: `${appBaseUrl()}/${sitePath}${studioPath}&utm_source=email&utm_campaign=model_waiting_${step}`,
          cost,
        },
        locale,
        { mia: showMiaFor(user.signupBrand) },
      );
      const resendId = await sendMiaEmail(this.emailService, { recipient: user, subject, bodyMarkdown: body });
      if (resendId) {
        await this.prisma.emailSequenceLog
          .update({ where: { id: claimId }, data: { resendEmailId: resendId } })
          .catch(() => undefined);
      }
      await this.notifications.create(userId, MODEL_WAITING_TYPE, {
        key: modelWaitingKey(userId, lastActivity, step),
        step,
        reason: modelWaitingTitle(modelName, locale),
        modelName,
        imageUrl,
        ctaPath: studioPath,
        ctaLabel: modelWaitingCtaLabel(cost, locale),
        cost,
        generationId: lastCreation.id,
      });
      return true;
    } catch (error: unknown) {
      await this.prisma.emailSequenceLog.delete({ where: { id: claimId } }).catch(() => undefined);
      throw error;
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
