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
import { HublaWebhookService } from './hubla-webhook.service';

@ApiTags('webhooks')
// postback de gateway chega em rajada do mesmo IP (retentativas, Black November): o limite global de 30/min por IP
// recusaria venda paga. A autenticação continua (token/assinatura conferido no serviço).
@SkipThrottle()
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
    @Query('token') queryToken?: string,
  ) {
    // sem despejar headers/body no log: tinham e-mail do comprador e o token (TKT-054)
    this.logger.log('Hubla webhook received');

    const result = await this.hublaWebhookService.handle(payload, headers, queryToken);
    return { received: true, ...result };
  }
}
