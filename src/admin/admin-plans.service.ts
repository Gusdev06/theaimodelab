import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PlanPriceInputDto, UpsertPlanDto } from './dto/upsert-plan.dto';

const CAKTO_PAY_RE = /pay\.cakto\.com\.br\/([a-z0-9]+)/i;

/** Campos editáveis do plano, em valores puros (servem no create e no update). */
type PlanFields = Partial<Omit<Prisma.PlanUncheckedCreateInput, 'id' | 'slug' | 'createdAt' | 'updatedAt'>>;
const caktoCheckoutUrl = (offer: string) => `https://pay.cakto.com.br/${offer}`;

/**
 * CRUD de planos pelo admin. Regras que o formulário não deveria precisar saber:
 *  - is_public esconde da vitrine sem matar renovação; is_active=false mata (o webhook
 *    da Perfect Pay só casa plano ativo) — por isso a UI avisa quando há assinante.
 *  - Vitrine USD/EUR = plano ativo + público + checkoutUrl (Perfect Pay).
 *  - Vitrine BRL = linha plan_prices BRL ativa + checkoutUrl (Cakto) + plano público.
 *  - Cakto: link e offer code são a mesma coisa (pay.cakto.com.br/<code>) — o admin
 *    preenche um e o outro é derivado.
 *  - Apagar só é permitido sem assinatura alguma apontando pro plano (FK sem cascade).
 */
@Injectable()
export class AdminPlansService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const [plans, subsByPlan] = await Promise.all([
      this.prisma.plan.findMany({
        orderBy: { sortOrder: 'asc' },
        include: { prices: { orderBy: { currency: 'asc' } } },
      }),
      this.prisma.subscription.groupBy({
        by: ['planId', 'status'],
        _count: { _all: true },
      }),
    ]);

    const counts = new Map<string, { active: number; total: number }>();
    for (const row of subsByPlan) {
      const cur = counts.get(row.planId) ?? { active: 0, total: 0 };
      cur.total += row._count._all;
      if (row.status === 'ACTIVE' || row.status === 'TRIALING') cur.active += row._count._all;
      counts.set(row.planId, cur);
    }

    return plans.map((p) => ({
      ...p,
      subscriptions: counts.get(p.id) ?? { active: 0, total: 0 },
    }));
  }

  async create(dto: UpsertPlanDto) {
    if (!dto.slug) throw new BadRequestException('slug é obrigatório na criação');
    if (!dto.name) throw new BadRequestException('name é obrigatório na criação');
    if (dto.creditsPerMonth == null) throw new BadRequestException('creditsPerMonth é obrigatório');

    const exists = await this.prisma.plan.findUnique({ where: { slug: dto.slug } });
    if (exists) throw new ConflictException(`Já existe um plano com slug "${dto.slug}"`);

    const { prices, ...fields } = dto;
    const data = this.toPlanData(fields);

    const plan = await this.prisma.plan.create({
      data: {
        slug: dto.slug,
        name: dto.name,
        creditsPerMonth: dto.creditsPerMonth,
        ...data,
      },
    });
    if (prices?.length) await this.upsertPrices(plan.id, plan.caktoOfferCode, prices);
    return this.findOne(plan.id);
  }

  async update(id: string, dto: UpsertPlanDto) {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('Plano não encontrado');
    if (dto.slug && dto.slug !== plan.slug) {
      // Slug é a chave em meia dúzia de mapas do app (ordem, cotas, i18n); trocar
      // depois de criado quebra tudo silenciosamente. Cria outro plano se precisar.
      throw new BadRequestException('slug não pode ser alterado depois de criado');
    }

    const { prices, slug: _slug, ...fields } = dto;
    const data = this.toPlanData(fields);

    const updated = await this.prisma.plan.update({ where: { id }, data });
    if (prices?.length) await this.upsertPrices(id, updated.caktoOfferCode, prices);
    return this.findOne(id);
  }

  async remove(id: string) {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('Plano não encontrado');

    const subs = await this.prisma.subscription.count({ where: { planId: id } });
    const scheduled = await this.prisma.subscription.count({ where: { scheduledPlanId: id } });
    if (subs > 0 || scheduled > 0) {
      throw new ConflictException(
        `Plano "${plan.name}" tem ${subs} assinatura(s) (${scheduled} agendada(s)). ` +
          'Não dá pra apagar: desmarque "Aparece na vitrine" pra esconder, ou desative.',
      );
    }

    // plan_prices tem cascade; subscriptions não (por isso o count acima).
    await this.prisma.plan.delete({ where: { id } });
    return { ok: true, id, slug: plan.slug };
  }

  async removePrice(planId: string, currency: string) {
    const cur = currency.toUpperCase();
    const price = await this.prisma.planPrice.findUnique({
      where: { planId_currency: { planId, currency: cur } },
    });
    if (!price) throw new NotFoundException(`Plano não tem preço em ${cur}`);
    await this.prisma.planPrice.delete({ where: { id: price.id } });
    return this.findOne(planId);
  }

  private async findOne(id: string) {
    const plan = await this.prisma.plan.findUnique({
      where: { id },
      include: { prices: { orderBy: { currency: 'asc' } } },
    });
    if (!plan) throw new NotFoundException('Plano não encontrado');
    const [active, total] = await Promise.all([
      this.prisma.subscription.count({ where: { planId: id, status: { in: ['ACTIVE', 'TRIALING'] } } }),
      this.prisma.subscription.count({ where: { planId: id } }),
    ]);
    return { ...plan, subscriptions: { active, total } };
  }

  /** Converte o DTO (camelCase) pros campos do Prisma (alguns são snake_case no schema). */
  private toPlanData(dto: Omit<UpsertPlanDto, 'prices' | 'slug'>): PlanFields {
    const data: PlanFields = {};
    const emptyToNull = (v: string | null | undefined) =>
      v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim();

    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = emptyToNull(dto.description);
    if (dto.priceCents !== undefined) data.priceCents = dto.priceCents;
    if (dto.creditsPerMonth !== undefined) data.creditsPerMonth = dto.creditsPerMonth;
    if (dto.maxConcurrentGenerations !== undefined) data.maxConcurrentGenerations = dto.maxConcurrentGenerations;
    if (dto.hasWatermark !== undefined) data.hasWatermark = dto.hasWatermark;
    if (dto.galleryRetentionDays !== undefined) data.galleryRetentionDays = dto.galleryRetentionDays;
    if (dto.hasApiAccess !== undefined) data.hasApiAccess = dto.hasApiAccess;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.isPublic !== undefined) data.isPublic = dto.isPublic;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.checkoutUrl !== undefined) data.checkoutUrl = emptyToNull(dto.checkoutUrl);
    if (dto.perfectpayPlanCode !== undefined) data.perfectpayPlanCode = emptyToNull(dto.perfectpayPlanCode);
    if (dto.caktoOfferCode !== undefined) {
      // Aceita o link inteiro colado no campo do code.
      const raw = emptyToNull(dto.caktoOfferCode);
      const m = raw ? CAKTO_PAY_RE.exec(raw) : null;
      data.caktoOfferCode = m ? m[1] : raw;
    }
    if (dto.avatarCloneEnabled !== undefined) data.avatar_clone_enabled = dto.avatarCloneEnabled;
    if (dto.avatarCloneLimit !== undefined) data.avatar_clone_limit = dto.avatarCloneLimit;
    if (dto.voiceCloneLimit !== undefined) data.voice_clone_limit = dto.voiceCloneLimit;
    if (dto.unlimitedPriority !== undefined) data.unlimitedPriority = dto.unlimitedPriority;
    if (dto.unlimitedModels !== undefined) {
      data.unlimitedModels =
        dto.unlimitedModels === null
          ? Prisma.DbNull
          : (dto.unlimitedModels.map((m) => ({
              modelVariant: m.modelVariant,
              resolutions: m.resolutions,
            })) as Prisma.InputJsonValue);
    }
    return data;
  }

  private async upsertPrices(
    planId: string,
    caktoOfferCode: string | null,
    prices: PlanPriceInputDto[],
  ) {
    let derivedOffer: string | null = null;

    for (const p of prices) {
      const currency = p.currency.toUpperCase();
      let checkoutUrl = p.checkoutUrl == null || p.checkoutUrl.trim() === '' ? null : p.checkoutUrl.trim();

      if (currency === 'BRL') {
        if (!checkoutUrl && caktoOfferCode) checkoutUrl = caktoCheckoutUrl(caktoOfferCode);
        const m = checkoutUrl ? CAKTO_PAY_RE.exec(checkoutUrl) : null;
        if (m && !caktoOfferCode) derivedOffer = m[1];
      }

      await this.prisma.planPrice.upsert({
        where: { planId_currency: { planId, currency } },
        update: { priceCents: p.priceCents, checkoutUrl, isActive: p.isActive ?? true },
        // stripePriceId é NOT NULL no schema; sem Stripe fica vazio (igual ao seed).
        create: { planId, currency, priceCents: p.priceCents, checkoutUrl, isActive: p.isActive ?? true, stripePriceId: '' },
      });
    }

    // Colou o link da Cakto no BRL e não preencheu o offer code: deriva pro webhook casar.
    if (derivedOffer) {
      await this.prisma.plan.update({ where: { id: planId }, data: { caktoOfferCode: derivedOffer } });
    }
  }
}
