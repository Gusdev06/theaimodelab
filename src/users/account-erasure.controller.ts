import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  Equals,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  CurrentUser,
  JwtPayload,
} from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  AccountErasureReport,
  AccountErasureService,
  SAFETY_OVERRIDE_REASON_MIN_LENGTH,
  assertSafetyOverride,
} from './account-erasure.service';

export class EraseAccountDto {
  @ApiProperty({
    description:
      'Precisa ser true: confirma que os dados da conta serão apagados de vez',
    example: true,
  })
  @IsBoolean({ message: 'confirm precisa ser true para apagar a conta' })
  @Equals(true, { message: 'confirm precisa ser true para apagar a conta' })
  confirm: boolean;

  @ApiPropertyOptional({
    description:
      'Motivo ou protocolo do pedido (vai para o log da API). Não escreva dado pessoal aqui. Obrigatório, com ' +
      `${SAFETY_OVERRIDE_REASON_MIN_LENGTH}+ caracteres, quando ignoreSafetyEvents for true.`,
    maxLength: 500,
    example: 'Pedido pelo e-mail de privacidade, protocolo 2026-10-16-01',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({
    description:
      'Ignora a guarda legal por tentativas bloqueadas por menor de idade (3+ tentativas distintas em 90 dias, inclusive ' +
      'recusa do provedor em pedido só de texto), que pode vir de engano do filtro. Exige motivo. Nunca libera denúncia nem ' +
      'recusa do provedor por menor numa foto ou vídeo enviado pela conta (essa só sai pela liberação do evento pelo jurídico).',
    example: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'ignoreSafetyEvents precisa ser true ou false' })
  ignoreSafetyEvents?: boolean;
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin/users')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class AccountErasureAdminController {
  constructor(private readonly erasure: AccountErasureService) {}

  @Post(':id/erase')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Exclusão de conta (LGPD): bloqueia o acesso, apaga ou anonimiza dados, gerações e arquivos e desliga a renovação das ' +
      'assinaturas. Guarda pagamentos, créditos, comissões e registros de segurança. Com guarda legal (denúncia de menor, ' +
      'crime ou imagem íntima feita por outra pessoa ou pela própria citando conteúdo dela, recusa do provedor por menor ' +
      'na imagem enviada, ou bloqueios por menor), só bloqueia a conta, tira os posts do ar e o prazo de expiração das ' +
      'gerações, sem apagar nada, até a denúncia ser descartada ou marcada "evidência liberada" em Denúncias. Geração ' +
      'com bloqueio por menor nunca é apagada. Rodar de novo é seguro (admin)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Relatório do que foi apagado, anonimizado, guardado e do que ainda depende de alguém (legalHold.active = só ' +
      'bloqueio; storage.completed = bucket terminou; storage.finalized = limpeza final do banco gravada)',
  })
  @ApiResponse({
    status: 400,
    description:
      'confirm ausente ou diferente de true, campo extra no corpo, ou ignoreSafetyEvents sem motivo de 10+ caracteres',
  })
  @ApiResponse({
    status: 403,
    description: 'Quem pediu não é admin, ou a conta alvo é de admin',
  })
  @ApiResponse({ status: 404, description: 'Usuário não encontrado' })
  @ApiResponse({
    status: 409,
    description: 'Exclusão desta conta já em andamento',
  })
  async erase(
    @Param('id') id: string,
    @Body() dto: EraseAccountDto,
    @CurrentUser() admin: JwtPayload,
  ): Promise<AccountErasureReport> {
    assertSafetyOverride(dto.ignoreSafetyEvents, dto.reason);
    return this.erasure.erase(id, {
      confirm: dto.confirm,
      reason: dto.reason ?? null,
      requestedBy: admin?.email ?? null,
      ...(dto.ignoreSafetyEvents === true ? { ignoreSafetyEvents: true } : {}),
    });
  }
}
