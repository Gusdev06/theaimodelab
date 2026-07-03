import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AiModel } from '@prisma/client';
import { ModelsService } from './models.service';
import { AiModelResponseDto } from './dto/ai-model-response.dto';
import { Public } from '../common/decorators/public.decorator';

/**
 * Slugs that are admin-only feature flags (not real generation models). The
 * panels' model dropdowns filter these out using the `isGateway` flag, but the
 * gating components (AvatarsDialog, MotionControlPanel, etc.) still look them
 * up by slug to read the on/off state + statusMessage.
 */
const GATEWAY_SLUGS = new Set(['avatar-video', 'motion-control', 'audio-generation']);

function toDto(m: AiModel): AiModelResponseDto {
  return {
    slug: m.slug,
    label: m.label,
    description: m.description,
    provider: m.provider,
    isActive: m.isActive,
    statusMessage: m.statusMessage,
    sortOrder: m.sortOrder,
    isGateway: GATEWAY_SLUGS.has(m.slug),
  };
}

@ApiTags('models')
@Controller('api/v1/models')
export class ModelsController {
  constructor(private readonly modelsService: ModelsService) {}

  @Public()
  @Get('videos')
  @ApiOperation({ summary: 'Lista modelos de vídeo disponíveis (público)' })
  @ApiResponse({ status: 200, type: [AiModelResponseDto] })
  async listVideos(): Promise<AiModelResponseDto[]> {
    const models = await this.modelsService.listVideoModels();
    return models.map(toDto);
  }

  @Public()
  @Get('images')
  @ApiOperation({ summary: 'Lista modelos de imagem disponíveis (público)' })
  @ApiResponse({ status: 200, type: [AiModelResponseDto] })
  async listImages(): Promise<AiModelResponseDto[]> {
    const models = await this.modelsService.listImageModels();
    return models.map(toDto);
  }

  @Public()
  @Get('audio')
  @ApiOperation({ summary: 'Lista modelos de áudio disponíveis (público)' })
  @ApiResponse({ status: 200, type: [AiModelResponseDto] })
  async listAudio(): Promise<AiModelResponseDto[]> {
    const models = await this.modelsService.listAudioModels();
    return models.map(toDto);
  }
}
