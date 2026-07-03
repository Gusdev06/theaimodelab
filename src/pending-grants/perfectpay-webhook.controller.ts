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
import { PerfectpayWebhookService } from './perfectpay-webhook.service';

@ApiTags('webhooks')
@Controller('api/v1/webhooks')
export class PerfectpayWebhookController {
  private readonly logger = new Logger(PerfectpayWebhookController.name);

  constructor(private readonly perfectpayWebhookService: PerfectpayWebhookService) {}

  @Public()
  @Post(['perfectpay', 'perfect-pay'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Perfect Pay webhook endpoint (compra → pending grant)' })
  async perfectpayWebhook(
    @Body() payload: any,
    @Headers() headers: Record<string, string>,
    @Query('token') queryToken?: string,
  ) {
    this.logger.log(
      `Perfectpay webhook received: ${JSON.stringify(payload).slice(0, 500)}`,
    );
    const result = await this.perfectpayWebhookService.handle(
      payload,
      headers,
      queryToken,
    );
    return { received: true, ...result };
  }
}
