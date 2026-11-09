import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FreeGenerationType, Prisma } from '@prisma/client';
import { maskEmail } from '../affiliates/mask-email';
import {
  DecodedAffiliateRef,
  decodeAffiliateRef,
  isPackAffiliateBridgeEnabled,
  isPackBridgeLinkCodesEnabled,
} from './perfectpay-affiliate';

export type FreeGenerationBundle = Partial<Record<FreeGenerationType, number>>;

/** Sufixo que o reembolso/chargeback põe no `source` da isca. */
const REFUNDED_SOURCE_SUFFIX = ':refunded';

/**
 * Ponte Pack → plataforma: a venda (isca) que pode dar um afiliado à conta que acabou de
 * nascer. Sai da transação do cadastro; a atribuição acontece depois do commit.
 */
export interface PackBridgeCandidate {
  grantId: string;
  /** Referência gravada na isca (`ppcode:…`, `email:…`, `code:…`). */
  affiliateRef: string;
  /** E-mail de quem comprou o Pack (o da isca). */
  buyerEmail: string;
  grantCreatedAt: Date;
}

export interface SignupGrantsResult {
  consumed: number;
  packBridge: PackBridgeCandidate | null;
}

interface ClaimedGrant {
  id: string;
  email: string;
  source: string;
  affiliateRef: string | null;
  createdAt: Date;
}

const PACK_BRIDGE_AFFILIATE_SELECT = {
  id: true,
  code: true,
  isActive: true,
  userId: true,
  perfectpayAffiliateEmail: true,
  payoutEmail: true,
  pixKey: true,
  pixKeyType: true,
  user: { select: { email: true } },
} as const;

type PackBridgeAffiliate = Prisma.AffiliateGetPayload<{ select: typeof PACK_BRIDGE_AFFILIATE_SELECT }>;

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
    /** Ponte Pack → plataforma: referência do afiliado da venda (ver encodeAffiliateRef). */
    affiliateRef?: string | null;
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
          ...(params.affiliateRef ? { affiliateRef: params.affiliateRef } : {}),
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
   * Consome todas as pending grants não utilizadas do email, creditando no usuário.
   * É o caminho do login e do comprador que já tinha conta: credita as gerações e
   * NUNCA mexe no afiliado da conta (a ponte do Pack só vale no cadastro).
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
    const { consumed } = await this.consumeGrants(userId, email, tx);
    return consumed;
  }

  /**
   * Cadastro (e-mail e Google): consome as grants dentro da transação que cria a conta e
   * devolve, quando a ponte Pack → plataforma está ligada, a venda que pode dar um afiliado
   * à conta: a mais antiga com referência de afiliado, não reembolsada. Aqui nada é
   * resolvido nem gravado na conta: isso é o `attributeSignupToPackAffiliate`, depois do
   * commit, para a ponte nunca derrubar o cadastro.
   */
  async consumeForSignup(
    userId: string,
    email: string,
    tx: Prisma.TransactionClient,
  ): Promise<SignupGrantsResult> {
    const { consumed, claimed } = await this.consumeGrants(userId, email, tx);
    if (!isPackAffiliateBridgeEnabled(process.env.PACK_AFFILIATE_BRIDGE_ENABLED)) {
      return { consumed, packBridge: null };
    }

    try {
      // `claimed` já vem da venda mais antiga para a mais nova: vale o afiliado da primeira.
      const winner = claimed.find(
        (grant) =>
          !grant.source.endsWith(REFUNDED_SOURCE_SUFFIX) &&
          decodeAffiliateRef(grant.affiliateRef).length > 0,
      );
      return {
        consumed,
        packBridge: winner?.affiliateRef
          ? {
              grantId: winner.id,
              affiliateRef: winner.affiliateRef,
              buyerEmail: winner.email,
              grantCreatedAt: winner.createdAt,
            }
          : null,
      };
    } catch (error: unknown) {
      // Escolher a venda candidata roda dentro da transação do cadastro: erro aqui não pode desfazer a conta.
      this.logger.warn(
        `Ponte Pack → plataforma: não consegui ler a venda candidata da conta ${userId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return { consumed, packBridge: null };
    }
  }

  private async consumeGrants(
    userId: string,
    email: string,
    client: Prisma.TransactionClient,
  ): Promise<{ consumed: number; claimed: ClaimedGrant[] }> {
    const normalizedEmail = email.trim().toLowerCase();

    const pendings = await client.pendingFreeGenerationGrant.findMany({
      where: {
        email: normalizedEmail,
        consumedByUserId: null,
      },
      // Mais antiga primeiro: se duas vendas trazem afiliados diferentes, vale o da primeira.
      orderBy: { createdAt: 'asc' },
    });

    const claimedGrants: ClaimedGrant[] = [];
    for (const pending of pendings) {
      // Reserva atômica: webhook, cadastro e login podem consumir a mesma grant
      // ao mesmo tempo — só quem marcar primeiro credita.
      const claimed = await client.pendingFreeGenerationGrant.updateMany({
        where: { id: pending.id, consumedByUserId: null },
        data: { consumedByUserId: userId, consumedAt: new Date() },
      });
      if (claimed.count === 0) continue;
      claimedGrants.push({
        id: pending.id,
        email: pending.email,
        source: pending.source,
        affiliateRef: pending.affiliateRef ?? null,
        createdAt: pending.createdAt,
      });

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

    if (claimedGrants.length > 0) {
      this.logger.log(
        `Consumed ${claimedGrants.length} pending grant(s) for ${normalizedEmail} → user ${userId}`,
      );
    }
    return { consumed: claimedGrants.length, claimed: claimedGrants };
  }

  /**
   * Ponte Pack → plataforma, DEPOIS do commit do cadastro: grava na conta nova o afiliado
   * da plataforma que corresponde ao afiliado da Perfect Pay que vendeu o Pack. Devolve o
   * código atribuído ou null. Nunca lança: qualquer falha vira aviso no log e a conta
   * segue sem afiliado.
   */
  async attributeSignupToPackAffiliate(
    user: { id: string; createdAt: Date },
    candidate: PackBridgeCandidate | null | undefined,
  ): Promise<string | null> {
    if (!candidate) return null;
    if (!isPackAffiliateBridgeEnabled(process.env.PACK_AFFILIATE_BRIDGE_ENABLED)) return null;
    try {
      return await this.attributeToPackAffiliate(user, candidate);
    } catch (error: unknown) {
      this.logger.warn(
        `Ponte Pack → plataforma: não consegui atribuir a conta ${user.id} (compra de ${maskEmail(candidate.buyerEmail)}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async attributeToPackAffiliate(
    user: { id: string; createdAt: Date },
    candidate: PackBridgeCandidate,
  ): Promise<string | null> {
    const refs = decodeAffiliateRef(candidate.affiliateRef);
    if (refs.length === 0) return null;

    // Só conta nova: a conta tem de ter nascido depois da venda do Pack.
    if (user.createdAt.getTime() < candidate.grantCreatedAt.getTime()) return null;

    const buyerLabel = maskEmail(candidate.buyerEmail);
    const affiliate = await this.findPlatformAffiliate(refs);
    if (!affiliate?.isActive) {
      this.logger.warn(
        `Ponte Pack → plataforma: venda de afiliado da Perfect Pay (${this.describeRefs(refs)}) sem afiliado ativo ` +
          `correspondente na plataforma; conta ${user.id} segue sem afiliado`,
      );
      return null;
    }
    if (this.isSelfReferral(affiliate, user.id, candidate.buyerEmail)) {
      this.logger.warn(
        `Ponte Pack → plataforma: comprador ${buyerLabel} é o próprio afiliado ${affiliate.code}; conta ${user.id} segue sem afiliado`,
      );
      return null;
    }

    // Defesa extra da regra "só conta nova": quem já pagou algo ou já entrou por indicação não muda de dono.
    const paidBefore = await this.prisma.payment.findFirst({
      where: { userId: user.id, status: 'COMPLETED' },
      select: { id: true },
    });
    if (paidBefore) return null;
    const referral = await this.prisma.referral.findUnique({
      where: { referredUserId: user.id },
      select: { id: true },
    });
    if (referral) return null;

    const attributed = await this.prisma.$transaction(async (tx) => {
      // A isca guarda quem ela atribuiu (o reembolso desfaz por aqui). A marca só entra se a
      // venda não foi reembolsada nesse meio-tempo; reembolso e atribuição disputam esta linha.
      const marked = await tx.pendingFreeGenerationGrant.updateMany({
        where: {
          id: candidate.grantId,
          consumedByUserId: user.id,
          affiliateRef: { not: null },
          NOT: { source: { endsWith: REFUNDED_SOURCE_SUFFIX } },
        },
        data: { attributedAffiliateCode: affiliate.code },
      });
      if (marked.count === 0) return false;

      const updated = await tx.user.updateMany({
        where: { id: user.id, referredByCode: null },
        data: { referredByCode: affiliate.code },
      });
      if (updated.count > 0) return true;

      // A conta já tinha afiliado (link de convite no cadastro): esta venda não atribuiu nada.
      await tx.pendingFreeGenerationGrant.updateMany({
        where: { id: candidate.grantId },
        data: { attributedAffiliateCode: null },
      });
      return false;
    });
    if (!attributed) return null;

    this.logger.log(
      `Ponte Pack → plataforma: conta ${user.id} atribuída ao afiliado ${affiliate.code} (${this.describeRefs(refs)})`,
    );
    return affiliate.code;
  }

  /**
   * Acha o afiliado da plataforma, na ordem das partes da referência:
   *   - `ppcode:` → SÓ pela coluna `perfectpayAffiliateCode` (que o admin grava). O código da
   *     Perfect Pay nunca é comparado com `Affiliate.code`: são espaços de nomes diferentes.
   *   - `email:`  → e-mail da Perfect Pay que o admin gravou no afiliado; na falta, afiliado
   *     cuja conta (com e-mail confirmado) tem esse e-mail.
   *   - `code:`   → código da plataforma vindo do link; só com PACK_AFFILIATE_BRIDGE_LINK_CODES.
   */
  private async findPlatformAffiliate(refs: DecodedAffiliateRef[]): Promise<PackBridgeAffiliate | null> {
    const select = PACK_BRIDGE_AFFILIATE_SELECT;

    for (const ref of refs) {
      let affiliate: PackBridgeAffiliate | null = null;
      if (ref.kind === 'ppcode') {
        affiliate = await this.prisma.affiliate.findUnique({
          where: { perfectpayAffiliateCode: ref.value },
          select,
        });
      } else if (ref.kind === 'email') {
        affiliate =
          (await this.prisma.affiliate.findUnique({
            where: { perfectpayAffiliateEmail: ref.value },
            select,
          })) ??
          (await this.prisma.affiliate.findFirst({
            where: { user: { email: { equals: ref.value, mode: 'insensitive' }, emailVerified: true } },
            select,
          }));
      } else if (isPackBridgeLinkCodesEnabled(process.env.PACK_AFFILIATE_BRIDGE_LINK_CODES)) {
        affiliate = await this.prisma.affiliate.findUnique({ where: { code: ref.value }, select });
      }
      if (affiliate) return affiliate;
    }
    return null;
  }

  /** O afiliado comprando o próprio Pack (ou com o e-mail dele) não vira cliente de si mesmo. */
  private isSelfReferral(affiliate: PackBridgeAffiliate, userId: string, buyerEmail: string): boolean {
    if (affiliate.userId === userId) return true;

    const buyer = buyerEmail.trim().toLowerCase();
    const affiliateEmails = [
      affiliate.perfectpayAffiliateEmail,
      affiliate.user?.email,
      affiliate.payoutEmail,
      affiliate.pixKeyType === 'EMAIL' ? affiliate.pixKey : null,
    ];
    return affiliateEmails.some((email) => typeof email === 'string' && email.trim().toLowerCase() === buyer);
  }

  private describeRefs(refs: DecodedAffiliateRef[]): string {
    return refs
      .map((ref) =>
        ref.kind === 'email'
          ? `e-mail ${maskEmail(ref.value)}`
          : `${ref.kind === 'ppcode' ? 'código Perfect Pay' : 'código do link'} ${ref.value}`,
      )
      .join(', ');
  }

  /**
   * Comprador que JÁ tem conta: antes o bundle só era aplicado no cadastro e
   * ele nunca recebia (TKT-109). Falha aqui não derruba o webhook — o login
   * aplica de novo. Conta que já existia nunca ganha afiliado pela ponte do Pack.
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
   * Ponte do Pack: a referência do afiliado sai da isca (venda reembolsada nunca atribui)
   * e, se foi ESTA venda que deu o afiliado à conta, a conta volta a ficar sem afiliado.
   * Comissões que já nasceram de vendas da plataforma não são tocadas aqui.
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
    let unattributed = 0;
    for (const grant of grants) {
      if (grant.source.endsWith(REFUNDED_SOURCE_SUFFIX)) continue;
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
        const refunded = await tx.pendingFreeGenerationGrant.update({
          where: { id: grant.id },
          data: {
            bundle: {},
            source: `${grant.source}${REFUNDED_SOURCE_SUFFIX}`,
            affiliateRef: null,
          },
        });
        // Lido da linha já atualizada (não da leitura de fora da transação): a atribuição do
        // cadastro pode ter gravado a marca entre uma coisa e outra. `attributedAffiliateCode`
        // fica na isca como trilha do que foi desfeito.
        const attributedCode = refunded?.attributedAffiliateCode;
        if (attributedCode && refunded.consumedByUserId) {
          const undone = await tx.user.updateMany({
            where: { id: refunded.consumedByUserId, referredByCode: attributedCode },
            data: { referredByCode: null },
          });
          unattributed += undone.count;
        }
      });
      revoked += 1;
    }
    if (revoked > 0) {
      this.logger.warn(
        `Isca reembolsada (${reason}) venda ${saleEventId}: ${revoked} grant(s) revogada(s); gerações retiradas ${JSON.stringify(removed)}` +
          (unattributed > 0 ? `; ${unattributed} conta(s) deixaram de ser do afiliado da venda` : ''),
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
