import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TALKING_AVATAR_MAX_CHARS } from '../talking-avatar.constants';

/**
 * Avatar falante (OmniHuman 1.5): a pessoa da foto diz o texto, com voz do TTS da plataforma e boca sincronizada.
 * Rota POST /generations/talking-avatar. Exige o atestado de imagem (ContentSafetyInterceptor, regra 'always').
 */
export class GenerateTalkingAvatarDto {
  @ApiProperty({ description: 'Foto da pessoa (retrato de frente, boa luz) em base64' })
  @IsString()
  image: string;

  @ApiPropertyOptional({ description: 'MIME type da foto', enum: ['image/jpeg', 'image/png', 'image/webp'], default: 'image/jpeg' })
  @IsOptional()
  @IsString()
  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  image_mime_type?: string;

  @ApiProperty({ description: 'O que a pessoa diz (vira voz e boca sincronizada)', maxLength: TALKING_AVATAR_MAX_CHARS })
  @IsString()
  @MinLength(2)
  @MaxLength(TALKING_AVATAR_MAX_CHARS)
  text: string;

  @ApiPropertyOptional({ description: 'Voz do TTS (`inworld:<voz>` ou `clone:<id>`); sem ela, a voz padrão do idioma' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  voice_id?: string;

  @ApiPropertyOptional({ description: 'Idioma da fala', enum: ['pt', 'en', 'es'], default: 'pt' })
  @IsOptional()
  @IsString()
  @IsIn(['pt', 'en', 'es'])
  language?: string;

  @ApiPropertyOptional({ description: 'Velocidade da fala (0.5 a 2.0)', minimum: 0.5, maximum: 2.0, default: 1.0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(2.0)
  speed?: number;

  @ApiPropertyOptional({ description: 'Proporção do vídeo (a do retrato enviado quando omitida)', enum: ['9:16', '1:1', '16:9'] })
  @IsOptional()
  @IsString()
  @IsIn(['9:16', '1:1', '16:9'])
  aspect_ratio?: string;

  @ApiPropertyOptional({
    description:
      'Atestado obrigatório (ContentSafetyInterceptor): a pessoa da foto é gerada por IA ou um adulto que autorizou o uso da própria imagem. Sem true, o pedido é recusado (CONSENT_REQUIRED).',
  })
  @IsOptional()
  @IsBoolean()
  consent_confirmed?: boolean;
}

export class TalkingAvatarAccessResponseDto {
  @ApiProperty({ description: 'Se a conta pode gerar avatar falante no plano atual' })
  allowed: boolean;

  @ApiProperty({ description: 'Slug do plano ativo (null sem assinatura)', nullable: true })
  planSlug: string | null;

  @ApiProperty({ description: 'Slugs dos planos liberados (TALKING_AVATAR_PLANS; padrão studio e agency)', type: [String] })
  plans: string[];
}
