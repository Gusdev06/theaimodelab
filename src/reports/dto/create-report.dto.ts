import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Equals, IsBoolean, IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ContentReportCategory } from '@prisma/client';

export class CreateReportDto {
  @ApiProperty({ enum: ContentReportCategory, description: 'Motivo da denúncia' })
  @IsEnum(ContentReportCategory)
  category: ContentReportCategory;

  @ApiProperty({ description: 'Link, id da geração ou onde está o conteúdo denunciado' })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  target: string;

  @ApiProperty({ description: 'O que está errado com o conteúdo' })
  @IsString()
  @MinLength(10)
  @MaxLength(4000)
  description: string;

  @ApiPropertyOptional({ description: 'E-mail para retorno (recomendado)' })
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  reporterEmail?: string;

  @ApiPropertyOptional({ description: 'Quem denuncia é a pessoa que aparece no conteúdo' })
  @IsOptional()
  @IsBoolean()
  isDepictedPerson?: boolean;

  /** isca para robô: humano nunca preenche (o campo fica escondido no formulário) */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;
}

/**
 * Andamento da denúncia pelo admin. Pelo menos um campo (o serviço recusa o corpo vazio). Liberar a evidência só com a
 * denúncia confirmada (ACTIONED). Qualquer troca de status desfaz a liberação: a denúncia volta a segurar a exclusão LGPD
 * da conta denunciada até ser confirmada e liberada de novo (o pedido que confirma e libera junto vale).
 */
export class UpdateReportDto {
  @ApiPropertyOptional({ enum: ['OPEN', 'IN_REVIEW', 'ACTIONED', 'DISMISSED'] })
  @IsOptional()
  @IsEnum(['OPEN', 'IN_REVIEW', 'ACTIONED', 'DISMISSED'])
  status?: 'OPEN' | 'IN_REVIEW' | 'ACTIONED' | 'DISMISSED';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  adminNote?: string;

  @ApiPropertyOptional({
    description:
      'true libera a evidência (só com a denúncia removida/ACTIONED, já gravada ou no mesmo pedido; repetir não muda a data): a denúncia deixa de segurar a exclusão LGPD da conta denunciada. Qualquer troca de status depois desfaz a liberação',
    type: Boolean,
  })
  @IsOptional()
  @Equals(true, { message: 'evidenceReleased só aceita true (para voltar a segurar a evidência, mude o status da denúncia)' })
  evidenceReleased?: true;
}
