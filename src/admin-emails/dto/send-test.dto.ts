import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendTestDto {
  @ApiProperty({ description: 'Assunto do email' })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(200)
  subject: string;

  @ApiProperty({ description: 'Corpo do email — Markdown (default) ou HTML' })
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(50_000)
  bodyMarkdown: string;

  @ApiPropertyOptional({
    enum: ['markdown', 'html'],
    default: 'markdown',
  })
  @IsOptional()
  @IsString()
  @IsIn(['markdown', 'html'])
  format?: 'markdown' | 'html';
}
