import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FreeGenerationType, Prisma } from '@prisma/client';

export type FreeGenerationBundle = Partial<Record<FreeGenerationType, number>>;

/**
 * Bundle padrão entregue por compra do curso na Hubla:
 * 1 geração de cada tipo.
 */
export const DEFAULT_HUBLA_BUNDLE: FreeGenerationBundle = {
  NB2: 1,
  NB_PRO: 1,
  FACE_SWAP: 1,
  VIRTUAL_TRY_ON: 1,
  THEAIMODELAB_FAST: 1,
  UPSCALE: 1,
};

/**
 * Bundle entregue na compra do CURSO via Perfect Pay.
 * 2 gerações de cada modelo — TODOS os modelos, exceto SEEDANCE_2
 * (custo muito alto). Cobre imagem (básica + premium), ferramentas e vídeo.
 */
export const PERFECTPAY_COURSE_BUNDLE: FreeGenerationBundle = {
  // Imagem básica
  NB2: 2,
  NB_PRO: 2,
  GPT_IMAGE_2: 2,
  GPT_IMAGE_2_5: 2,
  SEEDREAM_LITE: 2,
  // Imagem premium
  GROK_IMAGINE: 2,
  GEMINI_OMNI: 2,
  SEM_CENSURA: 2,
  DEEPDEEP: 2,
  THEAIMODELAB_QUALITY: 2,
  THEAIMODELAB_FAST: 2,
  // Ferramentas
  FACE_SWAP: 2,
  VIRTUAL_TRY_ON: 2,
  UPSCALE: 2,
  MOTION_CONTROL: 2,
  // Vídeo (exceto SEEDANCE_2)
  VEO_FAST: 2,
  VEO_MAX: 2,
  KLING_V3_TURBO: 2,
  COMFYDEPLOY_WAN: 2,
};

@Injectable()
export class PendingGrantsService {
  private readonly logger = new Logger(PendingGrantsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cria uma pending grant. Idempotente via externalEventId — se já existir
   * uma grant com o mesmo id externo, não cria outra.
   */
  async createPending(params: {
    email: string;
    bundle: FreeGenerationBundle;
    source: string;
    externalEventId?: string | null;
  }): Promise<{ created: boolean; id: string }> {
    const email = params.email.trim().toLowerCase();

    if (params.externalEventId) {
      const existing = await this.prisma.pendingFreeGenerationGrant.findUnique({
        where: { externalEventId: params.externalEventId },
      });
      if (existing) {
        return { created: false, id: existing.id };
      }
    }

    try {
      const created = await this.prisma.pendingFreeGenerationGrant.create({
        data: {
          email,
          bundle: params.bundle as Prisma.InputJsonValue,
          source: params.source,
          externalEventId: params.externalEventId ?? null,
        },
      });
      await this.applyToExistingAccount(email);
      return { created: true, id: created.id };
    } catch (error: any) {
      // Race on unique externalEventId — treat as idempotent hit
      if (error?.code === 'P2002') {
        const existing = await this.prisma.pendingFreeGenerationGrant.findUnique({
          where: { externalEventId: params.externalEventId! },
        });
        if (existing) return { created: false, id: existing.id };
      }
      throw error;
    }
  }

  /**
   * Consome todas as pending grants não utilizadas do email, creditando no
   * usuário recém-criado. Executado dentro de transação pra ser atômico com
   * o signup.
   */
  async consumeForUser(
    userId: string,
    email: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    if (!tx) {
      return this.prisma.$transaction((client) =>
        this.consumeForUser(userId, email, client),
      );
    }
    const client = tx;
    const normalizedEmail = email.trim().toLowerCase();

    const pendings = await client.pendingFreeGenerationGrant.findMany({
      where: {
        email: normalizedEmail,
        consumedByUserId: null,
      },
    });

    if (pendings.length === 0) return 0;

    let consumed = 0;
    for (const pending of pendings) {
      // Reserva atômica: webhook, cadastro e login podem consumir a mesma grant
      // ao mesmo tempo — só quem marcar primeiro credita.
      const claimed = await client.pendingFreeGenerationGrant.updateMany({
        where: { id: pending.id, consumedByUserId: null },
        data: { consumedByUserId: userId, consumedAt: new Date() },
      });
      if (claimed.count === 0) continue;
      consumed += 1;

      const bundle = this.parseBundle(pending.bundle);
      for (const [type, amount] of Object.entries(bundle)) {
        if (!amount || amount <= 0) continue;
        const freeType = type as FreeGenerationType;
        await client.userFreeGeneration.upsert({
          where: { userId_type: { userId, type: freeType } },
          create: { userId, type: freeType, remaining: amount },
          update: { remaining: { increment: amount } },
        });
      }
    }

    if (consumed > 0) {
      this.logger.log(
        `Consumed ${consumed} pending grant(s) for ${normalizedEmail} → user ${userId}`,
      );
    }
    return consumed;
  }

  /**
   * Comprador que JÁ tem conta: antes o bundle só era aplicado no cadastro e
   * ele nunca recebia (TKT-109). Falha aqui não derruba o webhook — o login
   * aplica de novo.
   */
  async applyToExistingAccount(email: string): Promise<number> {
    try {
      const user = await this.prisma.user.findFirst({
        where: { email: { equals: email.trim(), mode: 'insensitive' } },
        select: { id: true, email: true },
      });
      if (!user) return 0;
      return await this.consumeForUser(user.id, user.email);
    } catch (error) {
      this.logger.error(
        `Não consegui aplicar as gerações grátis de ${email} na conta existente: ${(error as Error).message}`,
      );
      return 0;
    }
  }

  /**
   * Reembolso/chargeback da isca: o bundle da venda deixa de valer. Grant ainda
   * não usada vira bundle vazio (a linha fica para o dedupe do evento); grant já
   * aplicada tira das gerações grátis o que ainda sobra (até o valor do bundle).
   * `saleEventId` é o id por venda; ids antigos com o status no fim também casam.
   */
  async revokeForRefund(
    saleEventId: string,
    reason: string,
  ): Promise<{ grants: number; removed: Record<string, number> }> {
    const grants = await this.prisma.pendingFreeGenerationGrant.findMany({
      where: {
        OR: [
          { externalEventId: saleEventId },
          { externalEventId: { startsWith: `${saleEventId}-` } },
        ],
      },
    });
    const removed: Record<string, number> = {};
    let revoked = 0;
    for (const grant of grants) {
      if (grant.source.endsWith(':refunded')) continue;
      const bundle = this.parseBundle(grant.bundle);
      await this.prisma.$transaction(async (tx) => {
        if (grant.consumedByUserId) {
          for (const [type, amount] of Object.entries(bundle)) {
            if (!amount || amount <= 0) continue;
            const freeType = type as FreeGenerationType;
            const row = await tx.userFreeGeneration.findUnique({
              where: {
                userId_type: { userId: grant.consumedByUserId, type: freeType },
              },
            });
            const take = Math.min(row?.remaining ?? 0, amount);
            if (take <= 0) continue;
            await tx.userFreeGeneration.update({
              where: {
                userId_type: { userId: grant.consumedByUserId, type: freeType },
              },
              data: { remaining: { decrement: take } },
            });
            removed[freeType] = (removed[freeType] ?? 0) + take;
          }
        }
        await tx.pendingFreeGenerationGrant.update({
          where: { id: grant.id },
          data: { bundle: {}, source: `${grant.source}:refunded` },
        });
      });
      revoked += 1;
    }
    if (revoked > 0) {
      this.logger.warn(
        `Isca reembolsada (${reason}) venda ${saleEventId}: ${revoked} grant(s) revogada(s); gerações retiradas ${JSON.stringify(removed)}`,
      );
    }
    return { grants: revoked, removed };
  }

  private parseBundle(value: Prisma.JsonValue): FreeGenerationBundle {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: FreeGenerationBundle = {};
    for (const [key, raw] of Object.entries(value)) {
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        out[key as FreeGenerationType] = raw;
      }
    }
    return out;
  }
}
