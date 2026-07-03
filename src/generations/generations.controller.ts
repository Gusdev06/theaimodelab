import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UsePipes,
  ValidationPipe,
  Sse,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Observable, map, merge, interval } from 'rxjs';
import { GenerationsService } from './generations.service';
import { GenerationEventsService } from './generation-events.service';
import { CurrentUser } from '../common/decorators';
import { GenerationFiltersDto } from './dto/generation-filters.dto';
import {
  GenerationResponseDto,
  CreateGenerationResponseDto,
} from './dto/generation-response.dto';
import { FolderResponseDto } from '../folders/dto/folder-response.dto';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { GenerateImageDto } from './dto/generate-image.dto';
import { UpscaleImageDto } from './dto/upscale-image.dto';
import { GenerateImageNanoBananaDto } from './dto/generate-image-nano-banana.dto';
import { GenerateVideoTextToVideoDto } from './dto/videos/generate-video-text-to-video.dto';
import { GenerateVideoImageToVideoDto } from './dto/videos/generate-video-image-to-video.dto';
import { GenerateVideoWithReferencesDto } from './dto/videos/generate-video-with-references.dto';
import { GenerateMotionControlDto } from './dto/videos/generate-motion-control.dto';
import { GenerateVirtualTryOnDto } from './dto/generate-virtual-try-on.dto';
import { GenerateFaceSwapDto } from './dto/generate-face-swap.dto';
import { GenerateVeoKieTextToVideoDto } from './dto/videos/generate-veo-kie-text-to-video.dto';
import { GenerateVeoKieImageToVideoDto } from './dto/videos/generate-veo-kie-image-to-video.dto';
import { GenerateVeoKieReferenceToVideoDto } from './dto/videos/generate-veo-kie-reference-to-video.dto';
import { GenerateGrokImagineImageToVideoDto } from './dto/videos/generate-grok-imagine-image-to-video.dto';
import { GenerateGrokImagineTextToVideoDto } from './dto/videos/generate-grok-imagine-text-to-video.dto';
import { GenerateGeminiOmniVideoDto } from './dto/videos/generate-gemini-omni-video.dto';
import { GenerateSeedanceVideoDto } from './dto/videos/generate-seedance-video.dto';
import { GenerateTextToSpeechDto } from './dto/generate-text-to-speech.dto';
import { GenerateVoiceCloneDto } from './dto/generate-voice-clone.dto';
import { UnlimitedStatusResponseDto } from './dto/unlimited-status.dto';

@ApiTags('generations')
@ApiBearerAuth()
@Controller('api/v1/generations')
export class GenerationsController {
  constructor(
    private readonly generationsService: GenerationsService,
    private readonly generationEvents: GenerationEventsService,
  ) {}

  @SkipThrottle()
  @Sse('events')
  @ApiOperation({ summary: 'SSE — recebe eventos de todas as gerações do usuário em tempo real' })
  sseAll(@CurrentUser('sub') userId: string): Observable<MessageEvent> {
    const events$ = this.generationEvents.subscribe(userId).pipe(
      map((event: any) => ({ data: event } as MessageEvent)),
    );
    const heartbeat$ = interval(20_000).pipe(
      map(() => ({ data: { type: 'heartbeat' } } as unknown as MessageEvent)),
    );
    return merge(events$, heartbeat$);
  }

  @SkipThrottle()
  @Sse(':id/events')
  @ApiOperation({ summary: 'SSE — recebe eventos de uma geração específica em tempo real' })
  @ApiParam({ name: 'id', description: 'ID da geração' })
  sseOne(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
  ): Observable<MessageEvent> {
    const events$ = this.generationEvents.subscribeToGeneration(userId, id).pipe(
      map((event: any) => ({ data: event } as MessageEvent)),
    );
    const heartbeat$ = interval(20_000).pipe(
      map(() => ({ data: { type: 'heartbeat' } } as unknown as MessageEvent)),
    );
    return merge(events$, heartbeat$);
  }

  @Post('generate-image')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Gera imagem (text-to-image ou image-to-image)' })
  @ApiResponse({ status: 201, type: CreateGenerationResponseDto })
  async generateImage(
    @CurrentUser('sub') userId: string,
    @Body() dto: GenerateImageDto,
  ): Promise<CreateGenerationResponseDto> {
    return this.generationsService.generateImage(userId, dto);
  }

  @Post('generate-image-auto')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({
    summary:
      'Gera imagem tentando The AI Model Lab (Gemini) primeiro; se falhar, usa Nano Banana 2 como fallback',
  })
  @ApiResponse({ status: 201, type: CreateGenerationResponseDto })
  async generateImageWithFallback(
    @CurrentUser('sub') userId: string,
    @Body() dto: GenerateImageDto,
  ): Promise<CreateGenerationResponseDto> {
    return this.generationsService.generateImageWithFallback(userId, dto);
  }

  @Post('upscale')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({
    summary:
      'Upscale — restaura/aumenta a qualidade da imagem (resolução fixa em 2K)',
  })
  @ApiResponse({ status: 201, type: CreateGenerationResponseDto })
  async upscale(
    @CurrentUser('sub') userId: string,
    @Body() dto: UpscaleImageDto,
  ): Promise<CreateGenerationResponseDto> {
    return this.generationsService.generateUpscale(userId, dto);
  }

  @Post('generate-image-nano-banana')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Gera imagem via Nano Banana 2 (kie-api) — text-to-image ou image-to-image' })
  @ApiResponse({ status: 201, type: CreateGenerationResponseDto })
  async generateImageNanoBanana(
    @CurrentUser('sub') userId: string,
    @Body() dto: GenerateImageNanoBananaDto,
  ): Promise<CreateGenerationResponseDto> {
    return this.generationsService.generateImageNanoBanana(userId, dto);
  }

  @Post('text-to-video')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Gera vídeo a partir de texto' })
  @ApiResponse({ status: 201, type: CreateGenerationResponseDto })
  async textToVideo(
    @CurrentUser('sub') userId: string,
    @Body() dto: GenerateVideoTextToVideoDto,
  ): Promise<CreateGenerationResponseDto> {
    return this.generationsService.generateTextToVideo(userId, dto);
  }

  @Post('image-to-video')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Gera vídeo a partir de imagem' })
  @ApiResponse({ status: 201, type: CreateGenerationResponseDto })
  async imageToVideo(
    @CurrentUser('sub') userId: string,
    @Body() dto: GenerateVideoImageToVideoDto,
  ): Promise<CreateGenerationResponseDto> {
    return this.generationsService.generateImageToVideo(userId, dto);
  }

  @Post('video-with-references')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Gera vídeo com imagens de referência' })
  @ApiResponse({ status: 201, type: CreateGenerationResponseDto })
  async videoWithReferences(
    @CurrentUser('sub') userId: string,
    @Body() dto: GenerateVideoWithReferencesDto,
  ): Promise<CreateGenerationResponseDto> {
    return this.generationsService.generateVideoWithReferences(userId, dto);
  }

  @Post('motion-control')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Motion Control — Wan Animate Replace (vídeo + imagem → vídeo)' })
  @ApiResponse({ status: 201, type: CreateGenerationResponseDto })
  async motionControl(
    @CurrentUser('sub') userId: string,
    @Body() dto: GenerateMotionControlDto,
  ): Promise<CreateGenerationResponseDto> {
    return this.generationsService.generateMotionControl(userId, dto);
  }

  @Post('virtual-try-on')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({
    summary: 'Provador Virtual — veste a roupa na influencer de IA',
  })
  @ApiResponse({ status: 201, type: CreateGenerationResponseDto })
  async virtualTryOn(
    @CurrentUser('sub') userId: string,
    @Body() dto: GenerateVirtualTryOnDto,
  ): Promise<CreateGenerationResponseDto> {
    return this.generationsService.generateVirtualTryOn(userId, dto);
  }

  @Post('face-swap')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({
    summary: 'Face Swap — substitui o rosto/corpo na cena usando IA',
  })
  @ApiResponse({ status: 201, type: CreateGenerationResponseDto })
  async faceSwap(
    @CurrentUser('sub') userId: string,
    @Body() dto: GenerateFaceSwapDto,
  ): Promise<CreateGenerationResponseDto> {
    return this.generationsService.generateFaceSwap(userId, dto);
  }

  @Post('text-to-video-kie')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Gera vídeo a partir de texto via Kie Veo API — modo TEXT_2_VIDEO (veo3, veo3_fast)' })
  @ApiResponse({ status: 201, type: CreateGenerationResponseDto })
  async textToVideoKie(
    @CurrentUser('sub') userId: string,
    @Body() dto: GenerateVeoKieTextToVideoDto,
  ): Promise<CreateGenerationResponseDto> {
    return this.generationsService.generateTextToVideoKie(userId, dto);
  }

  @Post('image-to-video-kie')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Gera vídeo a partir de imagem via Kie Veo API — modo FIRST_AND_LAST_FRAMES_2_VIDEO (veo3, veo3_fast)' })
  @ApiResponse({ status: 201, type: CreateGenerationResponseDto })
  async imageToVideoKie(
    @CurrentUser('sub') userId: string,
    @Body() dto: GenerateVeoKieImageToVideoDto,
  ): Promise<CreateGenerationResponseDto> {
    return this.generationsService.generateImageToVideoKie(userId, dto);
  }

  @Post('reference-to-video-kie')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Gera vídeo a partir de imagens de referência via Kie Veo API — modo REFERENCE_2_VIDEO (veo3_fast only, 1-3 imagens)' })
  @ApiResponse({ status: 201, type: CreateGenerationResponseDto })
  async referenceToVideoKie(
    @CurrentUser('sub') userId: string,
    @Body() dto: GenerateVeoKieReferenceToVideoDto,
  ): Promise<CreateGenerationResponseDto> {
    return this.generationsService.generateReferenceToVideoKie(userId, dto);
  }

  @Post('image-to-video-grok')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Gera vídeo a partir de imagem via Grok Imagine (Kie) — 480p/720p, duração 6-30s' })
  @ApiResponse({ status: 201, type: CreateGenerationResponseDto })
  async imageToVideoGrok(
    @CurrentUser('sub') userId: string,
    @Body() dto: GenerateGrokImagineImageToVideoDto,
  ): Promise<CreateGenerationResponseDto> {
    return this.generationsService.generateImageToVideoGrokImagine(userId, dto);
  }

  @Post('text-to-video-grok')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Gera vídeo a partir de texto via Grok Imagine (Kie) — 480p/720p, duração 6-30s' })
  @ApiResponse({ status: 201, type: CreateGenerationResponseDto })
  async textToVideoGrok(
    @CurrentUser('sub') userId: string,
    @Body() dto: GenerateGrokImagineTextToVideoDto,
  ): Promise<CreateGenerationResponseDto> {
    return this.generationsService.generateTextToVideoGrokImagine(userId, dto);
  }

  @Post('omni-video')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({
    summary:
      'Gera vídeo multimodal via Gemini Omni (Kie) — texto + imagens (até 7) + vídeo opcional. 720p/1080p/4K, duração 4/6/8/10s',
  })
  @ApiResponse({ status: 201, type: CreateGenerationResponseDto })
  async omniVideo(
    @CurrentUser('sub') userId: string,
    @Body() dto: GenerateGeminiOmniVideoDto,
  ): Promise<CreateGenerationResponseDto> {
    return this.generationsService.generateGeminiOmniVideo(userId, dto);
  }

  @Post('seedance-video')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({
    summary:
      'Gera vídeo via Bytedance Seedance 2.0 (Kie) — 480p/720p/1080p, duração 4-15s, image-to-video ou multimodal-reference',
  })
  @ApiResponse({ status: 201, type: CreateGenerationResponseDto })
  async seedanceVideo(
    @CurrentUser('sub') userId: string,
    @Body() dto: GenerateSeedanceVideoDto,
  ): Promise<CreateGenerationResponseDto> {
    return this.generationsService.generateSeedanceVideo(userId, dto);
  }

  @Post('text-to-speech')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Gera áudio TTS via WaveSpeed OmniVoice (vozes padrão)' })
  @ApiResponse({ status: 201, type: CreateGenerationResponseDto })
  async textToSpeech(
    @CurrentUser('sub') userId: string,
    @Body() dto: GenerateTextToSpeechDto,
  ): Promise<CreateGenerationResponseDto> {
    return this.generationsService.generateTextToSpeech(userId, dto);
  }

  @Post('voice-clone')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({
    summary: 'Clona voz via WaveSpeed OmniVoice — gera áudio com voz de referência',
  })
  @ApiResponse({ status: 201, type: CreateGenerationResponseDto })
  async voiceClone(
    @CurrentUser('sub') userId: string,
    @Body() dto: GenerateVoiceCloneDto,
  ): Promise<CreateGenerationResponseDto> {
    return this.generationsService.generateVoiceClone(userId, dto);
  }

  @Get('unlimited/status')
  @ApiOperation({
    summary:
      'Status do modo ilimitado do usuário (elegibilidade, modelos liberados, uso 24h, lock ativo).',
  })
  @ApiResponse({ status: 200, type: UnlimitedStatusResponseDto })
  async getUnlimitedStatus(
    @CurrentUser('sub') userId: string,
  ): Promise<UnlimitedStatusResponseDto> {
    return this.generationsService.getUnlimitedStatus(userId);
  }

  @Get()
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Lista gerações do usuário (paginado, com filtros)' })
  @ApiResponse({ status: 200 })
  async findAll(
    @CurrentUser('sub') userId: string,
    @Query() filters: GenerationFiltersDto,
  ): Promise<PaginatedResponseDto<GenerationResponseDto>> {
    return this.generationsService.findAll(userId, filters);
  }

  @SkipThrottle()
  @Get(':id')
  @ApiOperation({ summary: 'Status e detalhes de uma geração' })
  @ApiResponse({ status: 200, type: GenerationResponseDto })
  @ApiParam({ name: 'id', description: 'ID da geração' })
  async findById(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
  ): Promise<GenerationResponseDto> {
    return this.generationsService.findById(userId, id);
  }

  @Get(':id/folders')
  @ApiOperation({ summary: 'Lista as pastas em que uma geração está' })
  @ApiResponse({ status: 200, type: [FolderResponseDto] })
  @ApiParam({ name: 'id', description: 'ID da geração' })
  async findFolders(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
  ): Promise<FolderResponseDto[]> {
    return this.generationsService.findFolders(userId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete — remove da galeria' })
  @ApiResponse({ status: 204, description: 'Geração removida com sucesso' })
  @ApiParam({ name: 'id', description: 'ID da geração' })
  async softDelete(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
  ): Promise<void> {
    return this.generationsService.softDelete(userId, id);
  }

  @Delete(':id/outputs/:outputId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Deleta um output específico de uma geração' })
  @ApiResponse({ status: 204, description: 'Output removido com sucesso' })
  @ApiParam({ name: 'id', description: 'ID da geração' })
  @ApiParam({ name: 'outputId', description: 'ID do output' })
  async deleteOutput(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
    @Param('outputId') outputId: string,
  ): Promise<void> {
    return this.generationsService.deleteOutput(userId, id, outputId);
  }

  @Post(':id/favorite')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Marca geração como favorita' })
  @ApiResponse({ status: 204, description: 'Marcado como favorito' })
  @ApiParam({ name: 'id', description: 'ID da geração' })
  async addFavorite(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
  ): Promise<void> {
    return this.generationsService.toggleFavorite(userId, id, true);
  }

  @Delete(':id/favorite')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove geração dos favoritos' })
  @ApiResponse({ status: 204, description: 'Removido dos favoritos' })
  @ApiParam({ name: 'id', description: 'ID da geração' })
  async removeFavorite(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
  ): Promise<void> {
    return this.generationsService.toggleFavorite(userId, id, false);
  }
}
