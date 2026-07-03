import { IsArray, IsString, ArrayMinSize } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AddGenerationsToFolderDto {
  @ApiProperty({ description: 'IDs das geracoes para adicionar a pasta', type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  generationIds: string[];
}
