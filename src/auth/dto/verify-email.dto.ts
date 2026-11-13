import { IsString, IsNotEmpty, Length, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { coded } from '../../common/i18n/coded-validation';

export class VerifyEmailDto {
  @ApiProperty({
    example: '123456',
    description: 'Código de 6 dígitos recebido por email',
  })
  @IsString(coded('CODE_REQUIRED'))
  @IsNotEmpty(coded('CODE_REQUIRED'))
  @Length(6, 6, coded('CODE_LENGTH'))
  @Matches(/^\d{6}$/, coded('CODE_DIGITS'))
  code: string;
}
