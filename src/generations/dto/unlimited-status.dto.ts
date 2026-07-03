import { ApiProperty } from '@nestjs/swagger';
import { Resolution } from '@prisma/client';

export class UnlimitedModelDto {
  @ApiProperty({ description: 'Identificador interno do modelo (ex: THEAIMODELAB_FAST, NB2).' })
  modelVariant!: string;

  @ApiProperty({
    description: 'Resoluções liberadas para esse modelo no plano atual.',
    enum: Resolution,
    isArray: true,
  })
  resolutions!: Resolution[];
}

export class UnlimitedStatusResponseDto {
  @ApiProperty({
    description: 'Se o usuário tem acesso ao modo ilimitado em algum modelo.',
  })
  eligible!: boolean;

  @ApiProperty({
    description: 'Slug do plano atual (null quando o plano não inclui ilimitado).',
    nullable: true,
  })
  planSlug!: string | null;

  @ApiProperty({
    description: 'Lista de modelos + resoluções liberados no modo ilimitado do plano.',
    type: [UnlimitedModelDto],
  })
  models!: UnlimitedModelDto[];

  @ApiProperty({
    description: 'Gerações ilimitadas feitas nas últimas 24h pelo usuário.',
  })
  usageCount!: number;

  @ApiProperty({
    description:
      'Se o usuário já tem uma geração ilimitada em andamento (apenas 1 simultânea é permitida).',
  })
  hasActiveJob!: boolean;
}
