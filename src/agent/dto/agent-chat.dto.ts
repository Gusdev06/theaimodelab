import {
  IsString,
  IsOptional,
  IsArray,
  ValidateNested,
  IsIn,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AgentImageDto {
  @ApiProperty({ description: 'Imagem em base64 (sem prefixo data:)' })
  @IsString()
  base64: string;

  @ApiPropertyOptional({ description: 'MIME type', default: 'image/png' })
  @IsOptional()
  @IsString()
  @IsIn(['image/png', 'image/jpeg'])
  mime_type?: string;
}

export class AgentHistoryMessageDto {
  @ApiProperty({ enum: ['user', 'model'] })
  @IsIn(['user', 'model'])
  role: 'user' | 'model';

  @ApiProperty({ description: 'Conteúdo textual do turno' })
  @IsString()
  text: string;
}

export class AgentChatDto {
  @ApiProperty({
    description: 'Mensagem atual do usuário para o agente',
    example: 'Gere uma imagem 4K de um gato astronauta em estilo cyberpunk',
  })
  @IsString()
  message: string;

  @ApiPropertyOptional({
    description:
      'Histórico textual da conversa (turnos anteriores). O agente mantém o ' +
      'contexto; não inclui as chamadas de ferramenta internas.',
    type: [AgentHistoryMessageDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AgentHistoryMessageDto)
  history?: AgentHistoryMessageDto[];

  @ApiPropertyOptional({
    description:
      'Imagens anexadas à mensagem. O agente as referencia por índice ' +
      '(0, 1, ...) ao chamar ferramentas de geração com referência.',
    type: [AgentImageDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => AgentImageDto)
  images?: AgentImageDto[];

  @ApiPropertyOptional({
    description: 'Modelo Gemini a usar no raciocínio do agente',
    default: 'gemini-3.5-flash',
  })
  @IsOptional()
  @IsString()
  model?: string;
}
