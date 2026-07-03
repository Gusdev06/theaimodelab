import { ApiProperty } from '@nestjs/swagger';

export class PresignedUrlResponseDto {
  @ApiProperty({ example: 'https://s3.example.com/...' })
  uploadUrl: string;

  @ApiProperty({ example: 'generation_input/550e8400-e29b-41d4-a716-446655440000/photo.jpg' })
  fileKey: string;
}
