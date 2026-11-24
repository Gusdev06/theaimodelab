import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, Public } from '../common/decorators';
import { UpdateMiaChatterSettingsDto } from './dto/update-mia-chatter-settings.dto';
import { MiaChatterService } from './mia-chatter.service';

/** Mia Chatter (candy-chatter): com MIA_CHATTER_ENABLED off todas as rotas respondem 404. */
@ApiTags('mia-chatter')
@ApiBearerAuth()
@Controller('api/v1/mia-chatter')
export class MiaChatterController {
  constructor(private readonly service: MiaChatterService) {}

  @Get('status')
  @ApiOperation({ summary: 'Estado da Mia Chatter da cliente (conexão, assinatura, números, fãs que mais gastaram)' })
  status(@CurrentUser('sub') userId: string) {
    return this.service.status(userId);
  }

  @Post('connect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Começa o OAuth da Fanvue e devolve a URL de autorização' })
  connect(@CurrentUser('sub') userId: string) {
    return this.service.startConnect(userId);
  }

  @Public()
  @Get('oauth/callback')
  @ApiOperation({ summary: 'Volta do OAuth da Fanvue (redireciona para a aba PPV)' })
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const target = await this.service.handleCallback({ code, state, error });
    res.redirect(302, target);
  }

  @Patch('settings')
  @ApiOperation({ summary: 'Liga/pausa a Mia e ajusta persona, língua, rótulo de IA e mídias por degrau' })
  settings(@CurrentUser('sub') userId: string, @Body() body: UpdateMiaChatterSettingsDto) {
    return this.service.updateSettings(userId, body as unknown as Parameters<MiaChatterService['updateSettings']>[1]);
  }

  @Post('disconnect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Desliga a conta da Fanvue e apaga os tokens' })
  disconnect(@CurrentUser('sub') userId: string) {
    return this.service.disconnect(userId);
  }
}
