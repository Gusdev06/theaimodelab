import { IsArray, IsString, ArrayMinSize } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RemoveGenerationsFromFolderDto {
  @ApiProperty({ description: 'IDs das geracoes para remover da pasta', type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  generationIds: string[];
}
