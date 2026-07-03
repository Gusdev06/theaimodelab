import { IsEnum, IsOptional, IsInt, IsBoolean, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FreeGenerationType, GenerationType, Resolution } from '@prisma/client';

export class EstimateCostDto {
  @ApiProperty({ enum: GenerationType })
  @IsEnum(GenerationType)
  type: GenerationType;

  @ApiProperty({ enum: Resolution })
  @IsEnum(Resolution)
  resolution: Resolution;

  @ApiPropertyOptional({ description: 'Duration in seconds (for video types)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  durationSeconds?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  hasAudio?: boolean;

  @ApiPropertyOptional({ description: 'Number of samples to generate', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sampleCount?: number;

  @ApiPropertyOptional({ description: 'Model variant (e.g. NB2, NBP, VEO_FAST, VEO_MAX)' })
  @IsOptional()
  @IsString()
  modelVariant?: string;

  @ApiPropertyOptional({
    description: 'Indica se a geração inclui um vídeo de input (afeta pricing do Gemini Omni)',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  hasVideoInput?: boolean;

  @ApiPropertyOptional({
    enum: FreeGenerationType,
    description: 'Override do tipo de geração grátis (opcional, normalmente derivado de type + modelVariant)',
  })
  @IsOptional()
  @IsEnum(FreeGenerationType)
  freeGenerationType?: FreeGenerationType;
}

export class EstimateCostResponseDto {
  @ApiProperty()
  creditsRequired: number;

  @ApiProperty()
  hasSufficientBalance: boolean;

  @ApiProperty({ description: 'Se o usuário tem uma geração grátis compatível com este request' })
  canUseFreeGeneration: boolean;

  @ApiPropertyOptional({
    enum: FreeGenerationType,
    description: 'Tipo de geração grátis que seria consumida (se canUseFreeGeneration=true)',
  })
  freeGenerationType: FreeGenerationType | null;

  @ApiProperty({ description: 'Quantas gerações grátis deste tipo o usuário tem' })
  freeGenerationsRemainingForType: number;
}
