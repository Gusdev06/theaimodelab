import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../common/decorators';
import { ResendWebhooksService } from './resend-webhooks.service';

@ApiTags('webhooks')
@Controller('api/v1/webhooks')
export class ResendWebhooksController {
  constructor(private readonly resendWebhooks: ResendWebhooksService) {}

  @Public()
  @Post('resend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Webhook Resend (delivered/opened/clicked/bounced/complained)' })
  @ApiResponse({ status: 200, description: 'Webhook processed' })
  @ApiResponse({ status: 400, description: 'Invalid signature' })
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('svix-id') svixId: string,
    @Headers('svix-timestamp') svixTimestamp: string,
    @Headers('svix-signature') svixSignature: string,
  ): Promise<{ received: true }> {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body));

    const event = this.resendWebhooks.verify(rawBody, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    });

    // Responde 200 imediato e processa em background pra não exceder timeout do Svix.
    // Erros são logados em WebhookLog, sem reentrega (idempotência já tratada).
    void this.resendWebhooks.handleEvent(event);

    return { received: true };
  }
}
