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
 * 2 gerações de cada: imagem (básica + premium) e ferramentas — sem vídeo
 * (custo alto). Não inclui THEAIMODELAB_FAST (é label de velocidade, não modelo).
 */
export const PERFECTPAY_COURSE_BUNDLE: FreeGenerationBundle = {
  // Imagem básica
  NB2: 2,
  NB_PRO: 2,
  GPT_IMAGE_2: 2,
  SEEDREAM_LITE: 2,
  // Imagem premium
  GROK_IMAGINE: 2,
  GEMINI_OMNI: 2,
  SEM_CENSURA: 2,
  DEEPDEEP: 2,
  THEAIMODELAB_QUALITY: 2,
  // Ferramentas
  FACE_SWAP: 2,
  VIRTUAL_TRY_ON: 2,
  UPSCALE: 2,
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
  ): Promise<void> {
    const client = tx ?? this.prisma;
    const normalizedEmail = email.trim().toLowerCase();

    const pendings = await client.pendingFreeGenerationGrant.findMany({
      where: {
        email: normalizedEmail,
        consumedByUserId: null,
      },
    });

    if (pendings.length === 0) return;

    for (const pending of pendings) {
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

      await client.pendingFreeGenerationGrant.update({
        where: { id: pending.id },
        data: {
          consumedByUserId: userId,
          consumedAt: new Date(),
        },
      });
    }

    this.logger.log(
      `Consumed ${pendings.length} pending grant(s) for ${normalizedEmail} → user ${userId}`,
    );
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
