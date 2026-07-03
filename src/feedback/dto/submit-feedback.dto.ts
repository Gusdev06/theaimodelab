import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const FEEDBACK_GOALS = [
  'tiktok-shop',
  'canal',
  'ads',
  'agencia',
  'outro',
] as const;

export const FEEDBACK_FEATURES = [
  'imagens',
  'videos',
  'movimento',
  'face-swap',
  'try-on',
  'upscale',
  'ranking-tiktok',
  'prompts',
] as const;

export type FeedbackGoal = (typeof FEEDBACK_GOALS)[number];
export type FeedbackFeature = (typeof FEEDBACK_FEATURES)[number];

export class SubmitFeedbackDto {
  @ApiProperty({ minimum: 0, maximum: 10 })
  @IsInt()
  @Min(0)
  @Max(10)
  nps: number;

  @ApiProperty({ minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiProperty({ enum: FEEDBACK_GOALS })
  @IsString()
  @IsIn(FEEDBACK_GOALS as unknown as string[])
  goal: FeedbackGoal;

  @ApiPropertyOptional({ description: 'Required when goal === "outro"' })
  @ValidateIf((o: SubmitFeedbackDto) => o.goal === 'outro')
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  @IsOptional()
  goalOther?: string;

  @ApiProperty({ enum: FEEDBACK_FEATURES, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsIn(FEEDBACK_FEATURES as unknown as string[], { each: true })
  features: FeedbackFeature[];

  @ApiProperty({ minLength: 10, maxLength: 500 })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  highlight: string;

  @ApiProperty({ minLength: 10, maxLength: 1000 })
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  improve: string;

  @ApiProperty({ minLength: 10, maxLength: 500 })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  wishlist: string;
}
