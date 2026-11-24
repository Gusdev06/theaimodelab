import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public } from '../common/decorators';
import { WebPushService, type PushSubscriptionInput } from './web-push.service';

@ApiTags('push')
@Controller('api/v1/push')
export class WebPushController {
  constructor(private readonly webPush: WebPushService) {}

  /** Chave pública VAPID; enabled:false = o site não mostra o convite (L16). */
  @Public()
  @Get('config')
  @ApiOperation({ summary: 'Configuração pública do Web Push (chave VAPID)' })
  config() {
    return this.webPush.publicConfig();
  }

  @ApiBearerAuth()
  @Post('subscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Inscreve este navegador para receber os avisos do sino por push' })
  async subscribe(@CurrentUser('sub') userId: string, @Body() body: PushSubscriptionInput) {
    const result = await this.webPush.subscribe(userId, body);
    if (!result.ok && result.reason === 'invalid') throw new BadRequestException('Inscrição de push inválida');
    return { enabled: result.ok };
  }

  @ApiBearerAuth()
  @Post('unsubscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a inscrição de push deste navegador' })
  async unsubscribe(@CurrentUser('sub') userId: string, @Body() body: { endpoint?: unknown }) {
    return this.webPush.unsubscribe(userId, body?.endpoint);
  }
}
