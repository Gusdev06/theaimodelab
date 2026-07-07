import { Controller, Get, Query, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ListMarketingLeadsQueryDto } from './dto/list-marketing-leads-query.dto';
import { MarketingLeadsService } from './marketing-leads.service';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin/marketing-leads')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class MarketingLeadsAdminController {
  constructor(private readonly marketingLeadsService: MarketingLeadsService) {}

  @Get()
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'List marketing leads captured by public funnels' })
  async list(@Query() query: ListMarketingLeadsQueryDto) {
    return this.marketingLeadsService.listForAdmin(query);
  }
}
