import { IsOptional, IsString } from 'class-validator';

export class EnhanceInfluencerDto {
  @IsString()
  characterType: string;

  @IsString()
  gender: string;

  @IsString()
  ethnicity: string;

  @IsString()
  skinColor: string;

  @IsString()
  eyeColor: string;

  @IsString()
  @IsOptional()
  skinCondition?: string;

  @IsString()
  age: string;

  @IsString()
  @IsOptional()
  eyeType?: string;

  @IsString()
  @IsOptional()
  eyeDetails?: string;

  @IsString()
  @IsOptional()
  mouth?: string;

  @IsString()
  @IsOptional()
  ears?: string;

  @IsString()
  @IsOptional()
  horns?: string;

  @IsString()
  @IsOptional()
  faceSkinMaterial?: string;

  @IsString()
  @IsOptional()
  surfacePattern?: string;

  @IsString()
  @IsOptional()
  bodyType?: string;

  @IsString()
  @IsOptional()
  leftArm?: string;

  @IsString()
  @IsOptional()
  rightArm?: string;

  @IsString()
  @IsOptional()
  leftLeg?: string;

  @IsString()
  @IsOptional()
  rightLeg?: string;

  @IsString()
  @IsOptional()
  hair?: string;

  @IsString()
  @IsOptional()
  hairColor?: string;

  @IsString()
  @IsOptional()
  accessories?: string;

  @IsString()
  @IsOptional()
  renderingStyle?: string;

  @IsString()
  @IsOptional()
  referenceImageBase64?: string;

  @IsString()
  @IsOptional()
  referenceImageMimeType?: string;
}
