import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ToggleModelDto {
  @ApiProperty({
    description: 'Whether the model should be active (true) or deactivated (false)',
    example: false,
  })
  @IsBoolean()
  @IsNotEmpty()
  isActive: boolean;

  @ApiPropertyOptional({
    description: 'Mensagem custom exibida quando o modelo está inativo',
    example: 'Em manutenção — voltamos em breve',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  statusMessage?: string;
}
