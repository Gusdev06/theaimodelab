import { Body, Controller, Post, UsePipes, ValidationPipe } from '@nestjs/common';
import { PromptEnhancerService } from './prompt-enhancer.service';
import { EnhancePromptDto } from './dto/enhance-prompt.dto';
import { EnhanceInfluencerDto } from './dto/enhance-influencer.dto';

@Controller('api/v1/prompt-enhancer')
export class PromptEnhancerController {
  constructor(private readonly promptEnhancerService: PromptEnhancerService) {}

  @Post('enhance')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async enhance(@Body() dto: EnhancePromptDto) {
    const result = await this.promptEnhancerService.enhance(
      dto.prompt,
      dto.context,
      dto.images,
    );
    return {
      enhancedPrompt: result.prompt,
      negativePrompt: result.negativePrompt,
    };
  }

  @Post('enhance-influencer')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async enhanceInfluencer(@Body() dto: EnhanceInfluencerDto) {
    const enhancedPrompt =
      await this.promptEnhancerService.enhanceInfluencer(dto);
    return { enhancedPrompt };
  }
}
