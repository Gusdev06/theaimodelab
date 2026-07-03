import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export type CreateAvatarType = 'photo' | 'digital_twin';

export class CreateAvatarDto {
  @ApiProperty({
    description: 'Nome amigável do avatar (visível na galeria)',
    example: 'Meu avatar pessoal',
    minLength: 2,
    maxLength: 60,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(60)
  name: string;

  @ApiPropertyOptional({
    description:
      'Tipo de avatar. "photo" usa uma imagem (rápido, sem consent). "digital_twin" usa vídeo de gravação (requer consent na HeyGen).',
    enum: ['photo', 'digital_twin'],
    default: 'photo',
  })
  @IsOptional()
  @IsIn(['photo', 'digital_twin'])
  type?: CreateAvatarType;

  @ApiProperty({
    description:
      'fileKey da mídia já enviada para o S3 via /uploads/presigned-url (purpose: avatar_source). Imagem (PNG/JPG/WEBP) para photo, vídeo (MP4) para digital_twin.',
    example: 'avatar_source/abc123-uuid/headshot.jpg',
  })
  @IsString()
  @IsNotEmpty()
  sourceMediaKey: string;
}
