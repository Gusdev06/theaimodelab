import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  TAKEDOWN_MAX_GENERATIONS,
  TAKEDOWN_REASON_MAX_LENGTH,
  TAKEDOWN_REASON_MIN_LENGTH,
} from '../../content-safety/takedown/takedown.service';

/** Remoção confirmada pelo revisor: por quê (vai para o registro de acesso) e, se preciso, quais gerações. */
export class ExecuteTakedownDto {
  @ApiProperty({
    description: `Por que a remoção foi confirmada (de ${TAKEDOWN_REASON_MIN_LENGTH} a ${TAKEDOWN_REASON_MAX_LENGTH} caracteres); fica no registro de acesso`,
    minLength: TAKEDOWN_REASON_MIN_LENGTH,
    maxLength: TAKEDOWN_REASON_MAX_LENGTH,
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'reason precisa ser texto' })
  @MinLength(TAKEDOWN_REASON_MIN_LENGTH, { message: `reason precisa ter pelo menos ${TAKEDOWN_REASON_MIN_LENGTH} caracteres` })
  @MaxLength(TAKEDOWN_REASON_MAX_LENGTH, { message: `reason pode ter no máximo ${TAKEDOWN_REASON_MAX_LENGTH} caracteres` })
  reason: string;

  @ApiPropertyOptional({
    description: `Gerações a remover (até ${TAKEDOWN_MAX_GENERATIONS}). Vazio = as citadas na denúncia (id da geração, do post ou link do arquivo). Para incluir uma cópia parecida listada em nearCopies, mande o id dela aqui`,
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TAKEDOWN_MAX_GENERATIONS)
  @IsString({ each: true })
  @Matches(/^[A-Za-z0-9_-]{10,64}$/, { each: true, message: 'generationIds só aceita ids de geração' })
  generationIds?: string[];

  @ApiPropertyOptional({
    description:
      'true guarda os arquivos como evidência mesmo sem guarda legal (ex.: a pessoa vai à polícia). Com guarda legal, a evidência é guardada de qualquer jeito',
    type: Boolean,
  })
  @IsOptional()
  @IsBoolean()
  preserveEvidence?: boolean;
}
