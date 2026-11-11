import { IsString, IsOptional, IsIn, IsBoolean, MaxLength, IsArray, ArrayMaxSize } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WAN3_REFERENCE_MAX_EXTRA_IMAGES, WAN3_REFERENCE_PROMPT_MAX_LENGTH } from '../../motion-control-engine';

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
    description:
      "Só no 'wan3-reference': fotos das outras pessoas da cena, em base64 (até 2). Viram 'Image 2' e 'Image 3', na ordem. É o casal e o trio dos templates do Genspicy.",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(WAN3_REFERENCE_MAX_EXTRA_IMAGES)
  @IsString({ each: true })
  extra_images?: string[];

  @ApiPropertyOptional({
    description: 'MIME type de cada foto de `extra_images`, na mesma ordem (padrão image/jpeg).',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(WAN3_REFERENCE_MAX_EXTRA_IMAGES)
  @IsIn(['image/jpeg', 'image/png', 'image/webp'], { each: true })
  extra_image_mime_types?: string[];

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
      "Motor. 'kling' (padrão): a pessoa da foto faz o movimento do vídeo (Kling 2.6, com filtro). 'wan-replace': troca a pessoa do vídeo pela da foto, mantendo movimento, cenário, câmera e luz (Wan 2.2 Animate na WaveSpeed). 'wan-animate': a foto ganha o movimento do vídeo (Wan 2.2 Animate). 'wan3-reference': gera a cena do vídeo de novo com a pessoa da foto (Wan 3.0 reference-to-video, 'Image 1' = quem, 'Video 1' = cena; cobra referência + saída). Os Wan cobram por segundo e não usam geração grátis.",
    enum: ['kling', 'wan-replace', 'wan-animate', 'wan3-reference'],
    default: 'kling',
  })
  @IsOptional()
  @IsString()
  @IsIn(['kling', 'wan-replace', 'wan-animate', 'wan3-reference'])
  engine?: string;

  @ApiPropertyOptional({
    description:
      'Só no Wan: orientação curta (ex.: "mantenha a roupa e o fundo do vídeo"). Wan 2.2: até 600 caracteres (o resto é cortado); Wan 3.0: até 1.500 (o papel de cada pessoa da cena).',
    example: 'Keep the exact motion, outfit, background and lighting of the video.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(WAN3_REFERENCE_PROMPT_MAX_LENGTH)
  prompt?: string;

  @ApiPropertyOptional({
    description:
      'Atestado de imagem (ContentSafetyInterceptor): a foto é de uma pessoa gerada por IA ou de um adulto que autorizou o uso da própria imagem. Obrigatório (true) nesta rota; sem ele, 400 CONSENT_REQUIRED.',
  })
  @IsOptional()
  @IsBoolean()
  consent_confirmed?: boolean;
}
