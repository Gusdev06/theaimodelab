import { IsArray, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MarkEarningsPaidDto {
  @ApiProperty({ description: 'IDs dos earnings para marcar como pagos' })
  @IsArray()
  @IsString({ each: true })
  earningIds: string[];

  @ApiPropertyOptional({ description: 'Conteúdo base64 do comprovante (sem prefixo data:)' })
  @IsOptional()
  @IsString()
  receiptBase64?: string;

  @ApiPropertyOptional({ description: 'Nome do arquivo do comprovante' })
  @IsOptional()
  @IsString()
  receiptFilename?: string;

  @ApiPropertyOptional({ description: 'MIME type do comprovante' })
  @IsOptional()
  @IsString()
  receiptMimeType?: string;
}
