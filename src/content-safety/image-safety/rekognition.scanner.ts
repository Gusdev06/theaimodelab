import { Logger } from '@nestjs/common';
import {
  DetectFacesCommand,
  DetectFacesCommandOutput,
  DetectLabelsCommand,
  DetectLabelsCommandOutput,
  DetectModerationLabelsCommand,
  DetectModerationLabelsCommandOutput,
  RekognitionClient,
} from '@aws-sdk/client-rekognition';
import * as sharp from 'sharp';
import {
  CROP_FACE_DEDUP_IOU,
  CROP_PASS_OVERLAP,
  ILLUSTRATED_CONTENT_TYPES,
  ILLUSTRATED_MIN_CONFIDENCE,
  ImageSafetyConfig,
  PERSON_LABEL_MIN_CONFIDENCE,
  PERSON_LABELS,
  SAFETY_TIMING,
} from './image-safety.config';
import { encodeRekognitionJpeg } from './normalize';
import {
  BoundingBox,
  FaceSignal,
  LabelSignal,
  ModerationSignal,
  NormalizedImage,
  ProviderFailureKind,
  SafetyCallOptions,
  SafetyProviderUnavailableError,
  ScannerPort,
  ScannerResult,
} from './types';

/**
 * Leitor de imagem pelo AWS Rekognition (camada 3 na entrada, camada 5 no resultado). Três chamadas em paralelo com
 * os bytes do JPEG normalizado: DetectFaces (só AGE_RANGE), DetectLabels e DetectModerationLabels. Quando há pessoa
 * sem rosto (ou menos rostos que pessoas), roda a passada recortada: DetectFaces em 4 blocos ampliados.
 *
 * Falha: cada chamada tem prazo próprio; uma rodada que falha na região principal (timeout, limite, 5xx, credencial)
 * é refeita inteira, uma vez, na região reserva. Falhou nas duas = SafetyProviderUnavailableError. Nunca devolve
 * resultado parcial. Não guarda nem loga bytes, chave ou resposta inteira.
 */

const PROVIDER = 'rekognition';
/** só a idade: nenhum outro atributo do rosto é pedido */
const FACE_ATTRIBUTES = ['AGE_RANGE' as const];
const MIN_CONFIDENCE = 50;
const CONNECTION_TIMEOUT_MS = 2_000;

/** O que o scanner usa do cliente (o teste injeta um falso). */
export type RekognitionSender = Pick<RekognitionClient, 'send'>;
export type RekognitionClientFactory = (region: string) => RekognitionSender;

export interface RekognitionScannerTuning {
  /** prazo de cada chamada (padrão SAFETY_TIMING.scannerCallTimeoutMs) */
  callTimeoutMs?: number;
}

const THROTTLE_ERRORS: ReadonlySet<string> = new Set([
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  'LimitExceededException',
  'TooManyRequestsException',
]);
const AUTH_ERRORS: ReadonlySet<string> = new Set([
  'AccessDeniedException',
  'UnrecognizedClientException',
  'InvalidSignatureException',
  'ExpiredTokenException',
  'InvalidClientTokenId',
  'UnauthorizedException',
  'CredentialsProviderError',
]);
const MEDIA_ERRORS: ReadonlySet<string> = new Set([
  'InvalidImageFormatException',
  'ImageTooLargeException',
  'InvalidParameterException',
]);
const TIMEOUT_ERRORS: ReadonlySet<string> = new Set([
  'AbortError',
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
]);

/** Classifica o erro de uma chamada ao Rekognition (vai para o registro e para o alerta "porteiro cego"). */
export function classifyRekognitionError(error: unknown): ProviderFailureKind {
  if (error instanceof SafetyProviderUnavailableError) return error.failure;
  const candidate = (error ?? {}) as {
    name?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const status =
    typeof candidate.$metadata?.httpStatusCode === 'number'
      ? candidate.$metadata.httpStatusCode
      : null;
  if (TIMEOUT_ERRORS.has(name) || code === 'ETIMEDOUT') return 'timeout';
  if (THROTTLE_ERRORS.has(name) || status === 429) return 'throttled';
  if (AUTH_ERRORS.has(name) || status === 401 || status === 403) return 'auth';
  if (MEDIA_ERRORS.has(name)) return 'invalid_media';
  return 'server_error';
}

/* ------------------------------------------------------------------ conversões (puras) */

function toBox(
  box:
    | {
        Left?: number;
        Top?: number;
        Width?: number;
        Height?: number;
      }
    | undefined,
): BoundingBox | null {
  if (
    !box ||
    typeof box.Left !== 'number' ||
    typeof box.Top !== 'number' ||
    typeof box.Width !== 'number' ||
    typeof box.Height !== 'number'
  ) {
    return null;
  }
  return { left: box.Left, top: box.Top, width: box.Width, height: box.Height };
}

/** Caixa de um bloco recortado → caixa na imagem inteira. */
function remapBox(box: BoundingBox, crop: BoundingBox): BoundingBox {
  return {
    left: crop.left + box.left * crop.width,
    top: crop.top + box.top * crop.height,
    width: box.width * crop.width,
    height: box.height * crop.height,
  };
}

function invalidResponse(): SafetyProviderUnavailableError {
  return new SafetyProviderUnavailableError(PROVIDER, 'invalid_response');
}

/**
 * Rostos do DetectFaces (só idade, caixa e confiança da detecção). Rosto sem AgeRange = resposta inválida (o rosto
 * não pode ser ignorado). `crop` remapeia a caixa do bloco para a imagem inteira.
 */
export function toFaceSignals(
  response: Pick<DetectFacesCommandOutput, 'FaceDetails'>,
  crop?: BoundingBox,
): FaceSignal[] {
  return (response.FaceDetails ?? []).map((face) => {
    const low = face.AgeRange?.Low;
    const high = face.AgeRange?.High;
    if (
      typeof low !== 'number' ||
      typeof high !== 'number' ||
      !Number.isFinite(low) ||
      !Number.isFinite(high) ||
      low > high
    ) {
      throw invalidResponse();
    }
    const box = toBox(face.BoundingBox);
    return {
      ageLow: low,
      ageHigh: high,
      ageMid: (low + high) / 2,
      box: box && crop ? remapBox(box, crop) : box,
      confidence: typeof face.Confidence === 'number' ? face.Confidence : 0,
      fromCrop: crop !== undefined,
    };
  });
}

export function toLabelSignals(
  response: Pick<DetectLabelsCommandOutput, 'Labels'>,
): LabelSignal[] {
  const labels: LabelSignal[] = [];
  for (const label of response.Labels ?? []) {
    if (typeof label.Name !== 'string' || !label.Name) continue;
    labels.push({
      name: label.Name,
      confidence: typeof label.Confidence === 'number' ? label.Confidence : 0,
      instanceCount: label.Instances?.length ?? 0,
    });
  }
  return labels;
}

export function toModerationSignals(
  response: Pick<
    DetectModerationLabelsCommandOutput,
    'ModerationLabels' | 'ContentTypes'
  >,
): { moderation: ModerationSignal[]; illustrated: boolean } {
  const moderation: ModerationSignal[] = [];
  for (const label of response.ModerationLabels ?? []) {
    if (typeof label.Name !== 'string' || !label.Name) continue;
    const parent = label.ParentName ? label.ParentName : null;
    moderation.push({
      name: label.Name,
      parent,
      confidence: typeof label.Confidence === 'number' ? label.Confidence : 0,
      taxonomyLevel:
        typeof label.TaxonomyLevel === 'number'
          ? label.TaxonomyLevel
          : parent
            ? 2
            : 1,
    });
  }
  const illustrated = (response.ContentTypes ?? []).some(
    (type) =>
      typeof type.Name === 'string' &&
      ILLUSTRATED_CONTENT_TYPES.has(type.Name) &&
      typeof type.Confidence === 'number' &&
      type.Confidence >= ILLUSTRATED_MIN_CONFIDENCE,
  );
  return { moderation, illustrated };
}

/**
 * A passada recortada roda quando há rótulo de pessoa (Person, Child, Kid, Baby, Toddler) com 70 ou mais e nenhum
 * rosto, ou menos rostos que pessoas (o maior número de instâncias entre esses rótulos).
 */
export function needsCropPass(
  faces: readonly FaceSignal[],
  labels: readonly LabelSignal[],
): boolean {
  const personLabels = labels.filter(
    (label) =>
      PERSON_LABELS.has(label.name) &&
      label.confidence >= PERSON_LABEL_MIN_CONFIDENCE,
  );
  if (personLabels.length === 0) return false;
  if (faces.length === 0) return true;
  const people = Math.max(...personLabels.map((label) => label.instanceCount));
  return faces.length < people;
}

/**
 * 4 quadrantes com sobreposição (fração do lado): blocos vizinhos dividem `overlap` do lado. Caixas relativas
 * (0 a 1) alinhadas a pixel inteiro, para o recorte e o remapeamento baterem.
 */
export function cropBlocks(
  width: number,
  height: number,
  overlap = CROP_PASS_OVERLAP,
): BoundingBox[] {
  const span = (size: number): Array<[number, number]> => {
    const blockSize = Math.min(size, Math.ceil(size * (0.5 + overlap / 2)));
    return [
      [0, blockSize],
      [size - blockSize, blockSize],
    ];
  };
  const columns = span(width);
  const rows = span(height);
  const blocks: BoundingBox[] = [];
  for (const [top, blockHeight] of rows) {
    for (const [left, blockWidth] of columns) {
      blocks.push({
        left: left / width,
        top: top / height,
        width: blockWidth / width,
        height: blockHeight / height,
      });
    }
  }
  return blocks;
}

function intersectionOverUnion(a: BoundingBox, b: BoundingBox): number {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function isYounger(a: FaceSignal, b: FaceSignal): boolean {
  return a.ageMid < b.ageMid || (a.ageMid === b.ageMid && a.ageLow < b.ageLow);
}

/**
 * Junta os rostos da passada recortada aos da imagem inteira sem duplicar: IoU acima de `iou` = mesmo rosto (os
 * blocos se sobrepõem, então o mesmo rosto também pode vir de dois blocos). No mesmo rosto vale a estimativa mais
 * jovem (na dúvida, a mais segura). Rosto sem caixa nunca é descartado.
 */
export function dedupeFaces(
  base: readonly FaceSignal[],
  extra: readonly FaceSignal[],
  iou = CROP_FACE_DEDUP_IOU,
): FaceSignal[] {
  const merged = [...base];
  for (const face of extra) {
    const box = face.box;
    const sameIndex = box
      ? merged.findIndex(
          (other) =>
            other.box !== null && intersectionOverUnion(other.box, box) > iou,
        )
      : -1;
    if (sameIndex === -1) {
      merged.push(face);
    } else if (isYounger(face, merged[sameIndex])) {
      merged[sameIndex] = face;
    }
  }
  return merged;
}

/* ------------------------------------------------------------------ scanner */

interface RoundResult {
  faces: FaceSignal[];
  labels: LabelSignal[];
  moderation: ModerationSignal[];
  illustrated: boolean;
  cropPassRan: boolean;
}

class RoundAbortedError extends Error {
  constructor() {
    super('checagem cancelada');
    this.name = 'AbortError';
  }
}

export class RekognitionScanner implements ScannerPort {
  readonly name = PROVIDER;
  private readonly logger = new Logger(RekognitionScanner.name);
  private readonly clients = new Map<string, RekognitionSender>();
  private readonly clientFactory: RekognitionClientFactory;
  private readonly callTimeoutMs: number;

  constructor(
    private readonly config: ImageSafetyConfig,
    clientFactory?: RekognitionClientFactory,
    tuning: RekognitionScannerTuning = {},
  ) {
    this.callTimeoutMs =
      tuning.callTimeoutMs && tuning.callTimeoutMs > 0
        ? tuning.callTimeoutMs
        : SAFETY_TIMING.scannerCallTimeoutMs;
    this.clientFactory =
      clientFactory ??
      ((region) =>
        new RekognitionClient({
          region,
          // null = cadeia padrão do SDK (env AWS_*, perfil, papel da máquina)
          credentials: config.awsCredentials ?? undefined,
          maxAttempts: 2,
          requestHandler: {
            requestTimeout: this.callTimeoutMs,
            connectionTimeout: CONNECTION_TIMEOUT_MS,
          },
        }));
  }

  async detect(
    image: NormalizedImage,
    options: SafetyCallOptions = {},
  ): Promise<ScannerResult> {
    if (!image?.jpeg?.length || !(image.width > 0) || !(image.height > 0)) {
      throw new SafetyProviderUnavailableError(PROVIDER, 'invalid_media');
    }
    const startedAt = Date.now();
    const deadline =
      options.timeoutMs && options.timeoutMs > 0
        ? startedAt + options.timeoutMs
        : null;
    const regions = [
      this.config.rekognitionRegion,
      ...(this.config.rekognitionFallbackRegion
        ? [this.config.rekognitionFallbackRegion]
        : []),
    ];

    let lastFailure: ProviderFailureKind = 'server_error';
    let lastRegion: string | null = null;
    for (const region of regions) {
      if (options.signal?.aborted || (deadline && Date.now() >= deadline)) {
        break;
      }
      try {
        const round = await this.runRound(
          region,
          image,
          deadline,
          options.signal,
        );
        return {
          ...round,
          scanner: PROVIDER,
          region,
          latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        lastFailure = options.signal?.aborted
          ? 'timeout'
          : classifyRekognitionError(error);
        lastRegion = region;
        // arquivo recusado não melhora em outra região; cancelamento de quem chamou também não
        if (lastFailure === 'invalid_media' || options.signal?.aborted) break;
        if (region !== regions[regions.length - 1]) {
          this.logger.warn(
            `Rekognition em ${region} falhou (${lastFailure}); tentando a região reserva`,
          );
        }
      }
    }
    if (lastRegion === null) {
      // nenhuma rodada começou: prazo de quem chamou já tinha acabado
      throw new SafetyProviderUnavailableError(
        PROVIDER,
        'timeout',
        this.config.rekognitionRegion,
      );
    }
    throw new SafetyProviderUnavailableError(PROVIDER, lastFailure, lastRegion);
  }

  private client(region: string): RekognitionSender {
    let client = this.clients.get(region);
    if (!client) {
      client = this.clientFactory(region);
      this.clients.set(region, client);
    }
    return client;
  }

  /** Uma chamada com prazo próprio (o menor entre o da chamada e o que sobra do prazo total). */
  private async call<T>(
    region: string,
    command:
      | DetectFacesCommand
      | DetectLabelsCommand
      | DetectModerationLabelsCommand,
    deadline: number | null,
    outer: AbortSignal | undefined,
  ): Promise<T> {
    const remaining = deadline ? deadline - Date.now() : this.callTimeoutMs;
    const timeoutMs = Math.min(this.callTimeoutMs, remaining);
    if (timeoutMs <= 0 || outer?.aborted) throw new RoundAbortedError();
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    outer?.addEventListener('abort', onOuterAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      const sent = this.client(region).send(command as never, {
        abortSignal: controller.signal,
      }) as Promise<T>;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new RoundAbortedError());
        }, timeoutMs);
      });
      return await Promise.race([sent, timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    }
  }

  /** Uma rodada numa região: a 1ª chamada que falha cancela as outras (nada de resultado parcial). */
  private async runRound(
    region: string,
    image: NormalizedImage,
    deadline: number | null,
    outer: AbortSignal | undefined,
  ): Promise<RoundResult> {
    const round = new AbortController();
    const onOuterAbort = () => round.abort();
    if (outer?.aborted) round.abort();
    outer?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      return await this.readAll(region, image, deadline, round.signal);
    } catch (error) {
      round.abort();
      throw error;
    } finally {
      outer?.removeEventListener('abort', onOuterAbort);
    }
  }

  private async readAll(
    region: string,
    image: NormalizedImage,
    deadline: number | null,
    outer: AbortSignal,
  ): Promise<RoundResult> {
    const bytes = { Bytes: image.jpeg };
    const [facesOutput, labelsOutput, moderationOutput] = await Promise.all([
      this.call<DetectFacesCommandOutput>(
        region,
        new DetectFacesCommand({ Image: bytes, Attributes: FACE_ATTRIBUTES }),
        deadline,
        outer,
      ),
      this.call<DetectLabelsCommandOutput>(
        region,
        new DetectLabelsCommand({
          Image: bytes,
          MinConfidence: MIN_CONFIDENCE,
          Features: ['GENERAL_LABELS'],
        }),
        deadline,
        outer,
      ),
      this.call<DetectModerationLabelsCommandOutput>(
        region,
        new DetectModerationLabelsCommand({
          Image: bytes,
          MinConfidence: MIN_CONFIDENCE,
        }),
        deadline,
        outer,
      ),
    ]);

    let faces = toFaceSignals(facesOutput ?? {});
    const labels = toLabelSignals(labelsOutput ?? {});
    const { moderation, illustrated } = toModerationSignals(
      moderationOutput ?? {},
    );

    const cropPassRan = needsCropPass(faces, labels);
    if (cropPassRan) {
      const cropFaces = await this.cropPass(region, image, deadline, outer);
      faces = dedupeFaces(faces, cropFaces);
    }
    return { faces, labels, moderation, illustrated, cropPassRan };
  }

  /** DetectFaces em cada bloco ampliado até 1920 px; caixas remapeadas para a imagem inteira. */
  private async cropPass(
    region: string,
    image: NormalizedImage,
    deadline: number | null,
    outer: AbortSignal,
  ): Promise<FaceSignal[]> {
    const blocks = cropBlocks(image.width, image.height);
    const perBlock = await Promise.all(
      blocks.map(async (block) => {
        const crop = await this.renderBlock(image, block);
        const output = await this.call<DetectFacesCommandOutput>(
          region,
          new DetectFacesCommand({
            Image: { Bytes: crop },
            Attributes: FACE_ATTRIBUTES,
          }),
          deadline,
          outer,
        );
        return toFaceSignals(output ?? {}, block);
      }),
    );
    return dedupeFaces([], perBlock.flat());
  }

  /** Recorta o bloco do JPEG normalizado e amplia até 1920 px. Falha aqui é arquivo ruim, não fornecedor fora. */
  private async renderBlock(
    image: NormalizedImage,
    block: BoundingBox,
  ): Promise<Buffer> {
    try {
      const left = Math.min(
        image.width - 1,
        Math.round(block.left * image.width),
      );
      const top = Math.min(
        image.height - 1,
        Math.round(block.top * image.height),
      );
      const { data, info } = await sharp(image.jpeg)
        .extract({
          left,
          top,
          width: Math.max(
            1,
            Math.min(image.width - left, Math.round(block.width * image.width)),
          ),
          height: Math.max(
            1,
            Math.min(
              image.height - top,
              Math.round(block.height * image.height),
            ),
          ),
        })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const encoded = await encodeRekognitionJpeg(
        {
          data,
          width: info.width,
          height: info.height,
          channels: info.channels,
        },
        { enlarge: true },
      );
      return encoded.jpeg;
    } catch {
      throw new SafetyProviderUnavailableError(PROVIDER, 'invalid_media');
    }
  }
}
