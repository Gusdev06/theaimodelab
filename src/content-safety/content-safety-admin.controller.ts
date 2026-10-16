import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { ContentSafetyEventKind } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import {
  CurrentUser,
  JwtPayload,
} from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  ContentSafetyService,
  SAFETY_RELEASE_NOTE_MAX_LENGTH,
  SAFETY_RELEASE_NOTE_MIN_LENGTH,
} from './content-safety.service';

/** Liberação de um bloqueio por menor pelo jurídico: a nota explica por quê e fica na trilha. */
export class ReleaseSafetyEventDto {
  @ApiProperty({
    description:
      'Por que o bloqueio está sendo liberado (falso positivo do filtro ou do provedor, caso encerrado). ' +
      `De ${SAFETY_RELEASE_NOTE_MIN_LENGTH} a ${SAFETY_RELEASE_NOTE_MAX_LENGTH} caracteres.`,
    minLength: SAFETY_RELEASE_NOTE_MIN_LENGTH,
    maxLength: SAFETY_RELEASE_NOTE_MAX_LENGTH,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'note precisa ser texto' })
  @MinLength(SAFETY_RELEASE_NOTE_MIN_LENGTH, {
    message: `note precisa ter pelo menos ${SAFETY_RELEASE_NOTE_MIN_LENGTH} caracteres`,
  })
  @MaxLength(SAFETY_RELEASE_NOTE_MAX_LENGTH, {
    message: `note pode ter no máximo ${SAFETY_RELEASE_NOTE_MAX_LENGTH} caracteres`,
  })
  note: string;
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin/content-safety')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class ContentSafetyAdminController {
  constructor(private readonly safety: ContentSafetyService) {}

  @Get('events')
  @ApiOperation({
    summary:
      'Trilha de segurança de conteúdo: recusas por menor e atestados de consentimento, com a liberação pelo jurídico ' +
      '(releasedAt, releasedBy, releaseNote, released) (admin)',
  })
  async events(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('kind') kind?: string,
  ) {
    if (
      kind &&
      !Object.prototype.hasOwnProperty.call(ContentSafetyEventKind, kind)
    ) {
      throw new BadRequestException('kind inválido');
    }
    return this.safety.listForAdmin(
      page,
      limit,
      kind as ContentSafetyEventKind | undefined,
    );
  }

  @Patch('events/:id/release')
  @UsePipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  )
  @ApiOperation({
    summary:
      'Libera um bloqueio por menor (MINOR_BLOCKED) a pedido do jurídico: o evento fica na trilha, mas deixa de segurar ' +
      'a conta na exclusão LGPD e na exclusão definitiva, e a geração ligada a ele. Exige nota (10 a 1000 caracteres). ' +
      'Repetir não muda nada (alreadyReleased: true). 400 para outro tipo de evento, 404 se não existir (admin)',
  })
  async release(
    @Param('id') id: string,
    @Body() dto: ReleaseSafetyEventDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.safety.releaseMinorBlock(id, dto.note, {
      id: admin.sub,
      email: admin.email,
    });
  }
}
