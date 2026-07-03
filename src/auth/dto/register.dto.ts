import { IsEmail, IsString, MinLength, MaxLength, Matches, IsNotEmpty, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { TrackingDto } from './tracking.dto';

export class RegisterDto {
  @ApiProperty({
    example: 'john.doe@example.com',
    description: 'Email do usuário',
  })
  @IsEmail({}, { message: 'Email inválido' })
  @IsNotEmpty({ message: 'Email é obrigatório' })
  email: string;

  @ApiProperty({
    example: 'John Doe',
    description: 'Nome completo do usuário',
  })
  @IsString()
  @IsNotEmpty({ message: 'Nome é obrigatório' })
  @MinLength(2, { message: 'Nome deve ter no mínimo 2 caracteres' })
  @MaxLength(100, { message: 'Nome deve ter no máximo 100 caracteres' })
  name: string;

  @ApiProperty({
    example: 'SecurePassword123!',
    description: 'Senha do usuário',
  })
  @IsString()
  @IsNotEmpty({ message: 'Senha é obrigatória' })
  @MinLength(8, { message: 'Senha deve ter no mínimo 8 caracteres' })
  @MaxLength(100, { message: 'Senha deve ter no máximo 100 caracteres' })
  @Matches(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d\W_]{8,}$/,
    {
      message: 'Senha deve conter pelo menos uma letra maiúscula, uma minúscula e um número',
    },
  )
  password: string;

  @ApiPropertyOptional({
    example: 'INFLUENCER123',
    description: 'Código de indicação do afiliado',
  })
  @IsString()
  @IsOptional()
  @MaxLength(50, { message: 'Código de indicação deve ter no máximo 50 caracteres' })
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'Código de indicação contém caracteres inválidos' })
  referralCode?: string;

  @ApiPropertyOptional({ description: 'Atribuição de marketing capturada na landing' })
  @IsOptional()
  @ValidateNested()
  @Type(() => TrackingDto)
  tracking?: TrackingDto;
}
