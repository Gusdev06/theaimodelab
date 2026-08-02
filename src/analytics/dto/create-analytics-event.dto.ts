import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Evento de analytics de produto enviado pelo frontend (ex.: paywall).
 *
 * `eventName` e `action` são persistidos em colunas dedicadas (agregação rápida).
 * Os demais campos (trigger, surface, toolType, credits*, targetId, locale, url,
 * utm_*, fbp, fbc) vão para o `payload` JSON.
 *
 * ATENÇÃO: o ValidationPipe GLOBAL roda com `forbidNonWhitelisted`, então todo
 * campo que o frontend envia PRECISA estar declarado aqui — campo não declarado
 * derruba o evento inteiro com 400. O tamanho do payload é limitado no service.
 */
export class CreateAnalyticsEventDto {
  @ApiProperty({ example: 'paywall', maxLength: 100 })
  @IsString()
  @MaxLength(100)
  eventName: string;

  @ApiPropertyOptional({ example: 'shown', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  trigger?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  surface?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  toolType?: string;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  creditsNeeded?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  creditsAvailable?: number;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  targetId?: string;

  @ApiPropertyOptional({ maxLength: 16 })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  locale?: string;

  @ApiPropertyOptional({ maxLength: 2048 })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  utm_source?: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  utm_medium?: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  utm_campaign?: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  utm_content?: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  utm_term?: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fbp?: string;

  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  fbc?: string;
}
