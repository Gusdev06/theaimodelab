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
import { HublaWebhookService } from './hubla-webhook.service';

@ApiTags('webhooks')
@Controller('api/v1/webhooks')
export class HublaWebhookController {
  private readonly logger = new Logger(HublaWebhookController.name);

  constructor(private readonly hublaWebhookService: HublaWebhookService) {}

  @Public()
  @Post('hubla')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hubla webhook endpoint (compra de curso)' })
  async hublaWebhook(
    @Body() payload: any,
    @Headers() headers: Record<string, string>,
  ) {
    console.log('[HUBLA WEBHOOK] headers:', JSON.stringify(headers, null, 2));
    console.log('[HUBLA WEBHOOK] body:', JSON.stringify(payload, null, 2));
    this.logger.log(`Hubla webhook received: ${JSON.stringify(payload)}`);

    const result = await this.hublaWebhookService.handle(payload, headers);
    return { received: true, ...result };
  }
}
