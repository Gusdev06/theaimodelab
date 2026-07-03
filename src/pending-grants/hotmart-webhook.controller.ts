import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators';
import { HotmartWebhookService } from './hotmart-webhook.service';

@ApiTags('webhooks')
@Controller('api/v1/webhooks')
export class HotmartWebhookController {
  private readonly logger = new Logger(HotmartWebhookController.name);

  constructor(private readonly hotmartWebhookService: HotmartWebhookService) { }

  @Public()
  @Post('hotmart')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hotmart webhook endpoint (compra de curso)' })
  async hotmartWebhook(
    @Body() payload: any,
    @Headers() headers: Record<string, string>,
  ) {
    console.log('[HOTMART WEBHOOK] headers:', JSON.stringify(headers, null, 2));
    console.log('[HOTMART WEBHOOK] body:', JSON.stringify(payload, null, 2));
    this.logger.log(`Hotmart webhook received: ${JSON.stringify(payload)}`);

    const result = await this.hotmartWebhookService.handle(payload, headers);
    return { received: true, ...result };
  }
}
