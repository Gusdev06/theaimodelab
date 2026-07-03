import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AffiliatesService } from './affiliates.service';
import { UpdatePixKeyDto } from './dto/update-pix-key.dto';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';

@ApiTags('affiliates')
@ApiBearerAuth()
@Controller('api/v1/affiliates')
export class AffiliateMeController {
  constructor(private readonly affiliatesService: AffiliatesService) {}

  @Get('me')
  @ApiOperation({ summary: 'Painel do afiliado logado' })
  async getMyAffiliate(@CurrentUser() user: JwtPayload) {
    return this.affiliatesService.getMyAffiliate(user.sub);
  }

  @Post('me')
  @ApiOperation({ summary: 'Criar link de afiliado para o usuário logado' })
  async createMyAffiliate(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdatePixKeyDto,
  ) {
    return this.affiliatesService.createForUser(user.sub, dto);
  }

  @Patch('me/pix-key')
  @ApiOperation({ summary: 'Atualizar chave Pix do afiliado logado' })
  async updateMyPixKey(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdatePixKeyDto,
  ) {
    return this.affiliatesService.updateMyPixKey(user.sub, dto);
  }
}
