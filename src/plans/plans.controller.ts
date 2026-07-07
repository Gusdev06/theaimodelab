import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PlansService } from './plans.service';
import { PlanResponseDto } from './dto/plan-response.dto';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('plans')
@Controller('api/v1/plans')
export class PlansController {
  constructor(private readonly plansService: PlansService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Lista os planos mensais disponíveis' })
  @ApiResponse({ status: 200, type: [PlanResponseDto] })
  async findAll(): Promise<PlanResponseDto[]> {
    // Monetização é 100% assinatura mensal via Perfect Pay. Retorna os planos
    // ativos com o link de checkout recorrente (o front redireciona pra ele).
    const plans = await this.plansService.findAllPlans();
    return plans.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.description,
      priceCents: p.priceCents,
      currency: 'BRL',
      creditsPerMonth: p.creditsPerMonth,
      maxConcurrentGenerations: p.maxConcurrentGenerations,
      hasWatermark: p.hasWatermark,
      galleryRetentionDays: p.galleryRetentionDays,
      hasApiAccess: p.hasApiAccess,
      checkoutUrl: p.checkoutUrl ?? null,
    }));
  }
}
