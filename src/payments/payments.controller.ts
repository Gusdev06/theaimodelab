import {
  Controller,
  Post,
  Req,
  Headers,
  Body,
  HttpCode,
  HttpStatus,
  RawBodyRequest,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../common/decorators';
import { StripeWebhookService } from './webhooks/stripe-webhook.service';
import { MercadoPagoWebhookService } from './webhooks/mercadopago-webhook.service';

@ApiTags('webhooks')
@Controller('api/v1/webhooks')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly stripeWebhookService: StripeWebhookService,
    private readonly mercadoPagoWebhookService: MercadoPagoWebhookService,
  ) {}

  @Public()
  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stripe webhook endpoint' })
  @ApiResponse({ status: 200, description: 'Webhook processed' })
  @ApiResponse({ status: 400, description: 'Invalid payload' })
  async stripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ): Promise<{ received: true }> {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
    await this.stripeWebhookService.handleWebhook(rawBody, signature);
    return { received: true };
  }

  @Public()
  @Post('mercadopago')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'MercadoPago webhook endpoint' })
  @ApiResponse({ status: 200, description: 'Webhook processed' })
  @ApiResponse({ status: 400, description: 'Invalid payload' })
  async mercadoPagoWebhook(
    @Req() req: Request,
    @Headers('x-signature') signature: string,
    @Body() payload: any,
  ): Promise<{ received: true }> {
    // TODO: Implement full MercadoPago HMAC signature verification
    if (!signature) {
      throw new BadRequestException('Missing x-signature header');
    }
    await this.mercadoPagoWebhookService.handleWebhook(payload);
    return { received: true };
  }

}
