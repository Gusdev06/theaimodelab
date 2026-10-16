import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ContentReportCategory } from '@prisma/client';

export class CreateReportDto {
  @ApiProperty({ enum: ContentReportCategory, description: 'Motivo da denúncia' })
  @IsEnum(ContentReportCategory)
  category: ContentReportCategory;

  @ApiProperty({ description: 'Link, id da geração ou onde está o conteúdo denunciado' })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  target: string;

  @ApiProperty({ description: 'O que está errado com o conteúdo' })
  @IsString()
  @MinLength(10)
  @MaxLength(4000)
  description: string;

  @ApiPropertyOptional({ description: 'E-mail para retorno (recomendado)' })
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  reporterEmail?: string;

  @ApiPropertyOptional({ description: 'Quem denuncia é a pessoa que aparece no conteúdo' })
  @IsOptional()
  @IsBoolean()
  isDepictedPerson?: boolean;

  /** isca para robô: humano nunca preenche (o campo fica escondido no formulário) */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;
}

export class UpdateReportDto {
  @ApiProperty({ enum: ['OPEN', 'IN_REVIEW', 'ACTIONED', 'DISMISSED'] })
  @IsEnum(['OPEN', 'IN_REVIEW', 'ACTIONED', 'DISMISSED'])
  status: 'OPEN' | 'IN_REVIEW' | 'ACTIONED' | 'DISMISSED';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  adminNote?: string;
}
