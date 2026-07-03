import {
  IsArray,
  IsEmail,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
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
