import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class AnalyzeImageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000_000)
  image!: string; // data URL (base64) ou http(s) URL
}
