import {
  IsString,
  IsOptional,
  IsNumber,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class GenerateTextToSpeechDto {
  @ApiProperty({ description: 'Texto a ser sintetizado em fala', maxLength: 900 })
  @IsString()
  @MaxLength(900)
  text: string;

  @ApiProperty({ description: 'ID da voz padrão a ser usada' })
  @IsString()
  voice_id: string;

  @ApiPropertyOptional({ description: 'Idioma do áudio (ISO ou nome)', example: 'pt' })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({
    description: 'Velocidade da fala (0.5 a 2.0)',
    minimum: 0.5,
    maximum: 2.0,
    default: 1.0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(2.0)
  speed?: number;
}
