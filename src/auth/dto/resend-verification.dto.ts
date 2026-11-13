import { IsEmail, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { coded } from '../../common/i18n/coded-validation';

export class ResendVerificationDto {
  @ApiProperty({
    example: 'usuario@exemplo.com',
    description: 'Email do usuário que precisa verificar a conta',
  })
  @IsEmail({}, coded('EMAIL_INVALID'))
  @IsNotEmpty(coded('EMAIL_REQUIRED'))
  email: string;
}
