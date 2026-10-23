import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ContentSafetyScanStage,
  ContentSafetyScanVerdict,
} from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  REPORT_CHANNELS,
  REPORT_PROTOCOL_FORMAT,
  REVIEW_DECISIONS,
  REVIEW_REASON_MAX_LENGTH,
  REVIEW_REASON_MIN_LENGTH,
  type ReportChannel,
  type ReviewDecision,
} from './review.helpers';

const ID_FORMAT = /^[A-Za-z0-9_-]{1,64}$/;
const RULE_FORMAT = /^[A-Za-z0-9_:-]{1,40}$/;
const ACCESS_ACTION_FORMAT = /^[a-z_]{1,32}$/;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' || value === true
    ? true
    : value === 'false' || value === false
      ? false
      : value;

/** Motivo obrigatório (fica no registro de acesso, ao lado de quem e quando). */
class ReviewReasonDto {
  @ApiProperty({
    description: `Por que esta ação é necessária (de ${REVIEW_REASON_MIN_LENGTH} a ${REVIEW_REASON_MAX_LENGTH} caracteres; fica no registro de acesso)`,
    minLength: REVIEW_REASON_MIN_LENGTH,
    maxLength: REVIEW_REASON_MAX_LENGTH,
  })
  @Transform(trim)
  @IsString({ message: 'reason precisa ser texto' })
  @MinLength(REVIEW_REASON_MIN_LENGTH, {
    message: `reason precisa ter pelo menos ${REVIEW_REASON_MIN_LENGTH} caracteres`,
  })
  @MaxLength(REVIEW_REASON_MAX_LENGTH, {
    message: `reason pode ter no máximo ${REVIEW_REASON_MAX_LENGTH} caracteres`,
  })
  reason: string;
}

class PageQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}

/** Filtros da lista de checagens (sem URL de mídia na resposta). */
export class ListSafetyScansQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ContentSafetyScanVerdict })
  @IsOptional()
  @IsIn(Object.values(ContentSafetyScanVerdict))
  verdict?: ContentSafetyScanVerdict;

  @ApiPropertyOptional({ enum: ContentSafetyScanStage })
  @IsOptional()
  @IsIn(Object.values(ContentSafetyScanStage))
  stage?: ContentSafetyScanStage;

  @ApiPropertyOptional({ description: 'Regra que decidiu (E1…E7, S1…S7, T_*, REVIEW_CONFIRMED)' })
  @IsOptional()
  @Matches(RULE_FORMAT, { message: 'rule inválida' })
  rule?: string;

  @ApiPropertyOptional({ description: 'Desde (AAAA-MM-DD em UTC ou ISO completo)' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ description: 'Até (AAAA-MM-DD inclui o dia inteiro em UTC, ou ISO completo)' })
  @IsOptional()
  @IsString()
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(ID_FORMAT, { message: 'generationId inválido' })
  generationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(ID_FORMAT, { message: 'userId inválido' })
  userId?: string;

  @ApiPropertyOptional({ description: 'Só checagens de gerações em revisão (IN_REVIEW)' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  inReview?: boolean;
}

/** Abrir a mídia de uma checagem: só com motivo. */
export class SafetyMediaQueryDto extends ReviewReasonDto {}

/** Reativar a conta suspensa pela camada 6: só com motivo (fica na trilha da suspensão). */
export class SafetyReactivateAccountDto extends ReviewReasonDto {}

/** Decisão do revisor sobre uma checagem. */
export class SafetyScanDecisionDto extends ReviewReasonDto {
  @ApiProperty({
    enum: REVIEW_DECISIONS,
    description:
      'release = falso positivo (entrada segurada volta à fila; resultado segurado é publicado e a geração conclui); ' +
      'confirm = caso confirmado (evidência guardada, sinal forte, geração em revisão encerrada com estorno); ' +
      'report = comunicação feita à autoridade (exige confirmação antes)',
  })
  @IsIn(REVIEW_DECISIONS as unknown as string[], {
    message: `action precisa ser ${REVIEW_DECISIONS.join(', ')}`,
  })
  action: ReviewDecision;

  @ApiPropertyOptional({
    enum: REPORT_CHANNELS,
    description: 'Canal da comunicação (obrigatório em report)',
  })
  @ValidateIf((dto: SafetyScanDecisionDto) => dto.action === 'report')
  @IsIn(REPORT_CHANNELS as unknown as string[], {
    message: `channel precisa ser ${REPORT_CHANNELS.join(', ')}`,
  })
  channel?: ReportChannel;

  @ApiPropertyOptional({ description: 'Protocolo devolvido pelo canal (só em report)' })
  @IsOptional()
  @Transform(trim)
  @Matches(REPORT_PROTOCOL_FORMAT, {
    message: 'protocol só aceita letras, números, ponto, hífen, sublinhado e barra (até 80)',
  })
  protocol?: string;
}

/** Filtros do registro de acesso da revisão. */
export class SafetyAccessLogQueryDto extends PageQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(ID_FORMAT, { message: 'actorId inválido' })
  actorId?: string;

  @ApiPropertyOptional({ description: 'view_media, release, confirm, report…' })
  @IsOptional()
  @Matches(ACCESS_ACTION_FORMAT, { message: 'action inválida' })
  action?: string;

  @ApiPropertyOptional({ description: 'scan, generation, event, report, user' })
  @IsOptional()
  @Matches(ACCESS_ACTION_FORMAT, { message: 'targetType inválido' })
  targetType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(ID_FORMAT, { message: 'targetId inválido' })
  targetId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  to?: string;
}

/** Janela das métricas, em dias UTC (inclui hoje). */
export class SafetyMetricsQueryDto {
  @ApiPropertyOptional({ default: 7, minimum: 1, maximum: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  days: number = 7;
}
