import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class AdminUploadDto {
  @ApiProperty({ example: 'hero-image.jpg' })
  @IsString()
  @IsNotEmpty()
  filename: string;

  @ApiProperty({ example: 'image/jpeg' })
  @IsString()
  @IsNotEmpty()
  contentType: string;

  @ApiProperty({
    example: 'landing',
    description: 'Subpasta dentro de admin_assets (ex: landing, gallery, testimonials)',
  })
  @IsString()
  @IsNotEmpty()
  folder: string;
}
