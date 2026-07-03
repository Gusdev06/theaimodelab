import {
  IsNotEmpty,
  IsString,
  MaxLength,
  IsOptional,
  IsObject,
  IsArray,
  IsIn,
  IsNumber,
  IsBoolean,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ReferenceImageDto {
  @IsString()
  base64: string;

  @IsString()
  mime_type: string;
}

export class GenerationContextDto {
  @IsIn(['image', 'video'])
  type: 'image' | 'video';

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  resolution?: string;

  @IsOptional()
  @IsString()
  aspectRatio?: string;

  @IsOptional()
  @IsString()
  quality?: string;

  @IsOptional()
  @IsNumber()
  durationSeconds?: number;

  @IsOptional()
  @IsBoolean()
  hasAudio?: boolean;

  @IsOptional()
  @IsBoolean()
  hasReferenceImages?: boolean;

  @IsOptional()
  @IsBoolean()
  hasFirstFrame?: boolean;

  @IsOptional()
  @IsBoolean()
  hasLastFrame?: boolean;

  @IsOptional()
  @IsString()
  negativePrompt?: string;

  @IsOptional()
  @IsNumber()
  sampleCount?: number;
}

export class EnhancePromptDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  prompt: string;

  @IsOptional()
  @IsObject()
  @Type(() => GenerationContextDto)
  context?: GenerationContextDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReferenceImageDto)
  images?: ReferenceImageDto[];
}
