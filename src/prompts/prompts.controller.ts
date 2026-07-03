import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { PromptsService } from './prompts.service';
import {
  PromptSectionDto,
  PromptSectionsResponseDto,
  PromptTemplateDto,
} from './dto/prompt-response.dto';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('prompts')
@Controller('api/v1/prompts')
export class PromptsController {
  constructor(private readonly promptsService: PromptsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Lista todas as secoes com categorias e prompts' })
  @ApiResponse({
    status: 200,
    description: 'Secoes retornadas com sucesso',
    type: PromptSectionsResponseDto,
  })
  async getAllSections(): Promise<PromptSectionsResponseDto> {
    const sections = await this.promptsService.getAllSections();
    return { sections };
  }

  @Public()
  @Get('search')
  @ApiOperation({ summary: 'Busca prompts por titulo ou conteudo' })
  @ApiQuery({
    name: 'q',
    required: true,
    description: 'Termo de busca',
    example: 'moda',
  })
  @ApiResponse({
    status: 200,
    description: 'Resultados da busca',
    type: [PromptTemplateDto],
  })
  async searchPrompts(
    @Query('q') query: string,
  ): Promise<PromptTemplateDto[]> {
    return this.promptsService.searchPrompts(query || '');
  }

  @Public()
  @Get(':slug')
  @ApiOperation({ summary: 'Retorna uma secao pelo slug' })
  @ApiParam({
    name: 'slug',
    description: 'Slug unico da secao',
    example: 'moda-feminina',
  })
  @ApiResponse({
    status: 200,
    description: 'Secao retornada com sucesso',
    type: PromptSectionDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Secao nao encontrada',
  })
  async getSectionBySlug(
    @Param('slug') slug: string,
  ): Promise<PromptSectionDto> {
    return this.promptsService.getSectionBySlug(slug);
  }
}
