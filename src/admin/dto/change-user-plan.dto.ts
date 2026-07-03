import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangeUserPlanDto {
  @ApiProperty({
    description: 'Slug do plano desejado',
    example: 'pro',
    enum: ['free', 'starter', 'creator', 'pro', 'studio'],
  })
  @IsString()
  @IsNotEmpty()
  planSlug: string;
}
