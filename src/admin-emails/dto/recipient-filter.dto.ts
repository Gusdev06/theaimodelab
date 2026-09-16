import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EmailBroadcastRecipientType } from '@prisma/client';

export class RecipientFilterDto {
  @ApiPropertyOptional({ description: 'Slug do plano (BY_PLAN)', example: 'pro' })
  @IsOptional()
  @IsString()
  planSlug?: string;

  @ApiPropertyOptional({
    description: 'Lista de emails (CUSTOM_LIST)',
    type: [String],
    example: ['user1@example.com', 'user2@example.com'],
  })
  @IsOptional()
  @IsArray()
  @IsEmail({}, { each: true })
  emails?: string[];

  @ApiPropertyOptional({
    description: 'Email único (SINGLE)',
    example: 'user@example.com',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ description: "ALL: idioma dos destinatários — casa pelo prefixo ('en' = en-US, 'pt' = pt-BR, 'es' = es-ES)", example: 'pt-BR' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z]{2}(-[a-zA-Z]{2})?$/, { message: 'locale deve ser xx ou xx-YY' })
  locale?: string;

  @ApiPropertyOptional({ description: 'ALL: inclui usuários sem e-mail verificado', default: false })
  @IsOptional()
  @IsBoolean()
  includeUnverified?: boolean;
}

export class RecipientSelectionDto {
  @ApiProperty({
    enum: EmailBroadcastRecipientType,
    description: 'Tipo de destinatário',
  })
  @IsEnum(EmailBroadcastRecipientType)
  recipientType: EmailBroadcastRecipientType;

  @ApiPropertyOptional({ type: RecipientFilterDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => RecipientFilterDto)
  recipientFilter?: RecipientFilterDto;
}
