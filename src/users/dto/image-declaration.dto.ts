import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';
import { CURRENT_IMAGE_DECLARATION_VERSION, IMAGE_DECLARATION_VERSIONS } from '../image-declaration';

export const IMAGE_DECLARATION_VERSION_MESSAGE =
  `Versão da declaração de imagens desconhecida. Versões aceitas: ${IMAGE_DECLARATION_VERSIONS.join(', ')}.`;

export class ImageDeclarationDto {
  @ApiProperty({
    example: CURRENT_IMAGE_DECLARATION_VERSION,
    enum: IMAGE_DECLARATION_VERSIONS,
    description: 'Versão da declaração que o app mostrou (AAAA-MM-DD).',
  })
  @IsString({ message: IMAGE_DECLARATION_VERSION_MESSAGE })
  @IsIn(IMAGE_DECLARATION_VERSIONS, { message: IMAGE_DECLARATION_VERSION_MESSAGE })
  version: string;
}

export class ImageDeclarationResponseDto {
  @ApiPropertyOptional({
    nullable: true,
    description: 'Quando a conta declarou a responsabilidade pelas imagens. A data é a da primeira vez e nunca muda.',
  })
  imageDeclarationAt: Date | null;

  @ApiPropertyOptional({ nullable: true, description: 'Versão da declaração que ficou gravada (ex: 2026-11-06).' })
  imageDeclarationVersion: string | null;
}
