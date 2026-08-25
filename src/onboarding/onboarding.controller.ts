import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { OnboardingService } from './onboarding.service';
import {
  CompleteOnboardingQuizDto,
  SaveOnboardingProgressDto,
} from './dto/onboarding-answers.dto';
import { OnboardingProfileResponseDto } from './dto/onboarding-profile-response.dto';
import {
  CurrentUser,
  JwtPayload,
} from '../common/decorators/current-user.decorator';

@ApiTags('onboarding')
@ApiBearerAuth()
@Controller('api/v1/onboarding')
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Get('me')
  @ApiOperation({ summary: 'Estado do quiz de onboarding do usuário atual' })
  @ApiResponse({ status: 200, type: OnboardingProfileResponseDto })
  async getProfile(
    @CurrentUser() user: JwtPayload,
  ): Promise<OnboardingProfileResponseDto> {
    return this.onboardingService.getProfile(user.sub);
  }

  @Patch('progress')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Salva o progresso parcial do quiz (drop-off por pergunta)',
  })
  @ApiResponse({ status: 200, type: OnboardingProfileResponseDto })
  async saveProgress(
    @CurrentUser() user: JwtPayload,
    @Body() dto: SaveOnboardingProgressDto,
  ): Promise<OnboardingProfileResponseDto> {
    return this.onboardingService.saveProgress(user.sub, dto);
  }

  @Post('complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Conclui o quiz, concede o Starter Kit e devolve o plano de produção',
  })
  @ApiResponse({ status: 200, type: OnboardingProfileResponseDto })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CompleteOnboardingQuizDto,
  ): Promise<OnboardingProfileResponseDto> {
    return this.onboardingService.complete(user.sub, dto);
  }
}
