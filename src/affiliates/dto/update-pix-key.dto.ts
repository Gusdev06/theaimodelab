import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export enum PixKeyTypeDto {
  CPF = 'CPF',
  CNPJ = 'CNPJ',
  EMAIL = 'EMAIL',
  PHONE = 'PHONE',
  RANDOM = 'RANDOM',
}

export class UpdatePixKeyDto {
  @ApiProperty({ enum: PixKeyTypeDto, example: PixKeyTypeDto.CPF })
  @IsEnum(PixKeyTypeDto)
  pixKeyType: PixKeyTypeDto;

  @ApiProperty({ example: '12345678900', description: 'Chave Pix no formato correspondente ao tipo' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(140)
  pixKey: string;
}
