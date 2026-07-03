import { IsArray, IsString, ArrayMinSize } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ReorderClipsDto {
  @ApiProperty({ description: 'IDs dos clips na nova ordem', type: [String] })
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  clipIds: string[];
}
