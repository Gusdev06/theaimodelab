import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Header,
  HttpCode,
  Inject,
  Optional,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { ContentSafetyEventKind } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import {
  CurrentUser,
  JwtPayload,
} from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  ContentSafetyService,
  SAFETY_RELEASE_NOTE_MAX_LENGTH,
  SAFETY_RELEASE_NOTE_MIN_LENGTH,
} from './content-safety.service';
import {
  IMAGE_SAFETY_CONFIG,
  type ImageSafetyConfig,
} from './image-safety/image-safety.config';
import { reviewerIpOf } from './reviewer/review.helpers';
import {
  ListSafetyScansQueryDto,
  SafetyAccessLogQueryDto,
  SafetyMediaQueryDto,
  SafetyMetricsQueryDto,
  SafetyReactivateAccountDto,
  SafetyScanDecisionDto,
} from './reviewer/reviewer.dto';
import {
  SafetyReviewService,
  type ReviewActor,
} from './reviewer/safety-review.service';
import { SafetyReviewerGuard } from './reviewer/safety-reviewer.guard';

/** Requisição como o revisor chega (o IP só vai para o registro de acesso). */
interface ReviewerRequest {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null } | null;
}

const REVIEW_PIPE = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

function actorOf(user: JwtPayload, request: ReviewerRequest): ReviewActor {
  return { id: user.sub, email: user.email, ip: reviewerIpOf(request) };
}

/** Liberação de um bloqueio por menor pelo jurídico: a nota explica por quê e fica na trilha. */
export class ReleaseSafetyEventDto {
  @ApiProperty({
    description:
      'Por que o bloqueio está sendo liberado (falso positivo do filtro ou do provedor, caso encerrado). ' +
      `De ${SAFETY_RELEASE_NOTE_MIN_LENGTH} a ${SAFETY_RELEASE_NOTE_MAX_LENGTH} caracteres.`,
    minLength: SAFETY_RELEASE_NOTE_MIN_LENGTH,
    maxLength: SAFETY_RELEASE_NOTE_MAX_LENGTH,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'note precisa ser texto' })
  @MinLength(SAFETY_RELEASE_NOTE_MIN_LENGTH, {
    message: `note precisa ter pelo menos ${SAFETY_RELEASE_NOTE_MIN_LENGTH} caracteres`,
  })
  @MaxLength(SAFETY_RELEASE_NOTE_MAX_LENGTH, {
    message: `note pode ter no máximo ${SAFETY_RELEASE_NOTE_MAX_LENGTH} caracteres`,
  })
  note: string;
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin/content-safety')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class ContentSafetyAdminController {
  constructor(
    private readonly safety: ContentSafetyService,
    /** revisão de segurança (SafetyReviewModule, global); ausente = as rotas do revisor respondem 503 */
    @Optional()
    @Inject(SafetyReviewService)
    private readonly reviewService: SafetyReviewService | null = null,
    /** lista de revisores (SAFETY_REVIEWER_IDS, módulo global de segurança de imagem); ausente = ninguém é revisor */
    @Optional()
    @Inject(IMAGE_SAFETY_CONFIG)
    private readonly safetyConfig: Pick<ImageSafetyConfig, 'reviewerIds'> | null = null,
  ) {}

  private get review(): SafetyReviewService {
    if (!this.reviewService) {
      throw new ServiceUnavailableException(
        'Revisão de segurança indisponível nesta instância.',
      );
    }
    return this.reviewService;
  }

  @Get('events')
  @ApiOperation({
    summary:
      'Trilha de segurança de conteúdo: recusas por menor e atestados de consentimento, com a liberação pelo jurídico ' +
      '(releasedAt, releasedBy, releaseNote, released) (admin)',
  })
  async events(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('kind') kind?: string,
  ) {
    if (
      kind &&
      !Object.prototype.hasOwnProperty.call(ContentSafetyEventKind, kind)
    ) {
      throw new BadRequestException('kind inválido');
    }
    return this.safety.listForAdmin(
      page,
      limit,
      kind as ContentSafetyEventKind | undefined,
    );
  }

  @Patch('events/:id/release')
  @UsePipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  )
  @ApiOperation({
    summary:
      'Libera um bloqueio por menor (MINOR_BLOCKED) a pedido do jurídico: o evento fica na trilha, mas deixa de segurar ' +
      'a conta na exclusão LGPD e na exclusão definitiva, e a geração ligada a ele. Exige nota (10 a 1000 caracteres). ' +
      'Evidência de imagem (IMAGE_MINOR_BLOCKED, OUTPUT_MINOR_BLOCKED, INPUT_HELD, OUTPUT_HELD) e caso confirmado pelo ' +
      'revisor: só o revisor designado (403 para o resto); entrada ou resultado ainda em revisão: 409 (decidir pela ' +
      'checagem). Toda liberação vai para o registro de acesso antes de agir (503 sem ele). Repetir não muda nada ' +
      '(alreadyReleased: true). 400 para outro tipo de evento, 404 se não existir (admin)',
  })
  async release(
    @Param('id') id: string,
    @Body() dto: ReleaseSafetyEventDto,
    @CurrentUser() admin: JwtPayload,
    @Req() request: ReviewerRequest,
  ) {
    return this.safety.releaseMinorBlock(id, dto.note, {
      id: admin.sub,
      email: admin.email,
      ip: reviewerIpOf(request),
      reviewer: !!this.safetyConfig?.reviewerIds?.has(admin.sub),
    });
  }

  /* ─── Revisão de segurança (camada 7): só ADMIN que está em SAFETY_REVIEWER_IDS ─────────────────────────── */

  @Get('scans')
  @UseGuards(SafetyReviewerGuard)
  @UsePipes(REVIEW_PIPE)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Fila de checagens de imagem e texto (filtros verdict, stage, rule, from/to, generationId, userId, inReview; ' +
      'paginada). Nunca devolve URL nem chave de mídia: só se há mídia guardada e se está na evidência (revisor)',
  })
  async scans(@Query() query: ListSafetyScansQueryDto) {
    return this.review.listScans(query);
  }

  @Get('scans/:id/media')
  @UseGuards(SafetyReviewerGuard)
  @UsePipes(REVIEW_PIPE)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'URL assinada de 120 s da mídia da checagem (quarentena, evidência ou entrada privada). Exige motivo ' +
      '(reason, 10 a 1000 caracteres), gravado no registro de acesso ANTES da URL (revisor)',
  })
  async media(
    @Param('id') id: string,
    @Query() query: SafetyMediaQueryDto,
    @CurrentUser() reviewer: JwtPayload,
    @Req() request: ReviewerRequest,
  ) {
    return this.review.mediaUrl(
      id,
      query.reason,
      actorOf(reviewer, request),
    );
  }

  @Post('scans/:id/decision')
  @HttpCode(200)
  @UseGuards(SafetyReviewerGuard)
  @UsePipes(REVIEW_PIPE)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Decisão do revisor: release (falso positivo: entrada segurada volta à fila, resultado segurado é publicado e ' +
      'a geração conclui), confirm (evidência, sinal forte, geração segurada encerrada com estorno, resultado ' +
      'publicado retirado), report (comunicação feita: channel cnca|ncmec|safernet|outro e protocol; exige confirm ' +
      'antes). Motivo obrigatório; tudo no registro de acesso (revisor)',
  })
  async decide(
    @Param('id') id: string,
    @Body() dto: SafetyScanDecisionDto,
    @CurrentUser() reviewer: JwtPayload,
    @Req() request: ReviewerRequest,
  ) {
    return this.review.decide(
      id,
      {
        action: dto.action,
        reason: dto.reason,
        channel: dto.channel,
        protocol: dto.protocol,
      },
      actorOf(reviewer, request),
    );
  }

  @Post('users/:id/reactivate')
  @HttpCode(200)
  @UseGuards(SafetyReviewerGuard)
  @UsePipes(REVIEW_PIPE)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Reativa a conta suspensa pela camada 6 (sinal forte, pontos, repetição). Só a conta com suspensão aberta na ' +
      'trilha (409 para a desativada à mão, que sai pelo admin). Motivo obrigatório, gravado na trilha junto com a ' +
      'reativação; posts tirados do ar e o prazo da galeria não voltam sozinhos (revisor)',
  })
  async reactivate(
    @Param('id') id: string,
    @Body() dto: SafetyReactivateAccountDto,
    @CurrentUser() reviewer: JwtPayload,
    @Req() request: ReviewerRequest,
  ) {
    return this.review.reactivateAccount(
      id,
      dto.reason,
      actorOf(reviewer, request),
    );
  }

  @Get('access-log')
  @UseGuards(SafetyReviewerGuard)
  @UsePipes(REVIEW_PIPE)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Registro de acesso da revisão (quem abriu ou decidiu o quê, quando, por quê e de qual IP), só acréscimo; ' +
      'filtros actorId, action, targetType, targetId, from/to; paginado (revisor)',
  })
  async accessLog(@Query() query: SafetyAccessLogQueryDto) {
    return this.review.accessLog(query);
  }

  @Get('metrics')
  @UseGuards(SafetyReviewerGuard)
  @UsePipes(REVIEW_PIPE)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Métricas da trava (dias em UTC): bloqueios e retenções por regra e dia (agidos × sombra), checagens e ' +
      'indisponibilidade por dia, latência p50/p95 por camada, fila de revisão por idade e motivo, decisões (revisor)',
  })
  async metrics(@Query() query: SafetyMetricsQueryDto) {
    return this.review.metrics(query.days);
  }
}
