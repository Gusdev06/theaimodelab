import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators';
import { GreennWebhookService } from './greenn-webhook.service';

@ApiTags('webhooks')
@Controller('api/v1/webhooks')
export class GreennWebhookController {
  private readonly logger = new Logger(GreennWebhookController.name);

  constructor(private readonly greennWebhookService: GreennWebhookService) {}

  @Public()
  @Post(['greenn', 'green'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Greenn webhook endpoint (compra de curso → pending grant)' })
  async greennWebhook(
    @Body() payload: any,
    @Headers() headers: Record<string, string>,
    @Query('token') queryToken?: string,
  ) {
    this.logger.log(`Greenn webhook received: ${JSON.stringify(payload).slice(0, 500)}`);
    const result = await this.greennWebhookService.handle(payload, headers, queryToken);
    return { received: true, ...result };
  }
}
