import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators';
import { BrowserMetaEventDto } from './dto/browser-meta-event.dto';
import { MetaConversionsService } from './meta-conversions.service';

@ApiTags('meta')
@Controller('api/v1/meta')
export class MetaController {
  constructor(private readonly metaConversionsService: MetaConversionsService) {}

  @Public()
  @Post('events')
  @Throttle({ default: { ttl: 60000, limit: 120 } })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Recebe eventos browser permitidos e replica via Meta Conversions API' })
  @ApiResponse({ status: 202, description: 'Evento aceito para envio server-side' })
  async trackBrowserEvent(
    @Body() dto: BrowserMetaEventDto,
    @Req() req: any,
  ): Promise<{ received: true }> {
    await this.metaConversionsService.trackBrowserEvent(
      dto.eventName,
      {
        eventId: dto.eventId,
        eventSourceUrl: dto.eventSourceUrl,
        fbp: dto.fbp,
        fbc: dto.fbc,
      },
      this.metaConversionsService.buildRequestContext(req),
      dto.customData,
      {
        email: dto.email,
        name: dto.name,
        phone: dto.phone,
        country: dto.country,
      },
    );

    return { received: true };
  }
}
