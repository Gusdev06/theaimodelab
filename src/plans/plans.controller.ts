import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { PlansService } from './plans.service';
import { PlanResponseDto } from './dto/plan-response.dto';
import { Public } from '../common/decorators/public.decorator';
import { CheckoutCodesService } from '../checkout-codes/checkout-codes.service';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { isInAppHomeReferer, subscriptionCheckoutUrlFor } from './prepaid-plan';

// Preço de assinatura em USD (centavos) por plano. Fonte da verdade é a tabela
// plan_prices (USD); este mapa é só um fallback para nunca exibir preço em BRL
// caso a linha USD ainda não exista no banco.
const USD_PRICE_CENTS_FALLBACK: Record<string, number> = {
  creator: 1990,
  pro: 3990,
  advanced: 5490,
  studio: 7990,
  agency: 19990,
};

@ApiTags('plans')
@Controller('api/v1/plans')
export class PlansController {
  constructor(
    private readonly plansService: PlansService,
    private readonly checkoutCodes: CheckoutCodesService,
  ) {}

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get()
  @ApiOperation({ summary: 'Lista os planos mensais disponíveis' })
  @ApiQuery({ name: 'currency', required: false, example: 'USD' })
  @ApiResponse({ status: 200, type: [PlanResponseDto] })
  async findAll(
    @Query('currency') currencyQuery?: string,
    // `user` só vem preenchido com Bearer válido (OptionalJwtAuthGuard); sem token segue público.
    @Req() req?: { headers?: Record<string, unknown>; user?: { sub?: string } | false | null },
  ): Promise<PlanResponseDto[]> {
    // Duas vitrines por moeda:
    //  - BRL (Brasil, /pt-br): assinatura via Cakto. Expõe os 7 tiers com PlanPrice
    //    BRL ativo + link de checkout Cakto (inclui os legados ultra-basic/starter/basic).
    //  - USD (default, /en e /es): assinatura via Perfect Pay, os planos ativos e
    //    públicos (Pro/Advanced/Studio/Agency; Creator é isPublic:false desde 2026-09-16).
    const requestedCurrency =
      typeof currencyQuery === 'string' && currencyQuery.trim().toUpperCase() === 'BRL'
        ? 'BRL'
        : 'USD';

    // Link de checkout da marca do site que pediu (Funvmake com produtos próprios).
    // Sem link próprio, ou na marca de origem, vale o link do plano.
    const brandLinks = await this.checkoutCodes.storefrontLinks(req?.headers, requestedCurrency, 'plan');

    const userId = req?.user && typeof req.user.sub === 'string' ? req.user.sub : null;

    if (requestedCurrency === 'BRL') {
      const brlPlans = await this.plansService.findBrlPublicPlans();
      // Desde 18/11 o BRL também vende 30 dias pagamento único (Cakto: Pix avulso não tem a recusa
      // do Pix Automático). Assinante recorrente da Cakto segue vendo o link da assinatura: o
      // pré-pago criaria outra cobrança enquanto a recorrência continua.
      const keepCaktoSubscription = userId ? await this.plansService.hasRecurringCaktoSubscription(userId) : false;
      return brlPlans.map((p) => ({
        ...p,
        // Assinante recorrente da Cakto fica no link da assinatura do MESMO produto, também na vitrine de outra
        // marca: o link da marca (outro produto) abriria uma 2ª cobrança que não cancela a 1ª (TKT-354).
        checkoutUrl: keepCaktoSubscription
          ? (subscriptionCheckoutUrlFor(p.checkoutUrl) ?? p.checkoutUrl)
          : (brandLinks.get(p.id) ?? p.checkoutUrl),
      }));
    }

    const plans = await this.plansService.findAllPlans();
    // Assinante recorrente da Perfect Pay continua vendo o link de ASSINATURA (upgrade como
    // antes de 17/11): o pré-pago criaria outra assinatura e a recorrência seguiria cobrando.
    // Sem token, a Início (/home) só pede /plans para o cartão "upgrade pelo ritmo", que só
    // aparece para assinante da Perfect Pay: ali vale o link de assinatura (best-effort pelo
    // Referer, porque o site congelado não manda o token nessa chamada).
    const keepSubscriptionLinks = userId
      ? await this.plansService.hasRecurringPerfectpaySubscription(userId)
      : isInAppHomeReferer(req?.headers?.referer);
    const planCheckoutUrl = (url: string | null | undefined): string | null =>
      (keepSubscriptionLinks ? subscriptionCheckoutUrlFor(url) : null) ?? url ?? null;
    return Promise.all(
      plans.map(async (p) => {
        // Sempre USD. Ordem: plan_prices(USD) → fallback fixo → (último caso) priceCents.
        let priceCents = USD_PRICE_CENTS_FALLBACK[p.slug] ?? p.priceCents;
        let currency = 'USD';
        try {
          const resolved = await this.plansService.resolvePlanPrice(
            p.id,
            requestedCurrency,
          );
          priceCents = resolved.priceCents;
          currency = resolved.currency;
        } catch {
          // sem linha USD em plan_prices → usa o fallback fixo em USD já definido acima
        }
        return {
          id: p.id,
          slug: p.slug,
          name: p.name,
          description: p.description,
          priceCents,
          currency,
          creditsPerMonth: p.creditsPerMonth,
          maxConcurrentGenerations: p.maxConcurrentGenerations,
          hasWatermark: p.hasWatermark,
          galleryRetentionDays: p.galleryRetentionDays,
          hasApiAccess: p.hasApiAccess,
          sortOrder: p.sortOrder,
          billingInterval: p.billingInterval,
          basePlanSlug: p.basePlanSlug ?? null,
          // Mesma regra do BRL: assinante recorrente da Perfect Pay não recebe o link da marca (TKT-354).
          checkoutUrl: keepSubscriptionLinks
            ? planCheckoutUrl(p.checkoutUrl)
            : (brandLinks.get(p.id) ?? planCheckoutUrl(p.checkoutUrl)),
        };
      }),
    );
  }
}
