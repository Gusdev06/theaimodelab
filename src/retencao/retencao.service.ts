import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  PROACTIVE_MODEL_NUDGE_ENV,
  PROACTIVE_OPT_OUT_KEY,
  PROACTIVE_OPT_OUT_SEQUENCE,
  isFlagOn,
} from './retencao-flags';

/**
 * Os Packs 300+ nas duas contas da Perfect Pay (mesma lista do job suporte.pack_bonus_d8 do cockpit,
 * command-center/server/src/modules/suporte/pack-bonus.ts). LOYALTY_PACK_PRODUCT_CODES troca a lista sem deploy.
 */
export const DEFAULT_PACK_PRODUCT_CODES: readonly string[] = ['PPPBFJAQ', 'PPPBFJAR', 'PPPBFM1J', 'PPPBFHBE', 'PPPBFHC5'];

/** Compra do Pack mais velha que isto não interessa ao cartão do 8º dia (o job do cockpit para no 30º dia). */
const PACK_LOOKBACK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PackPurchase {
  origin: 'pack';
  productCode: string;
  /** Quando a venda aprovada chegou (ISO). */
  purchasedAt: string;
}

export interface RetencaoStatus {
  proactiveMedia: { available: boolean; optedIn: boolean };
  packPurchase: PackPurchase | null;
}

export function parsePackCodes(raw: string | null | undefined): Set<string> {
  const list = (raw ?? '')
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);
  return new Set(list.length ? list : DEFAULT_PACK_PRODUCT_CODES);
}

/** Código do produto no postback da Perfect Pay guardado no webhook_logs. */
export function productCodeOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const product = (payload as { product?: { code?: unknown } }).product;
  return typeof product?.code === 'string' ? product.code.trim().toUpperCase() : null;
}

/**
 * Dados do pacote candy-retencao para a conta: a chave "Receber fotos da minha modelo" (L10) e a origem e a data da
 * compra do Pack (L27, cartão de fidelidade do 8º dia). Só leitura e uma preferência; nenhum crédito sai daqui.
 */
@Injectable()
export class RetencaoService {
  private readonly logger = new Logger(RetencaoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async status(userId: string, now: Date = new Date()): Promise<RetencaoStatus> {
    const [optOut, packPurchase] = await Promise.all([
      this.prisma.emailSequenceLog.findUnique({
        where: { userId_emailKey: { userId, emailKey: PROACTIVE_OPT_OUT_KEY } },
        select: { id: true },
      }),
      this.packPurchase(userId, now).catch((error: unknown) => {
        this.logger.warn(`Compra do Pack (user ${userId}): ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }),
    ]);
    return {
      proactiveMedia: {
        available: isFlagOn(this.configService.get<string>(PROACTIVE_MODEL_NUDGE_ENV)),
        optedIn: !optOut,
      },
      packPurchase,
    };
  }

  /** Liga ou desliga "Receber fotos da minha modelo". Idempotente. */
  async setProactiveMedia(userId: string, optedIn: boolean): Promise<{ optedIn: boolean }> {
    if (optedIn) {
      await this.prisma.emailSequenceLog.deleteMany({ where: { userId, emailKey: PROACTIVE_OPT_OUT_KEY } });
      return { optedIn: true };
    }
    try {
      await this.prisma.emailSequenceLog.create({
        data: { userId, sequence: PROACTIVE_OPT_OUT_SEQUENCE, emailKey: PROACTIVE_OPT_OUT_KEY },
      });
    } catch (error: unknown) {
      // já desligada
      if ((error as { code?: string } | null)?.code !== 'P2002') throw error;
    }
    return { optedIn: false };
  }

  /**
   * A compra do Pack mais recente da conta (últimos 30 dias), confirmada pelo código do produto no postback. Estorno
   * vira source "perfectpay:refunded" e sai daqui. Sem compra do Pack = null (o cartão não aparece).
   */
  async packPurchase(userId: string, now: Date = new Date()): Promise<PackPurchase | null> {
    const grants = await this.prisma.pendingFreeGenerationGrant.findMany({
      where: {
        consumedByUserId: userId,
        source: 'perfectpay',
        externalEventId: { not: null },
        createdAt: { gte: new Date(now.getTime() - PACK_LOOKBACK_DAYS * DAY_MS) },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { externalEventId: true, createdAt: true },
    });
    if (!grants.length) return null;
    const packCodes = parsePackCodes(this.configService.get<string>('LOYALTY_PACK_PRODUCT_CODES'));
    for (const grant of grants) {
      const log = await this.prisma.webhookLog.findFirst({
        where: { provider: 'perfectpay', externalId: { startsWith: `${grant.externalEventId}-` } },
        orderBy: { createdAt: 'asc' },
        select: { payload: true },
      });
      const code = productCodeOf(log?.payload);
      if (code && packCodes.has(code)) {
        return { origin: 'pack', productCode: code, purchasedAt: grant.createdAt.toISOString() };
      }
    }
    return null;
  }
}
