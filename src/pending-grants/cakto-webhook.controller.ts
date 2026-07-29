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
import { CaktoWebhookService } from './cakto-webhook.service';

@ApiTags('webhooks')
@Controller('api/v1/webhooks')
export class CaktoWebhookController {
  private readonly logger = new Logger(CaktoWebhookController.name);

  constructor(private readonly caktoWebhookService: CaktoWebhookService) {}

  @Public()
  @Post('cakto')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cakto webhook endpoint (assinatura BRL → ativa/renova/revoga)' })
  async caktoWebhook(
    @Body() payload: any,
    @Headers() headers: Record<string, string>,
    @Query('secret') querySecret?: string,
  ) {
    this.logger.log(
      `Cakto webhook received: ${JSON.stringify(payload).slice(0, 4000)}`,
    );
    const result = await this.caktoWebhookService.handle(
      payload,
      headers,
      querySecret,
    );
    return { received: true, ...result };
  }
}
