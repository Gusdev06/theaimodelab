import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LogoutDto {
  @ApiProperty({ description: 'Refresh token a ser revogado' })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}
