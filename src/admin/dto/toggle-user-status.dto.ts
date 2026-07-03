import { IsBoolean, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ToggleUserStatusDto {
  @ApiProperty({
    description: 'Whether the user should be active (true) or deactivated (false)',
    example: false,
  })
  @IsBoolean()
  @IsNotEmpty()
  isActive: boolean;
}
