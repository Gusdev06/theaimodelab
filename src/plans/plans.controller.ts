import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { PlansService } from './plans.service';
import { PlanResponseDto } from './dto/plan-response.dto';
import { Public } from '../common/decorators/public.decorator';

// Preço de assinatura em USD (centavos) por plano. Fonte da verdade é a tabela
// plan_prices (USD); este mapa é só um fallback para nunca exibir preço em BRL
// caso a linha USD ainda não exista no banco.
const USD_PRICE_CENTS_FALLBACK: Record<string, number> = {
  creator: 1990,
  pro: 3990,
  advanced: 5490,
  studio: 7990,
};

@ApiTags('plans')
@Controller('api/v1/plans')
export class PlansController {
  constructor(private readonly plansService: PlansService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Lista os planos mensais disponíveis' })
  @ApiQuery({ name: 'currency', required: false, example: 'USD' })
  @ApiResponse({ status: 200, type: [PlanResponseDto] })
  async findAll(
    @Query('currency') currencyQuery?: string,
  ): Promise<PlanResponseDto[]> {
    // Monetização é 100% assinatura mensal via Perfect Pay, precificada em USD
    // (não há mais preço em BRL). Ignoramos a moeda pedida e sempre resolvemos USD
    // a partir de plan_prices; o front só redireciona para o checkout recorrente.
    void currencyQuery;
    const requestedCurrency = 'USD';
    const plans = await this.plansService.findAllPlans();
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
          checkoutUrl: p.checkoutUrl ?? null,
        };
      }),
    );
  }
}
