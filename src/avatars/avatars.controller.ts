import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Sse,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { Observable, interval, map, merge } from 'rxjs';
import { CurrentUser } from '../common/decorators';
import { AvatarsService } from './avatars.service';
import { AvatarEventsService } from './avatar-events.service';
import { CreateAvatarDto } from './dto/create-avatar.dto';
import { GenerateAvatarVideoDto } from './dto/generate-avatar-video.dto';
import {
  AvatarListResponseDto,
  AvatarResponseDto,
} from './dto/avatar-response.dto';

@ApiTags('avatars')
@ApiBearerAuth()
@Controller('api/v1/avatars')
export class AvatarsController {
  constructor(
    private readonly avatarsService: AvatarsService,
    private readonly avatarEvents: AvatarEventsService,
  ) { }

  @Get()
  @ApiOperation({ summary: 'Lista os avatares do usuário + quota do plano' })
  @ApiResponse({ status: 200, type: AvatarListResponseDto })
  async list(@CurrentUser('sub') userId: string): Promise<AvatarListResponseDto> {
    return this.avatarsService.list(userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalhe de um avatar' })
  @ApiResponse({ status: 200, type: AvatarResponseDto })
  async get(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
  ): Promise<AvatarResponseDto> {
    return this.avatarsService.get(userId, id);
  }

  @SkipThrottle()
  @Sse(':id/events')
  @ApiOperation({
    summary: 'SSE — eventos de status de um avatar específico (PENDING_CONSENT/READY/FAILED).',
  })
  sseAvatar(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
  ): Observable<MessageEvent> {
    const events$ = this.avatarEvents.subscribeToAvatar(userId, id).pipe(
      map((event: any) => ({ data: event } as MessageEvent)),
    );
    const heartbeat$ = interval(20_000).pipe(
      map(() => ({ data: { type: 'heartbeat' } } as unknown as MessageEvent)),
    );
    return merge(events$, heartbeat$);
  }

  @Post()
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({
    summary:
      'Cria um avatar a partir de um vídeo já enviado (purpose=avatar_source). Debita créditos e inicia treinamento na HeyGen.',
  })
  @ApiResponse({ status: 201, type: AvatarResponseDto })
  @ApiResponse({ status: 402, description: 'Créditos insuficientes.' })
  @ApiResponse({ status: 403, description: 'Plano não permite ou quota atingida.' })
  async create(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateAvatarDto,
  ): Promise<AvatarResponseDto> {
    return this.avatarsService.create(userId, dto);
  }

  @Post(':id/generate-video')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({
    summary:
      'Gera um vídeo a partir de um avatar pronto. Cria uma Generation do tipo AVATAR_VIDEO e enfileira na HeyGen.',
  })
  @ApiResponse({ status: 201, description: 'Vídeo enfileirado.' })
  @ApiResponse({ status: 400, description: 'Avatar não está READY ou consent não aprovado.' })
  @ApiResponse({ status: 402, description: 'Créditos insuficientes.' })
  async generateVideo(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
    @Body() dto: GenerateAvatarVideoDto,
  ): Promise<{ generationId: string; status: string; creditsConsumed: number }> {
    return this.avatarsService.generateVideo(userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Soft-delete do avatar. Bloqueado durante treinamento (status SUBMITTING/PENDING_CONSENT/TRAINING).',
  })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 409, description: 'Avatar em treinamento — não pode excluir.' })
  async remove(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
  ): Promise<void> {
    return this.avatarsService.remove(userId, id);
  }
}
