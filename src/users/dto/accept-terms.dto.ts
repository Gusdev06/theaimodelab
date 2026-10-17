import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

export class AcceptTermsDto {
  @ApiPropertyOptional({
    example: '2026-10-15',
    description: 'Versão do termo que o app mostrou (AAAA-MM-DD). Sem ela, vale a versão do app antigo.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  version?: string;
}
