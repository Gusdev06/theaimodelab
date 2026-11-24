import { Body, Controller, Get, HttpCode, HttpStatus, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { CurrentUser } from '../common/decorators';
import { RetencaoService } from './retencao.service';

export class ProactiveMediaDto {
  @IsBoolean()
  optedIn!: boolean;
}

@ApiTags('retencao')
@ApiBearerAuth()
@Controller('api/v1/retencao')
export class RetencaoController {
  constructor(private readonly retencao: RetencaoService) {}

  @Get('me')
  @ApiOperation({ summary: 'Chave "fotos da minha modelo" e a compra do Pack (cartão de fidelidade)' })
  async me(@CurrentUser('sub') userId: string) {
    return this.retencao.status(userId);
  }

  @Put('proactive-media')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liga ou desliga "Receber fotos da minha modelo"' })
  async setProactiveMedia(@CurrentUser('sub') userId: string, @Body() body: ProactiveMediaDto) {
    return this.retencao.setProactiveMedia(userId, body.optedIn);
  }
}
