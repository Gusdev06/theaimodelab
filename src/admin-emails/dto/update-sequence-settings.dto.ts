import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

export class UpdateSequenceSettingsDto {
  @ApiPropertyOptional({
    description: 'Liga/desliga o cron das sequências automáticas de email',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Créditos de boas-vindas concedidos no cadastro (0 = desligado). Gravado em app_settings.welcome_credits_amount.',
    example: 130,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  welcomeCredits?: number;
}
