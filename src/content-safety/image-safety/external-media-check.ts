import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ContentSafetyEventKind, type GenerationType } from '@prisma/client';
import { BusinessException } from '../../common/exceptions/business.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadsService } from '../../uploads/uploads.service';
import { ContentSafetyService } from '../content-safety.service';
import { STRIKES, type StrikesPort } from '../strikes/strikes.types';
import { SAFETY_TIMING } from './image-safety.config';
import type { RuledInputVerdict } from './image-safety.rules';
import { ImageSafetyService } from './image-safety.service';
import { sha256Hex } from './normalize';
import type { MediaKind, SafetyTool, StorageArea, Strength } from './types';

/**
 * Checagem da mídia do usuário nas rotas que chamam um cliente externo FORA da fila (Clone de Prompt e o plano B dele,
 * construtor de influencer, Turbinar com imagens, análise de marca, avatar da HeyGen). Chamar ANTES de qualquer
 * cliente externo de visão, com os bytes exatos que vão sair.
 *
 * Com IMAGE_SAFETY_MODE=off não lê nada e não chama ninguém (o comportamento de hoje). Ligada:
 *  - checagem síncrona (ImageSafetyService.checkInput, 5 s por padrão);
 *  - não deu para checar (fornecedor fora, prazo estourado, erro) = 503 genérico, e a mídia não segue;
 *  - barrada ou segurada = 422 com o mesmo código e texto de toda regra de imagem (o motivo fica só no registro).
 *    Rota sem fila não tem como segurar para revisão: a retenção (E3a) vira bloqueio, com a mídia na evidência, o
 *    evento gravado e o ponto médio da camada 6, como na retenção da fila.
 * Que regra age em cada modo é decisão do ImageSafetyService.actsOn (a mesma da fila).
 */

/** Uma mídia que vai a um cliente externo: os bytes que vão sair e, quando ela está guardada, onde. */
export interface ExternalMedia {
  kind: MediaKind;
  mimeType: string | null;
  buffer: Buffer;
  /** objeto guardado de onde os bytes vieram: a evidência sai dele e o caso leve o apaga */
  area?: StorageArea;
  key?: string | null;
}

/** Quem pede e para quê, deduzido no servidor (nunca de campo que o site manda). */
export interface ExternalRequest {
  userId: string | null;
  tool: SafetyTool;
  /** modelo que recebe a mídia, quando conta para a regra (sem censura = pedido sexual) */
  model?: string | null;
  prompt?: string | null;
  negativePrompt?: string | null;
  type?: GenerationType | null;
  /** prazo da checagem; padrão SAFETY_TIMING.syncCheckTimeoutMs (vídeo pede mais) */
  timeoutMs?: number;
}

/** Mídia pronta ou montada só quando a checagem está ligada (com o modo off, nada é decodificado). */
export type ExternalMediaSource =
  | readonly ExternalMedia[]
  | (() => readonly ExternalMedia[] | Promise<readonly ExternalMedia[]>);

/** Folga sobre o prazo da checagem para gravar registro e evidência antes de desistir com 503. */
const SYNC_CHECK_GRACE_MS = 3_000;

/** Imagens embutidas nas partes de uma conversa com modelo de visão (formato do chat do Gemini e do plano B). */
export function inlineImagesOf(
  parts: ReadonlyArray<{ inline_data?: { base64: string; mime_type: string } }>,
): ExternalMedia[] {
  return parts
    .filter((part) => !!part.inline_data?.base64)
    .map((part) => ({
      kind: 'image' as const,
      mimeType: part.inline_data!.mime_type || null,
      buffer: Buffer.from(part.inline_data!.base64, 'base64'),
    }));
}

class SyncCheckDeadlineError extends Error {
  constructor() {
    super('checagem síncrona passou do prazo');
    this.name = 'SyncCheckDeadlineError';
  }
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SyncCheckDeadlineError()), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Regra e força para o evento e o log (E7 com a regra do quadro). Nunca texto do pedido. */
function matchOf(verdict: {
  ruleId: string | null;
  strength: Strength | string;
  cause?: string;
}): string {
  const rule =
    verdict.ruleId === 'E7' && verdict.cause
      ? `E7:${verdict.cause}`
      : (verdict.ruleId ?? 'sem-regra');
  return `${rule}/${verdict.strength}`.slice(0, 80);
}

@Injectable()
export class ExternalMediaCheck {
  private readonly logger = new Logger(ExternalMediaCheck.name);

  constructor(
    private readonly imageSafety: ImageSafetyService,
    private readonly uploads: UploadsService,
    private readonly contentSafety: ContentSafetyService,
    private readonly prisma: PrismaService,
    /** camada 6: o bloqueio da checagem já pontua lá dentro; aqui só a retenção convertida em bloqueio */
    @Optional()
    @Inject(STRIKES)
    private readonly strikes: StrikesPort | null = null,
  ) {}

  /** Checagem de imagem ligada (shadow ou enforce)? Com off, assertSafe não faz nada. */
  get enabled(): boolean {
    return this.imageSafety.imageEnabled;
  }

  /**
   * Lança 422 (IMAGE_SAFETY_BLOCKED) ou 503 (SAFETY_CHECK_UNAVAILABLE) quando a mídia não pode sair; senão devolve o
   * veredito (null com a checagem desligada ou sem mídia visual). GRAY segue: quem chama pode ler as restrições.
   */
  async assertSafe(
    source: ExternalMediaSource,
    request: ExternalRequest,
  ): Promise<RuledInputVerdict | null> {
    if (!this.enabled) return null;
    const media = (typeof source === 'function' ? await source() : source).filter(
      (item) => item.kind !== 'audio' && item.buffer.length > 0,
    );
    if (media.length === 0) return null;

    const timeoutMs = request.timeoutMs ?? SAFETY_TIMING.syncCheckTimeoutMs;
    const startedAt = new Date();
    const work = this.imageSafety.checkInput(
      media.map((item) => ({
        kind: item.kind,
        mimeType: item.mimeType,
        area: item.key ? item.area : undefined,
        key: item.key ?? null,
        buffer: item.buffer,
      })),
      {
        userId: request.userId,
        generationId: null,
        model: request.model ?? null,
        tool: request.tool,
        type: request.type ?? null,
        hasUserMedia: true,
        sexual: { classifier: null, inputNudity: null },
        prompt: request.prompt ?? null,
        negativePrompt: request.negativePrompt ?? null,
      },
      { timeoutMs },
    );
    let verdict: RuledInputVerdict;
    try {
      verdict = await withDeadline(work, timeoutMs + SYNC_CHECK_GRACE_MS);
    } catch (error) {
      if (error instanceof SyncCheckDeadlineError) {
        this.preserveLateHold(work, media, request, startedAt);
      }
      this.logger.warn(
        `[IMAGE_SAFETY] ${request.tool}: checagem síncrona falhou (${(error as Error).message?.slice(0, 200)}) — mídia não enviada`,
      );
      throw new BusinessException('SAFETY_CHECK_UNAVAILABLE');
    }

    if (verdict.verdict === 'CLEAN' || !this.imageSafety.actsOn(verdict)) {
      return verdict;
    }
    if (verdict.verdict === 'UNAVAILABLE') {
      this.logger.warn(
        `[IMAGE_SAFETY] ${request.tool}: checagem indisponível — mídia não enviada`,
      );
      throw new BusinessException('SAFETY_CHECK_UNAVAILABLE');
    }
    if (verdict.verdict === 'GRAY') return verdict;

    // BLOCK: evidência, lista de bloqueio e evento já gravados pela checagem. HOLD (e HOLD ao lado de um BLOCK):
    // a retenção vira bloqueio aqui, com a mídia segurada na evidência
    await this.preserveHeld(media, request, startedAt);
    this.logger.warn(
      `[IMAGE_SAFETY] ${request.tool}: mídia barrada antes do cliente externo (${matchOf(verdict)})`,
    );
    throw new BusinessException('IMAGE_SAFETY_BLOCKED');
  }

  /**
   * O prazo venceu, mas a checagem segue rodando (as gravações não respeitam o cancelamento). Se ela terminar com
   * retenção agindo, a evidência, o evento e o ponto saem em segundo plano: os bytes só existem na memória deste pedido
   * e sem isso a foto segurada se perderia. A resposta continua o 503 de agora. Nunca lança.
   */
  private preserveLateHold(
    work: Promise<RuledInputVerdict>,
    media: readonly ExternalMedia[],
    request: ExternalRequest,
    startedAt: Date,
  ): void {
    void work
      .then(async (late) => {
        if (late.verdict !== 'HOLD' && late.verdict !== 'BLOCK') return;
        if (!this.imageSafety.actsOn(late)) return;
        await this.preserveHeld(media, request, startedAt);
        this.logger.warn(
          `[IMAGE_SAFETY] ${request.tool}: checagem terminou depois do prazo (${matchOf(late)}) — retenção guardada em segundo plano`,
        );
      })
      .catch((error: unknown) =>
        this.logger.error(
          `[IMAGE_SAFETY] ${request.tool}: checagem depois do prazo não guardou a retenção (${(error as Error).message?.slice(0, 200)})`,
        ),
      );
  }

  /**
   * Mídia que a checagem SEGUROU (sinal médio) numa rota sem fila: vai para a evidência, a checagem ganha a chave, o
   * evento IMAGE_MINOR_BLOCKED é gravado (entra na guarda legal) e a camada 6 conta o ponto. Falha vira log: a decisão
   * já foi tomada e a mídia não sai de jeito nenhum.
   */
  private async preserveHeld(
    media: readonly ExternalMedia[],
    request: ExternalRequest,
    startedAt: Date,
  ): Promise<void> {
    const bySha = new Map<string, ExternalMedia>();
    for (const item of media) bySha.set(sha256Hex(item.buffer), item);
    let held: Array<{
      sha256: string | null;
      phash: string | null;
      ruleId: string | null;
      strength: Strength;
    }>;
    try {
      held = await this.prisma.contentSafetyScan.findMany({
        where: {
          generationId: null,
          userId: request.userId,
          sha256: { in: [...bySha.keys()] },
          verdict: 'HOLD',
          enforced: true,
          createdAt: { gte: startedAt },
        },
        select: { sha256: true, phash: true, ruleId: true, strength: true },
      });
    } catch (error) {
      this.logger.error(
        `[IMAGE_SAFETY] ${request.tool}: mídia segurada não localizada no registro (${(error as Error).message?.slice(0, 200)}) — sem evidência desta vez`,
      );
      return;
    }
    if (held.length === 0) return;

    const done = new Set<string>();
    for (const row of held) {
      if (!row.sha256 || done.has(row.sha256)) continue;
      done.add(row.sha256);
      const item = bySha.get(row.sha256);
      if (!item) continue;
      try {
        const evidenceKey =
          item.area && item.key
            ? await this.uploads.moveToEvidence(item.area, item.key, row.sha256, {
                body: item.buffer,
                contentType: item.mimeType,
              })
            : await this.uploads.storeEvidence(
                item.buffer,
                item.mimeType ?? 'application/octet-stream',
                row.sha256,
                'media',
              );
        await this.prisma.contentSafetyScan.updateMany({
          where: {
            generationId: null,
            userId: request.userId,
            sha256: row.sha256,
            verdict: 'HOLD',
            evidenceKey: null,
            createdAt: { gte: startedAt },
          },
          data: { evidenceKey },
        });
      } catch (error) {
        this.logger.error(
          `[IMAGE_SAFETY] ${request.tool}: mídia segurada não foi para a evidência (${(error as Error).message?.slice(0, 200)})`,
        );
      }
    }
    const match = matchOf(held[0]);
    const eventId = await this.contentSafety.record({
      userId: request.userId,
      kind: ContentSafetyEventKind.IMAGE_MINOR_BLOCKED,
      route: `input:${request.tool}`,
      match,
      excerpt: null,
      generationId: null,
    });
    if (!this.strikes?.enabled || !request.userId) return;
    try {
      await this.strikes.applySignal(request.userId, held[0].strength, eventId, {
        layer: 'input',
        match,
        generationId: null,
        photos: held.map((row) => ({ phash: row.phash, sha256: row.sha256, blockId: null })),
      });
    } catch (error) {
      this.logger.error(
        `[IMAGE_SAFETY] ${request.tool}: ponto da retenção não aplicado (${(error as Error).message?.slice(0, 200)})`,
      );
    }
  }
}
