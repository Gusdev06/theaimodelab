import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { PlansService } from './plans.service';
import { PlanResponseDto } from './dto/plan-response.dto';
import { Public } from '../common/decorators/public.decorator';
import { detectLocaleFromHeaders } from '../common/utils/locale.util';

@ApiTags('plans')
@Controller('api/v1/plans')
export class PlansController {
  constructor(private readonly plansService: PlansService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Lista todos os planos disponíveis' })
  @ApiQuery({ name: 'currency', required: false, example: 'USD' })
  @ApiResponse({ status: 200, type: [PlanResponseDto] })
  async findAll(
    @Req() req: any,
    @Query('currency') currencyQuery?: string,
  ): Promise<PlanResponseDto[]> {
    const currency = (
      currencyQuery ?? detectLocaleFromHeaders(req.headers).currency
    ).toUpperCase();

    const plans = await this.plansService.findAllPlans();

    return Promise.all(
      plans.map(async (plan) => {
        let priceCents = plan.priceCents;
        let resolvedCurrency = 'BRL';

        if (plan.slug !== 'free') {
          try {
            const resolved = await this.plansService.resolvePlanPrice(plan.id, currency);
            priceCents = resolved.priceCents;
            resolvedCurrency = resolved.currency;
          } catch {
            // fallback silencioso — mantém valores default do Plan
          }
        } else {
          resolvedCurrency = currency;
        }

        return {
          id: plan.id,
          slug: plan.slug,
          name: plan.name,
          description: plan.description,
          priceCents,
          currency: resolvedCurrency,
          creditsPerMonth: plan.creditsPerMonth,
          maxConcurrentGenerations: plan.maxConcurrentGenerations,
          hasWatermark: plan.hasWatermark,
          galleryRetentionDays: plan.galleryRetentionDays,
          hasApiAccess: plan.hasApiAccess,
        };
      }),
    );
  }
}
