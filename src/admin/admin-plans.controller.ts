import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminPlansService } from './admin-plans.service';
import { UpsertPlanDto } from './dto/upsert-plan.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin/plans')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class AdminPlansController {
  constructor(private readonly service: AdminPlansService) {}

  @Get()
  @ApiOperation({ summary: 'Todos os planos (ativos ou não) com preços por moeda e contagem de assinaturas' })
  list() {
    return this.service.list();
  }

  @Post()
  @ApiOperation({ summary: 'Cria um plano (slug, name e creditsPerMonth obrigatórios)' })
  create(@Body() dto: UpsertPlanDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edita campos do plano e/ou preços por moeda (upsert por currency)' })
  update(@Param('id') id: string, @Body() dto: UpsertPlanDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Apaga o plano — só sem nenhuma assinatura apontando pra ele' })
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Delete(':id/prices/:currency')
  @ApiOperation({ summary: 'Remove o preço de uma moeda' })
  removePrice(@Param('id') id: string, @Param('currency') currency: string) {
    return this.service.removePrice(id, currency);
  }
}
