import { Body, Controller, Post, UsePipes, ValidationPipe } from '@nestjs/common';
import { PromptEnhancerService } from './prompt-enhancer.service';
import { EnhancePromptDto } from './dto/enhance-prompt.dto';
import { EnhanceInfluencerDto } from './dto/enhance-influencer.dto';
import { UseInterceptors } from '@nestjs/common';
import { ContentSafetyInterceptor } from '../content-safety/content-safety.interceptor';
import { CurrentUser } from '../common/decorators';

// segurança de conteúdo: recusa referência a menor e exige atestado de consentimento nas ferramentas de foto
@UseInterceptors(ContentSafetyInterceptor)
@Controller('api/v1/prompt-enhancer')
export class PromptEnhancerController {
  constructor(private readonly promptEnhancerService: PromptEnhancerService) {}

  @Post('enhance')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async enhance(
    @CurrentUser('sub') userId: string,
    @Body() dto: EnhancePromptDto,
  ) {
    const result = await this.promptEnhancerService.enhance(
      dto.prompt,
      dto.context,
      dto.images,
      userId,
    );
    return {
      enhancedPrompt: result.prompt,
      negativePrompt: result.negativePrompt,
    };
  }

  @Post('enhance-influencer')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async enhanceInfluencer(
    @CurrentUser('sub') userId: string,
    @Body() dto: EnhanceInfluencerDto,
  ) {
    const enhancedPrompt = await this.promptEnhancerService.enhanceInfluencer(
      dto,
      userId,
    );
    return { enhancedPrompt };
  }
}
