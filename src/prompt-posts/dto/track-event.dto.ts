import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum PromptPostEvent {
  VIEW = 'view',
  COPY = 'copy',
  USE = 'use',
}

export class TrackEventDto {
  @ApiProperty({ enum: PromptPostEvent })
  @IsEnum(PromptPostEvent)
  event: PromptPostEvent;

  @ApiPropertyOptional({ description: 'Index do slide afetado (para copy/use)' })
  @IsInt()
  @Min(0)
  @IsOptional()
  slideIndex?: number;
}
