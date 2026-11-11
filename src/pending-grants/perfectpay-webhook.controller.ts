import { SkipThrottle } from '@nestjs/throttler';
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
// postback de gateway chega em rajada do mesmo IP (retentativas, Black November): o limite global de 30/min por IP
// recusaria venda paga. A autenticação continua (token/assinatura conferido no serviço).
@SkipThrottle()
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
    // só o que identifica a venda: o corpo traz e-mail, CPF, telefone e o próprio token (a API é repo público e o
    // log fica no servidor). O corpo inteiro, quando passa no token, já vai para webhook_logs.
    this.logger.log(
      `Perfectpay webhook received: venda ${payload?.code ?? payload?.sale_code ?? 'n/a'}, ` +
        `status ${payload?.sale_status_enum_key ?? payload?.sale_status_enum ?? 'n/a'}, ` +
        `produto ${payload?.product?.code ?? 'n/a'}, plano ${payload?.plan?.code ?? 'n/a'}`,
    );
    const result = await this.perfectpayWebhookService.handle(
      payload,
      headers,
      queryToken,
    );
    return { received: true, ...result };
  }
}
