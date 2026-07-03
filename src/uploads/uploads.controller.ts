import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { UploadsService } from './uploads.service';
import { PresignedUrlDto } from './dto/presigned-url.dto';
import { PresignedUrlResponseDto } from './dto/presigned-url-response.dto';

@ApiTags('uploads')
@ApiBearerAuth()
@Controller('api/v1/uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('presigned-url')
  @ApiOperation({ summary: 'Gera URL pré-assinada para upload no S3/R2' })
  @ApiResponse({
    status: 201,
    description: 'URL pré-assinada gerada com sucesso',
    type: PresignedUrlResponseDto,
  })
  async generatePresignedUrl(
    @Body() dto: PresignedUrlDto,
  ): Promise<PresignedUrlResponseDto> {
    return this.uploadsService.generatePresignedUrl(dto);
  }
}
