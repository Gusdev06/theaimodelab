import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  PAYOUT_EMAIL_MAX_LENGTH,
  PIX_KEY_MAX_LENGTH,
  isPixPayoutMethod,
} from '../affiliate-payout';
import { PixKeyTypeDto } from './update-pix-key.dto';

export enum PayoutMethodDto {
  PIX = 'PIX',
  PAYPAL = 'PAYPAL',
  WISE = 'WISE',
}

/**
 * Forma de recebimento do afiliado. Três corpos aceitos:
 *   { payoutMethod: 'PIX', pixKeyType, pixKey }
 *   { payoutMethod: 'PAYPAL' | 'WISE', payoutEmail }
 *   { pixKeyType, pixKey }            (formato antigo, vale como PIX)
 */
export class UpdatePayoutDto {
  @ApiPropertyOptional({ enum: PayoutMethodDto, description: 'Sem este campo vale PIX (formato antigo)' })
  @IsOptional()
  @IsEnum(PayoutMethodDto)
  payoutMethod?: PayoutMethodDto;

  @ApiPropertyOptional({ enum: PixKeyTypeDto, example: PixKeyTypeDto.CPF, description: 'Obrigatório no PIX' })
  @ValidateIf((dto: UpdatePayoutDto) => isPixPayoutMethod(dto.payoutMethod))
  @IsEnum(PixKeyTypeDto)
  pixKeyType?: PixKeyTypeDto;

  @ApiPropertyOptional({ example: '12345678900', description: 'Obrigatória no PIX' })
  @ValidateIf((dto: UpdatePayoutDto) => isPixPayoutMethod(dto.payoutMethod))
  @IsString()
  @IsNotEmpty()
  @MaxLength(PIX_KEY_MAX_LENGTH)
  pixKey?: string;

  @ApiPropertyOptional({ example: 'ana@exemplo.com', description: 'E-mail da conta PayPal ou Wise (obrigatório nelas)' })
  @ValidateIf((dto: UpdatePayoutDto) => !isPixPayoutMethod(dto.payoutMethod))
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(PAYOUT_EMAIL_MAX_LENGTH)
  payoutEmail?: string;
}
