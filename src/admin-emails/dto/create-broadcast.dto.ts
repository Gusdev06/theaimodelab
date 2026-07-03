import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RecipientSelectionDto } from './recipient-filter.dto';

export class CreateBroadcastDto extends RecipientSelectionDto {
  @ApiProperty({
    description: 'Assunto do email',
    example: 'Sua capacidade de gerar vídeos triplicou',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(200)
  subject: string;

  @ApiProperty({
    description: 'Corpo do email — Markdown (default) ou HTML bruto se format=html',
    example: '# Olá!\n\nBoa notícia: ...',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(50_000)
  bodyMarkdown: string;

  @ApiPropertyOptional({
    description:
      'Formato do corpo. "markdown" (default): converte e aplica template padrão. "html": usa o conteúdo bruto, sem template wrapper.',
    enum: ['markdown', 'html'],
    default: 'markdown',
  })
  @IsOptional()
  @IsString()
  @IsIn(['markdown', 'html'])
  format?: 'markdown' | 'html';
}
