import {
  Body,
  Controller,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { PromptAgentService } from './prompt-agent.service';
import { AnalyzeImageDto } from './dto/analyze-image.dto';
import { CurrentUser, JwtPayload } from '../common/decorators';

@Controller('api/v1/prompt-agent')
export class PromptAgentController {
  constructor(private readonly service: PromptAgentService) {}

  @Post('analyze-image')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async analyze(@CurrentUser() user: JwtPayload, @Body() dto: AnalyzeImageDto) {
    return this.service.analyzeImage(user.sub, dto.image);
  }
}
