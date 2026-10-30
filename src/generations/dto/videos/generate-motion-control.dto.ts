import { IsString, IsOptional, IsIn, IsBoolean, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class GenerateMotionControlDto {
  @ApiProperty({ description: 'Vídeo de referência em base64' })
  @IsString()
  video: string;

  @ApiPropertyOptional({
    description: 'MIME type do vídeo',
    enum: ['video/mp4', 'video/quicktime', 'video/x-matroska'],
    default: 'video/mp4',
  })
  @IsOptional()
  @IsString()
  @IsIn(['video/mp4', 'video/quicktime', 'video/x-matroska'])
  video_mime_type?: string;

  @ApiProperty({ description: 'Imagem de substituição em base64' })
  @IsString()
  image: string;

  @ApiPropertyOptional({
    description: 'MIME type da imagem',
    enum: ['image/jpeg', 'image/png', 'image/webp'],
    default: 'image/jpeg',
  })
  @IsOptional()
  @IsString()
  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  image_mime_type?: string;

  @ApiPropertyOptional({
    description: 'Resolução do vídeo gerado. Kling: 720p ou 1080p. Wan 2.2 Animate: 480p ou 720p.',
    enum: ['480p', '720p', '1080p'],
    default: '720p',
  })
  @IsOptional()
  @IsString()
  @IsIn(['480p', '720p', '1080p'])
  resolution?: string;

  @ApiPropertyOptional({
    description:
      "Motor. 'kling' (padrão): a pessoa da foto faz o movimento do vídeo (Kling 2.6, com filtro). 'wan-replace': troca a pessoa do vídeo pela da foto, mantendo movimento, cenário, câmera e luz (Wan 2.2 Animate na WaveSpeed). 'wan-animate': a foto ganha o movimento do vídeo (Wan 2.2 Animate). O Wan cobra por segundo do vídeo (mínimo 3 s) e não usa geração grátis.",
    enum: ['kling', 'wan-replace', 'wan-animate'],
    default: 'kling',
  })
  @IsOptional()
  @IsString()
  @IsIn(['kling', 'wan-replace', 'wan-animate'])
  engine?: string;

  @ApiPropertyOptional({
    description: 'Só no Wan: orientação curta (ex.: "mantenha a roupa e o fundo do vídeo"). Até 600 caracteres.',
    example: 'Keep the exact motion, outfit, background and lighting of the video.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(600)
  prompt?: string;

  @ApiPropertyOptional({
    description:
      'Atestado de imagem (ContentSafetyInterceptor): a foto é de uma pessoa gerada por IA ou de um adulto que autorizou o uso da própria imagem. Obrigatório (true) nesta rota; sem ele, 400 CONSENT_REQUIRED.',
  })
  @IsOptional()
  @IsBoolean()
  consent_confirmed?: boolean;
}
