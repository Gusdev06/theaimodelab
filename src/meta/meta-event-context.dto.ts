import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class MetaEventContextDto {
  @ApiPropertyOptional({ description: 'Shared browser/server event id for Meta deduplication' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  eventId?: string;

  @ApiPropertyOptional({ description: 'Full URL where the browser event happened' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  eventSourceUrl?: string;

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
}
