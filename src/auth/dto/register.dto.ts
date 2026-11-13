import { IsEmail, IsString, MinLength, MaxLength, Matches, IsNotEmpty, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { TrackingDto } from './tracking.dto';
import { coded } from '../../common/i18n/coded-validation';

/** Regra da senha (o site valida antes de enviar com a mesma expressão). */
export const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d\W_]{8,}$/;

export class RegisterDto {
  @ApiProperty({
    example: 'john.doe@example.com',
    description: 'Email do usuário',
  })
  @IsEmail({}, coded('EMAIL_INVALID'))
  @IsNotEmpty(coded('EMAIL_REQUIRED'))
  email: string;

  @ApiProperty({
    example: 'John Doe',
    description: 'Nome completo do usuário',
  })
  @IsString(coded('NAME_REQUIRED'))
  @IsNotEmpty(coded('NAME_REQUIRED'))
  @MinLength(2, coded('NAME_TOO_SHORT'))
  @MaxLength(100, coded('NAME_TOO_LONG'))
  name: string;

  @ApiProperty({
    example: 'SecurePassword123!',
    description: 'Senha do usuário',
  })
  @IsString(coded('PASSWORD_REQUIRED'))
  @IsNotEmpty(coded('PASSWORD_REQUIRED'))
  @MinLength(8, coded('PASSWORD_TOO_SHORT'))
  @MaxLength(100, coded('PASSWORD_TOO_LONG'))
  @Matches(PASSWORD_RULE, coded('PASSWORD_WEAK'))
  password: string;

  @ApiPropertyOptional({
    example: 'INFLUENCER123',
    description: 'Código de indicação do afiliado',
  })
  @IsString()
  @IsOptional()
  @MaxLength(50, coded('REFERRAL_CODE_TOO_LONG'))
  @Matches(/^[A-Za-z0-9_-]+$/, coded('REFERRAL_CODE_INVALID'))
  referralCode?: string;

  @ApiPropertyOptional({ description: 'Atribuição de marketing capturada na landing' })
  @IsOptional()
  @ValidateNested()
  @Type(() => TrackingDto)
  tracking?: TrackingDto;
}
