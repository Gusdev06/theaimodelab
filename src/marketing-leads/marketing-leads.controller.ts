import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators';
import { CaptureMarketingLeadDto } from './dto/capture-marketing-lead.dto';
import { MarketingLeadsService } from './marketing-leads.service';

@ApiTags('marketing-leads')
@Controller('api/v1/marketing-leads')
export class MarketingLeadsController {
  constructor(private readonly marketingLeadsService: MarketingLeadsService) {}

  @Public()
  @Post()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Capture a public marketing lead from sales funnels' })
  @ApiResponse({ status: 201, description: 'Lead captured or updated' })
  async capture(@Body() dto: CaptureMarketingLeadDto): Promise<{ id: string; captured: true }> {
    return this.marketingLeadsService.capture(dto);
  }
}
