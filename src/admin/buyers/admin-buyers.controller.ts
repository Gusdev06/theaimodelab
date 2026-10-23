import {
  Controller,
  Get,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminBuyersService } from './admin-buyers.service';

export class BuyersQueryDto {
  @ApiPropertyOptional({ default: 90, minimum: 1, maximum: 365 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days: number = 90;
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin/stats')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class AdminBuyersController {
  constructor(private readonly service: AdminBuyersService) {}

  @Get('buyers')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({
    summary:
      'Raio-X de compradores: país, plano, tempo da isca até a compra e campanha (só agregados)',
  })
  async getBuyers(@Query() dto: BuyersQueryDto) {
    return this.service.getBuyersReport(dto.days);
  }
}
