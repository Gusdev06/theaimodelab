import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength, MaxLength, IsNotEmpty } from 'class-validator';
import {
  VOICE_NAME_MAX_LENGTH,
  VOICE_NAME_MIN_LENGTH,
} from '../voices.constants';

export class CreateVoiceDto {
  @ApiProperty({
    description: 'ID da geração de voice-clone que servirá de origem do sample',
  })
  @IsString()
  @IsNotEmpty()
  generationId: string;

  @ApiProperty({
    description: 'Nome amigável da voz',
    minLength: VOICE_NAME_MIN_LENGTH,
    maxLength: VOICE_NAME_MAX_LENGTH,
  })
  @IsString()
  @MinLength(VOICE_NAME_MIN_LENGTH)
  @MaxLength(VOICE_NAME_MAX_LENGTH)
  name: string;
}
