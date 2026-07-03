import { Controller, Get, Post, Query, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminFinanceService } from './admin-finance.service';

@ApiTags('admin/stripe/finance')
@ApiBearerAuth()
@Controller('api/v1/admin/stripe/finance')
@UseGuards(RolesGuard)
@Roles('ADMIN')
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class AdminFinanceController {
  constructor(private readonly finance: AdminFinanceService) {}

  @Get('summary')
  @ApiOperation({ summary: 'KPIs financeiros (MRR, ARR, churn, LTV, margem, forecast) — fonte Stripe' })
  summary() {
    return this.finance.getSummary();
  }

  @Get('mrr-history')
  @ApiOperation({ summary: 'Histórico mensal de MRR/receita/churn (Stripe)' })
  mrrHistory(@Query('months') months?: string) {
    const m = Number(months ?? 12);
    return this.finance.getMrrHistory(Number.isFinite(m) ? m : 12);
  }

  @Get('customers')
  @ApiOperation({ summary: 'Apenas clientes com cobrança no Stripe (exclui afiliados/operação)' })
  customers(
    @Query('limit') limit?: string,
    @Query('onlyActive') onlyActive?: string,
    @Query('search') search?: string,
  ) {
    return this.finance.listPayingCustomers({
      limit: limit ? Number(limit) : 100,
      onlyActive: onlyActive === 'true',
      search,
    });
  }

  @Get('diagnostic')
  @ApiOperation({ summary: 'Diagnóstico do MRR — lista todas as assinaturas com valor mensal' })
  diagnostic() {
    return this.finance.getMrrDiagnostic();
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Invalida cache e força recálculo' })
  refresh() {
    this.finance.invalidateCache();
    return { ok: true };
  }
}
