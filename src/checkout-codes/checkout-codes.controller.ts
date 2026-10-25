import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CheckoutCodesService } from './checkout-codes.service';
import { CreateCheckoutCodeDto, UpdateCheckoutCodeDto } from './dto/checkout-code.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin/checkout-codes')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class CheckoutCodesController {
  constructor(private readonly service: CheckoutCodesService) {}

  @Get()
  @ApiOperation({ summary: 'Códigos de checkout extras (por marca e por conta do gateway)' })
  @ApiQuery({ name: 'planId', required: false })
  @ApiQuery({ name: 'creditPackageId', required: false })
  @ApiQuery({ name: 'brand', required: false })
  list(
    @Query('planId') planId?: string,
    @Query('creditPackageId') creditPackageId?: string,
    @Query('brand') brand?: string,
  ) {
    return this.service.list({ planId, creditPackageId, brand });
  }

  @Post()
  @ApiOperation({ summary: 'Cadastra um código extra de um plano ou pacote' })
  create(@Body() dto: CreateCheckoutCodeDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edita marca, moeda, link, conta, nota ou ativo (código e alvo não mudam)' })
  update(@Param('id') id: string, @Body() dto: UpdateCheckoutCodeDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Apaga o código extra (vendas novas com ele deixam de ser reconhecidas)' })
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
