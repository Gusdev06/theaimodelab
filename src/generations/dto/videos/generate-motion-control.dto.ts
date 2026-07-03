import { IsString, IsOptional, IsIn } from 'class-validator';
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
    description: 'Resolução do vídeo gerado',
    enum: ['720p', '1080p'],
    default: '720p',
  })
  @IsOptional()
  @IsString()
  @IsIn(['720p', '1080p'])
  resolution?: string;
}
