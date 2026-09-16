import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangeUserPlanDto {
  @ApiProperty({
    description: 'Slug do plano desejado',
    example: 'pro',
    enum: ['free', 'ultra-basic', 'starter', 'basic', 'creator', 'pro', 'advanced', 'studio', 'agency'],
  })
  @IsString()
  @IsNotEmpty()
  planSlug: string;
}
