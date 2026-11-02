import { Body, Controller, Post, UsePipes, ValidationPipe } from '@nestjs/common';
import { PromptEnhancerService } from './prompt-enhancer.service';
import { EnhancePromptDto } from './dto/enhance-prompt.dto';
import { EnhanceInfluencerDto } from './dto/enhance-influencer.dto';
import { UseInterceptors } from '@nestjs/common';
import { ContentSafetyInterceptor, isUncensoredModel } from '../content-safety/content-safety.interceptor';
import { AdultPromptEnhancerService } from './adult/adult-prompt-enhancer.service';

// segurança de conteúdo: recusa referência a menor e exige atestado de consentimento nas ferramentas de foto
@UseInterceptors(ContentSafetyInterceptor)
@Controller('api/v1/prompt-enhancer')
export class PromptEnhancerController {
  constructor(
    private readonly promptEnhancerService: PromptEnhancerService,
    private readonly adultEnhancer: AdultPromptEnhancerService,
  ) {}

  @Post('enhance')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async enhance(@Body() dto: EnhancePromptDto) {
    // modelo sem filtro (Unlocked, Spicy...): o melhorador de sempre recusa cena sensível e devolve outra cena sem
    // avisar; o melhorador 18+ mantém o pedido e só melhora a técnica (identidade, idade adulta, realismo, câmera)
    if (dto.context && isUncensoredModel(dto.context.model) && this.adultEnhancer.enabled()) {
      const adult = await this.adultEnhancer.enhance(dto.prompt, {
        type: dto.context.type,
        model: dto.context.model,
        hasReferenceImages: Boolean(dto.context.hasReferenceImages || dto.images?.length),
        referenceCount: dto.images?.length || (dto.context.hasReferenceImages ? 1 : 0),
        aspectRatio: dto.context.aspectRatio,
        durationSeconds: dto.context.durationSeconds,
        locale: dto.context.locale,
      });
      return {
        enhancedPrompt: adult.enhancedPrompt,
        negativePrompt: adult.negativePrompt,
        note: adult.note,
        engine: adult.source === 'model' ? 'adult' : 'adult-fallback',
      };
    }

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
