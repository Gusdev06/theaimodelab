import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BrandKey, detectBrandFromHeaders } from '../brand/brand';
import {
  CheckoutGateway,
  isSafeCheckoutUrl,
  linksByTarget,
  normalizeCheckoutCode,
  pickSaleTarget,
  SaleTarget,
} from './checkout-codes';
import { CreateCheckoutCodeDto, UpdateCheckoutCodeDto } from './dto/checkout-code.dto';

export interface SalePlan {
  id: string;
  slug: string;
  name: string;
}

export interface SalePackage {
  id: string;
  name: string;
  credits: number;
}

/**
 * Códigos de checkout extras: reconhecimento da venda nos webhooks, link da vitrine por marca e o CRUD do admin.
 *
 * Leitura nunca derruba quem chama: se a tabela ainda não existir (código no ar antes da migração) ou o banco
 * falhar só aqui, o webhook e a vitrine seguem exatamente como antes desta tabela, com o erro no log.
 */
@Injectable()
export class CheckoutCodesService {
  private readonly logger = new Logger(CheckoutCodesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Plano ou pacote de uma venda pelos códigos extras do gateway. */
  async findSaleTarget(
    gateway: CheckoutGateway,
    candidates: readonly string[],
    options: { activePlanOnly: boolean },
  ): Promise<SaleTarget<SalePlan, SalePackage> | null> {
    if (candidates.length === 0) return null;
    try {
      const rows = await this.prisma.checkoutCode.findMany({
        where: { gateway, code: { in: [...candidates] }, isActive: true },
        select: {
          code: true,
          plan: { select: { id: true, slug: true, name: true, isActive: true } },
          creditPackage: { select: { id: true, name: true, credits: true } },
        },
      });
      return pickSaleTarget<SalePlan, SalePackage>(candidates, rows, options.activePlanOnly);
    } catch (err) {
      this.logger.error(
        `checkout_codes: leitura falhou no webhook ${gateway} (segue sem os códigos extras): ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Links da vitrine da marca de quem pediu, por plano ou pacote, numa moeda. Na marca de origem, ou sem link
   * próprio, devolve mapa vazio e o chamador mostra o link de sempre.
   */
  async storefrontLinks(
    headers: Record<string, unknown> | undefined,
    currency: string,
    target: 'plan' | 'package',
  ): Promise<Map<string, string>> {
    const brand: BrandKey | null = detectBrandFromHeaders(headers);
    if (!brand || brand === 'taml') return new Map();
    try {
      const rows = await this.prisma.checkoutCode.findMany({
        where: {
          brand,
          currency: currency.toUpperCase(),
          isActive: true,
          checkoutUrl: { not: null },
          ...(target === 'plan' ? { planId: { not: null } } : { creditPackageId: { not: null } }),
        },
        orderBy: { updatedAt: 'desc' },
        select: { planId: true, creditPackageId: true, checkoutUrl: true },
      });
      return linksByTarget(rows, target);
    } catch (err) {
      this.logger.error(
        `checkout_codes: leitura falhou na vitrine ${brand}/${currency} (mostra o link de origem): ${(err as Error).message}`,
      );
      return new Map();
    }
  }

  // ─────────────────────────────── admin ───────────────────────────────

  list(filter: { planId?: string; creditPackageId?: string; brand?: string }) {
    return this.prisma.checkoutCode.findMany({
      where: {
        ...(filter.planId ? { planId: filter.planId } : {}),
        ...(filter.creditPackageId ? { creditPackageId: filter.creditPackageId } : {}),
        ...(filter.brand ? { brand: filter.brand } : {}),
      },
      orderBy: [{ planId: 'asc' }, { creditPackageId: 'asc' }, { createdAt: 'asc' }],
      include: {
        plan: { select: { slug: true, name: true } },
        creditPackage: { select: { name: true } },
      },
    });
  }

  async create(dto: CreateCheckoutCodeDto) {
    const gateway = dto.gateway as CheckoutGateway;
    const code = normalizeCheckoutCode(gateway, dto.code);
    if (!code) throw new BadRequestException('Código inválido: use o código do postback/oferta ou o link de checkout');
    if (Boolean(dto.planId) === Boolean(dto.creditPackageId)) {
      throw new BadRequestException('Informe planId OU creditPackageId (um dos dois)');
    }
    const checkoutUrl = this.checkedUrl(dto.checkoutUrl);
    await this.assertTargetAndNotPrimary(gateway, code, dto.planId, dto.creditPackageId);

    try {
      return await this.prisma.checkoutCode.create({
        data: {
          gateway,
          code,
          brand: dto.brand ?? 'taml',
          currency: dto.currency.toUpperCase(),
          checkoutUrl,
          account: dto.account?.trim() || null,
          note: dto.note?.trim() || null,
          planId: dto.planId ?? null,
          creditPackageId: dto.creditPackageId ?? null,
          isActive: dto.isActive ?? true,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`O código ${code} da ${gateway} já está cadastrado`);
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateCheckoutCodeDto) {
    await this.findOrThrow(id);
    const data: Prisma.CheckoutCodeUpdateInput = {};
    if (dto.brand !== undefined) data.brand = dto.brand;
    if (dto.currency !== undefined) data.currency = dto.currency.toUpperCase();
    if (dto.checkoutUrl !== undefined) data.checkoutUrl = this.checkedUrl(dto.checkoutUrl);
    if (dto.account !== undefined) data.account = dto.account?.trim() || null;
    if (dto.note !== undefined) data.note = dto.note?.trim() || null;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    return this.prisma.checkoutCode.update({ where: { id }, data });
  }

  async remove(id: string) {
    await this.findOrThrow(id);
    await this.prisma.checkoutCode.delete({ where: { id } });
    return { deleted: true };
  }

  private async findOrThrow(id: string) {
    const row = await this.prisma.checkoutCode.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw new NotFoundException('Código de checkout não encontrado');
    return row;
  }

  private checkedUrl(value: string | null | undefined): string | null {
    const url = value?.trim() || null;
    if (url && !isSafeCheckoutUrl(url)) throw new BadRequestException('checkoutUrl precisa ser um link https');
    return url;
  }

  /**
   * O alvo existe e o código não é o principal de nenhum plano/pacote: o principal já é reconhecido, e repetir
   * aqui (ou apontar para outro alvo) faria a mesma venda casar com dois itens.
   */
  private async assertTargetAndNotPrimary(
    gateway: CheckoutGateway,
    code: string,
    planId: string | undefined,
    creditPackageId: string | undefined,
  ): Promise<void> {
    if (planId) {
      const plan = await this.prisma.plan.findUnique({ where: { id: planId }, select: { id: true } });
      if (!plan) throw new NotFoundException('Plano não encontrado');
    }
    if (creditPackageId) {
      const pkg = await this.prisma.creditPackage.findUnique({ where: { id: creditPackageId }, select: { id: true } });
      if (!pkg) throw new NotFoundException('Pacote não encontrado');
    }

    const primary = gateway === 'perfectpay' ? { perfectpayPlanCode: code } : { caktoOfferCode: code };
    const [planWithCode, packageWithCode] = await Promise.all([
      this.prisma.plan.findFirst({ where: primary, select: { slug: true } }),
      this.prisma.creditPackage.findFirst({ where: primary, select: { name: true } }),
    ]);
    const owner = planWithCode ? `plano ${planWithCode.slug}` : packageWithCode ? `pacote ${packageWithCode.name}` : null;
    if (owner) {
      throw new ConflictException(`O código ${code} já é o código principal do ${owner}`);
    }
  }
}
