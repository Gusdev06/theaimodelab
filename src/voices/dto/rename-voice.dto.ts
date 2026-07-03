import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength, MaxLength } from 'class-validator';
import {
  VOICE_NAME_MAX_LENGTH,
  VOICE_NAME_MIN_LENGTH,
} from '../voices.constants';

export class RenameVoiceDto {
  @ApiProperty({
    description: 'Novo nome da voz',
    minLength: VOICE_NAME_MIN_LENGTH,
    maxLength: VOICE_NAME_MAX_LENGTH,
  })
  @IsString()
  @MinLength(VOICE_NAME_MIN_LENGTH)
  @MaxLength(VOICE_NAME_MAX_LENGTH)
  name: string;
}
