import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class TrackingDto {
  @ApiPropertyOptional({ description: 'UTM source (e.g. facebook, google)' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  utm_source?: string;

  @ApiPropertyOptional({ description: 'UTM medium (e.g. cpc, social)' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  utm_medium?: string;

  @ApiPropertyOptional({ description: 'UTM campaign id/name' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  utm_campaign?: string;

  @ApiPropertyOptional({ description: 'UTM content (ad id/name)' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  utm_content?: string;

  @ApiPropertyOptional({ description: 'UTM term (keyword)' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  utm_term?: string;

  @ApiPropertyOptional({ description: 'Facebook click id' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  fbclid?: string;

  @ApiPropertyOptional({ description: 'Google click id' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  gclid?: string;

  @ApiPropertyOptional({ description: 'document.referrer at first visit' })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  referrer?: string;

  @ApiPropertyOptional({ description: 'Path + query of the landing page' })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  landing_page?: string;
}
