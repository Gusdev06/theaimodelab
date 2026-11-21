import { Injectable } from '@nestjs/common';
import {
  GenerationStatus,
  GenerationType,
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 1ª correção grátis da foto Unlocked (dono 20/11/2026).
 *
 * A cliente que corrige uma foto Unlocked com defeito pagava a correção de novo e chamava de "estafa".
 * A correção sai de graça só quando TODAS as regras abaixo valem. Sem o teto (regra 5), o Pro com afiliado
 * de 30% fica negativo no pior caso: o teto é a conta do prejuízo zero, não mexer sem refazer a conta.
 *
 * O vínculo fica no JSON `parameters` da geração nova (`freeFix: true`, `freeFixOf: <origem>`): o banco de
 * produção não roda `prisma migrate`, então nada de coluna nova. `FREE_FIX_UNLOCKED=off` desliga tudo.
 */

/**
 * Modelo Unlocked ("The AI Model Lab Unlocked" / "Funvmake Unlocked") no DTO e no `modelUsed`.
 * Fora de propósito: `sem-censura-fallback` é o resgate de OUTRO modelo (cobrado pelo preço dele) e a troca
 * de rosto Unlocked é FACE_SWAP. Nenhum dos dois é foto Unlocked paga como Unlocked.
 */
export const FREE_FIX_UNLOCKED_MODELS: ReadonlySet<string> = new Set([
  'sem-censura',
]);
export const FREE_FIX_UNLOCKED_VARIANT = 'SEM_CENSURA';

const IMAGE_TYPES: ReadonlySet<GenerationType> = new Set([
  GenerationType.TEXT_TO_IMAGE,
  GenerationType.IMAGE_TO_IMAGE,
]);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const FREE_FIX_ORIGIN_MAX_AGE_MS = 7 * DAY_MS;
export const FREE_FIX_DAILY_WINDOW_MS = DAY_MS;
export const FREE_FIX_CAP_WINDOW_MS = 30 * DAY_MS;
/** 1 correção grátis a cada 10 fotos Unlocked pagas nos últimos 30 dias. */
export const FREE_FIX_PAID_PER_FREE = 10;

export type FreeFixReason =
  | 'disabled'
  | 'missing_origin'
  | 'not_unlocked_request'
  | 'not_found'
  | 'origin_not_completed'
  | 'origin_not_unlocked'
  | 'origin_not_image'
  | 'origin_too_old'
  | 'origin_not_paid'
  | 'origin_already_fixed'
  | 'daily_limit'
  | 'annual_plan'
  | 'monthly_cap';

export interface FreeFixEligibility {
  eligible: boolean;
  reason: FreeFixReason | null;
}

export interface FreeFixRequest {
  type: GenerationType;
  /** Modelo pedido (ex.: `sem-censura`). Ausente = vale a variante. */
  model?: string | null;
  /** Variante de cobrança já resolvida no servidor (ex.: `SEM_CENSURA`). */
  modelVariant?: string | null;
}

export function isFreeFixEnabled(): boolean {
  return process.env.FREE_FIX_UNLOCKED?.trim().toLowerCase() !== 'off';
}

/** Regra 1: a geração nova é foto (texto ou edição) no Unlocked. */
export function isUnlockedImageRequest(request: FreeFixRequest): boolean {
  if (!IMAGE_TYPES.has(request.type)) return false;
  if (request.model) return FREE_FIX_UNLOCKED_MODELS.has(request.model);
  return request.modelVariant === FREE_FIX_UNLOCKED_VARIANT;
}

/** Pedido que a correção grátis cobre (o GET /generations/:id/free-fix pergunta por este). */
export const FREE_FIX_UNLOCKED_IMAGE_REQUEST: FreeFixRequest = {
  type: GenerationType.IMAGE_TO_IMAGE,
  model: 'sem-censura',
  modelVariant: FREE_FIX_UNLOCKED_VARIANT,
};

const NOT_ELIGIBLE = (reason: FreeFixReason): FreeFixEligibility => ({
  eligible: false,
  reason,
});

/** Correção grátis que conta: a que falhou não gastou a vez (nada foi cobrado, nada a devolver). */
const FREE_FIX_SPENT: Prisma.GenerationWhereInput = {
  parameters: { path: ['freeFix'], equals: true },
  status: { not: GenerationStatus.FAILED },
};

/** Assinatura anual com benefício ainda valendo: ativa, em atraso, em teste ou cancelada dentro do período. */
const LIVE_SUBSCRIPTION_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.TRIALING,
];

@Injectable()
export class FreeFixService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Única fonte da elegibilidade: usada na cobrança (generate-image), na estimativa
   * (POST /credits/estimate) e no GET /generations/:id/free-fix.
   */
  async checkEligibility(
    userId: string,
    originId: string | null | undefined,
    request: FreeFixRequest,
    now: Date = new Date(),
  ): Promise<FreeFixEligibility> {
    if (!isFreeFixEnabled()) return NOT_ELIGIBLE('disabled');
    if (!originId) return NOT_ELIGIBLE('missing_origin');
    if (!isUnlockedImageRequest(request))
      return NOT_ELIGIBLE('not_unlocked_request');

    const origin = await this.prisma.generation.findFirst({
      where: { id: originId, userId },
      select: {
        status: true,
        type: true,
        modelUsed: true,
        createdAt: true,
        creditsConsumed: true,
        usedFreeGeneration: true,
      },
    });
    if (!origin) return NOT_ELIGIBLE('not_found');
    if (origin.status !== GenerationStatus.COMPLETED)
      return NOT_ELIGIBLE('origin_not_completed');
    if (!FREE_FIX_UNLOCKED_MODELS.has(origin.modelUsed))
      return NOT_ELIGIBLE('origin_not_unlocked');
    if (!IMAGE_TYPES.has(origin.type)) return NOT_ELIGIBLE('origin_not_image');
    if (
      now.getTime() - origin.createdAt.getTime() >
      FREE_FIX_ORIGIN_MAX_AGE_MS
    ) {
      return NOT_ELIGIBLE('origin_too_old');
    }
    if (origin.creditsConsumed <= 0 || origin.usedFreeGeneration) {
      return NOT_ELIGIBLE('origin_not_paid');
    }

    const alreadyFixed = await this.prisma.generation.count({
      where: {
        userId,
        ...FREE_FIX_SPENT,
        AND: [{ parameters: { path: ['freeFixOf'], equals: originId } }],
      },
    });
    if (alreadyFixed > 0) return NOT_ELIGIBLE('origin_already_fixed');

    const fixesToday = await this.prisma.generation.count({
      where: {
        userId,
        ...FREE_FIX_SPENT,
        createdAt: { gte: new Date(now.getTime() - FREE_FIX_DAILY_WINDOW_MS) },
      },
    });
    if (fixesToday > 0) return NOT_ELIGIBLE('daily_limit');

    // Regra 6: anual fora. Na dúvida (intervalo diferente de 'month'), também fora.
    const annual = await this.prisma.subscription.findFirst({
      where: {
        userId,
        plan: { billingInterval: { not: 'month' } },
        OR: [
          { status: { in: LIVE_SUBSCRIPTION_STATUSES } },
          { currentPeriodEnd: { gt: now } },
        ],
      },
      select: { id: true },
    });
    if (annual) return NOT_ELIGIBLE('annual_plan');

    const capSince = new Date(now.getTime() - FREE_FIX_CAP_WINDOW_MS);
    const [paidUnlocked, fixesInWindow] = await Promise.all([
      this.prisma.generation.count({
        where: {
          userId,
          type: { in: [...IMAGE_TYPES] },
          modelUsed: { in: [...FREE_FIX_UNLOCKED_MODELS] },
          status: GenerationStatus.COMPLETED,
          creditsConsumed: { gt: 0 },
          usedFreeGeneration: false,
          createdAt: { gte: capSince },
        },
      }),
      this.prisma.generation.count({
        where: { userId, ...FREE_FIX_SPENT, createdAt: { gte: capSince } },
      }),
    ]);
    if (fixesInWindow >= Math.floor(paidUnlocked / FREE_FIX_PAID_PER_FREE)) {
      return NOT_ELIGIBLE('monthly_cap');
    }

    return { eligible: true, reason: null };
  }

  /**
   * Fecha a corrida de dois pedidos simultâneos: depois de gravar a geração marcada como correção grátis,
   * só a PRIMEIRA das últimas 24 h (ou a primeira da mesma origem) fica grátis. As outras pagam o preço normal.
   */
  async confirmClaim(
    userId: string,
    generationId: string,
    originId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const first = await this.prisma.generation.findFirst({
      where: {
        userId,
        ...FREE_FIX_SPENT,
        OR: [
          {
            createdAt: {
              gte: new Date(now.getTime() - FREE_FIX_DAILY_WINDOW_MS),
            },
          },
          { parameters: { path: ['freeFixOf'], equals: originId } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    return first?.id === generationId;
  }
}
