import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';

const MEDIA_UUID = /^[A-Za-z0-9-]{8,64}$/;

export class MiaChatterTierMediaDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @Matches(MEDIA_UUID, { each: true })
  teaser?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @Matches(MEDIA_UUID, { each: true })
  spicy?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @Matches(MEDIA_UUID, { each: true })
  whale?: string[];
}

export class UpdateMiaChatterSettingsDto {
  @ApiPropertyOptional({ description: 'Liga ou pausa a Mia (exige conta conectada, assinatura ativa e rótulo de IA confirmado)' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  personaName?: string;

  @ApiPropertyOptional({ maxLength: 400 })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  personaBio?: string;

  @ApiPropertyOptional({ enum: ['auto', 'pt', 'es', 'en'] })
  @IsOptional()
  @IsIn(['auto', 'pt', 'es', 'en'])
  locale?: string;

  @ApiPropertyOptional({ description: 'O perfil na Fanvue está marcado como IA (obrigatório para ligar)' })
  @IsOptional()
  @IsBoolean()
  aiLabelConfirmed?: boolean;

  @ApiPropertyOptional({ type: MiaChatterTierMediaDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MiaChatterTierMediaDto)
  tierMedia?: MiaChatterTierMediaDto;
}
