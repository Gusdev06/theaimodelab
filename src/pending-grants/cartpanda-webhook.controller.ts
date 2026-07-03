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
import { CartpandaWebhookService } from './cartpanda-webhook.service';

@ApiTags('webhooks')
@Controller('api/v1/webhooks')
export class CartpandaWebhookController {
  private readonly logger = new Logger(CartpandaWebhookController.name);

  constructor(
    private readonly cartpandaWebhookService: CartpandaWebhookService,
  ) {}

  @Public()
  @Post('cartpanda')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cartpanda webhook endpoint (compra → pending grant de créditos)',
  })
  async cartpandaWebhook(
    @Body() payload: any,
    @Headers() headers: Record<string, string>,
    @Query('token') queryToken?: string,
  ) {
    console.log(
      '[CARTPANDA WEBHOOK] headers:',
      JSON.stringify(headers, null, 2),
    );
    console.log(
      '[CARTPANDA WEBHOOK] body:',
      JSON.stringify(payload, null, 2),
    );
    this.logger.log(
      `Cartpanda webhook received: ${JSON.stringify(payload).slice(0, 500)}`,
    );

    const result = await this.cartpandaWebhookService.handle(
      payload,
      headers,
      queryToken,
    );
    return { received: true, ...result };
  }
}
