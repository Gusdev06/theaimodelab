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
  @ApiOperation({ summary: 'Lista todos os planos disponíveis' })
  @ApiResponse({ status: 200, type: [PlanResponseDto] })
  async findAll(): Promise<PlanResponseDto[]> {
    // Modelo de assinatura descontinuado: a monetização passou a ser 100% via
    // pacotes de crédito avulsos (ver GET /api/v1/credits/packages).
    // Ocultamos todos os planos da listagem pública, mantendo a infra de
    // subscriptions intacta no backend para assinantes legados.
    return [];
  }
}
