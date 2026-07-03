import {
  Controller,
  Get,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { InworldVoicesService, InworldVoice } from './inworld-voices.service';

@ApiTags('Inworld Voices')
@Controller('api/v1/inworld/voices')
export class InworldVoicesController {
  constructor(private readonly service: InworldVoicesService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary:
      'Lista vozes padrão da Inworld. Use ?language=PT_BR (repetível) pra filtrar.',
  })
  async list(
    @Query('language') language?: string | string[],
  ): Promise<{ voices: InworldVoice[] }> {
    const langs = Array.isArray(language)
      ? language
      : language
        ? [language]
        : undefined;
    const voices = await this.service.listVoices(langs);
    return { voices };
  }

  @Public()
  @Get(':voiceId/preview')
  @ApiOperation({
    summary:
      'Áudio de prévia (MP3) de uma voz Inworld. Não bilable na Inworld.',
  })
  async preview(
    @Param('voiceId') voiceId: string,
    @Res() res: Response,
  ): Promise<void> {
    const audio = await this.service.getVoicePreview(voiceId);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(audio.length));
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.send(audio);
  }
}
