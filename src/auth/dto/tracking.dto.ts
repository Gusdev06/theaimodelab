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

  @ApiPropertyOptional({ description: 'Meta _fbp first-party browser id' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  fbp?: string;

  @ApiPropertyOptional({ description: 'Meta _fbc click id cookie value' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  fbc?: string;

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

  @ApiPropertyOptional({ description: 'Shared browser/server event id for Meta deduplication' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  event_id?: string;

  @ApiPropertyOptional({ description: 'Full URL where the conversion happened' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  event_source_url?: string;
}
