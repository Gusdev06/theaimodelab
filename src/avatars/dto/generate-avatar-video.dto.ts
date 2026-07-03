import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsHexColor,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export type AvatarVideoResolution = '720p' | '1080p' | '4k';
export type AvatarVideoAspectRatio = '16:9' | '9:16';
export type AvatarVideoEngine = 'avatar_iv' | 'avatar_v';

export class GenerateAvatarVideoDto {
  @ApiPropertyOptional({
    description:
      'Texto que o avatar vai falar (TTS). Obrigatório quando customAudioUrl não é informado.',
    example: 'Oi pessoal, aqui é o seu avatar falando sobre nosso novo produto!',
    maxLength: 3000,
  })
  @IsOptional()
  @ValidateIf((o) => !o.customAudioUrl)
  @IsString()
  @IsNotEmpty()
  @MaxLength(3000)
  script?: string;

  @ApiPropertyOptional({
    description:
      'fileKey (R2) de um áudio enviado pelo usuário via /uploads/presigned-url com purpose "avatar_audio". Mutuamente exclusivo com script/voiceId/voiceProfileId/inworldVoiceId — quando presente, o backend pula a síntese TTS e envia o áudio direto pra HeyGen.',
  })
  @IsOptional()
  @IsString()
  customAudioKey?: string;

  @ApiPropertyOptional({
    description:
      'Duração do áudio enviado em segundos. Usado pra estimar o custo de forma exata quando customAudioUrl está presente. Cap em 600s (10min).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  audioDurationSeconds?: number;

  @ApiPropertyOptional({
    description:
      'Voz HeyGen a usar. Se omitido, usa a voz padrão do avatar (defaultVoiceId). Mutuamente exclusivo com voiceProfileId.',
  })
  @IsOptional()
  @IsString()
  voiceId?: string;

  @ApiPropertyOptional({
    description:
      'ID de uma voz clonada do usuário (VoiceProfile). Quando presente, o backend gera o áudio via Wavespeed/OmniVoice e passa para o HeyGen como audio_url, ignorando voiceId. Lip-sync na foto do avatar.',
  })
  @IsOptional()
  @IsString()
  voiceProfileId?: string;

  @ApiPropertyOptional({
    description:
      'ID de uma voz pública do catálogo Inworld (ex: "Heitor", "Sarah"). Quando presente, o backend gera o áudio via Wavespeed (Inworld TTS) e passa para o HeyGen como audio_url. Mutuamente exclusivo com voiceId e voiceProfileId.',
  })
  @IsOptional()
  @IsString()
  inworldVoiceId?: string;

  @ApiPropertyOptional({
    description:
      'Engine de renderização. Se omitido, usa avatar_iv. avatar_v só funciona em looks que suportam (ver supportedEngines).',
    enum: ['avatar_iv', 'avatar_v'],
  })
  @IsOptional()
  @IsIn(['avatar_iv', 'avatar_v'])
  engine?: AvatarVideoEngine;

  @ApiProperty({
    description: 'Resolução de saída',
    enum: ['720p', '1080p', '4k'],
    default: '1080p',
  })
  @IsIn(['720p', '1080p', '4k'])
  resolution: AvatarVideoResolution;

  @ApiProperty({
    description: 'Proporção de saída',
    enum: ['16:9', '9:16'],
    default: '9:16',
  })
  @IsIn(['16:9', '9:16'])
  aspectRatio: AvatarVideoAspectRatio;

  @ApiPropertyOptional({
    description: 'Cor de fundo em hex (ex: #ffffff). Mutuamente exclusivo com backgroundImageUrl.',
    example: '#ffffff',
  })
  @IsOptional()
  @ValidateIf((o) => !o.backgroundImageUrl)
  @IsHexColor()
  backgroundColor?: string;

  @ApiPropertyOptional({
    description: 'URL pública de imagem de fundo. Mutuamente exclusivo com backgroundColor.',
  })
  @IsOptional()
  @IsString()
  backgroundImageUrl?: string;
}
