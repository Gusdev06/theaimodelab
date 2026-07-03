import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators';
import { CreateVoiceDto } from './dto/create-voice.dto';
import { RenameVoiceDto } from './dto/rename-voice.dto';
import {
  VoiceListResponseDto,
  VoiceResponseDto,
} from './dto/voice-response.dto';
import { VoicesService } from './voices.service';

@ApiTags('voices')
@ApiBearerAuth()
@Controller('api/v1/voices')
export class VoicesController {
  constructor(private readonly voicesService: VoicesService) {}

  @Get()
  @ApiOperation({ summary: 'Lista as vozes salvas do usuário + quota do plano' })
  @ApiResponse({ status: 200, type: VoiceListResponseDto })
  async list(
    @CurrentUser('sub') userId: string,
  ): Promise<VoiceListResponseDto> {
    return this.voicesService.list(userId);
  }

  @Post()
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({
    summary:
      'Promove uma geração de voice-clone concluída em uma voz salva (com nome).',
  })
  @ApiResponse({ status: 201, type: VoiceResponseDto })
  async create(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateVoiceDto,
  ): Promise<VoiceResponseDto> {
    return this.voicesService.create(userId, dto);
  }

  @Patch(':id')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Renomeia uma voz salva' })
  @ApiResponse({ status: 200, type: VoiceResponseDto })
  async rename(
    @CurrentUser('sub') userId: string,
    @Param('id') voiceId: string,
    @Body() dto: RenameVoiceDto,
  ): Promise<VoiceResponseDto> {
    return this.voicesService.rename(userId, voiceId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove (soft-delete) uma voz salva' })
  @ApiResponse({ status: 204 })
  async remove(
    @CurrentUser('sub') userId: string,
    @Param('id') voiceId: string,
  ): Promise<void> {
    return this.voicesService.remove(userId, voiceId);
  }
}
