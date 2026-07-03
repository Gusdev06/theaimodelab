import { IsString, IsOptional, IsIn, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const ALLOWED_AUDIO_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
];

export class GenerateVoiceCloneDto {
  @ApiProperty({
    description: 'Texto a ser sintetizado com a voz clonada',
    maxLength: 900,
  })
  @IsString()
  @MaxLength(900)
  text: string;

  @ApiProperty({
    description: 'Áudio de referência para clonagem (base64, sem prefixo data:)',
  })
  @IsString()
  audio: string;

  @ApiPropertyOptional({
    description: 'MIME type do áudio de referência',
    enum: ALLOWED_AUDIO_MIME_TYPES,
    default: 'audio/mpeg',
  })
  @IsOptional()
  @IsString()
  @IsIn(ALLOWED_AUDIO_MIME_TYPES)
  audio_mime_type?: string;

  @ApiPropertyOptional({ description: 'Idioma do áudio gerado', example: 'pt' })
  @IsOptional()
  @IsString()
  language?: string;
}
