import { createHash } from 'crypto';
import { assessText } from '../../content-safety/minor-guard';
import {
  RefinedPromptMinorBlockError,
  UnverifiedContentBlockError,
} from '../errors/content-safety.error';

/**
 * Peças puras (sem rede, sem banco) da guarda que roda antes de todo desvio depois de uma recusa do provedor
 * (GenerationProcessor.assertSafetyFallbackAllowed e retryWithRefinedPrompt), e dos logs sem o texto do pedido nem
 * a URL assinada. Ficam fora do processor para o conflito com a PR API #3, que reescreve o despacho, continuar
 * pequeno. Na #3, o generation-fallback.ts usa esta mesma lista de mídia (jobCarriesUserMedia), nunca uma cópia.
 */

/** Campos do job que levam UMA mídia do usuário (URL de foto, frame, vídeo ou áudio). */
const SINGLE_MEDIA_KEYS = [
  'imageUrl',
  'videoUrl',
  'sourceImageUrl',
  'targetImageUrl',
  'firstFrameUrl',
  'lastFrameUrl',
  'lastImageUrl',
  'audioUrl',
] as const;

/** Campos do job que levam uma LISTA de URLs de mídia do usuário (fotos, referências, vídeos, áudios). */
const MEDIA_URL_LIST_KEYS = [
  'imageUrls',
  'referenceImageUrls',
  'referenceVideoUrls',
  'referenceAudioUrls',
] as const;

/** Clipes do Omni: lista de objetos `{ url, start, ends }`. */
const MEDIA_CLIP_LIST_KEY = 'videoList';

/** Marcadores booleanos que o serviço grava no job quando o pedido trouxe mídia. */
const MEDIA_FLAG_KEYS = ['hasInputImages', 'hasVideoInput'] as const;

/**
 * O job leva foto, frame, referência, vídeo ou áudio enviado pelo usuário? Lê o dado sem tipo do BullMQ. Falso não
 * prova que não há mídia: a guarda também olha as imagens guardadas da geração e o atestado.
 */
export function jobCarriesUserMedia(jobData: unknown): boolean {
  if (!jobData || typeof jobData !== 'object') return false;
  const data = jobData as Record<string, unknown>;
  if (MEDIA_FLAG_KEYS.some((key) => data[key] === true)) return true;
  if (
    SINGLE_MEDIA_KEYS.some((key) => {
      const value = data[key];
      return typeof value === 'string' && value.trim() !== '';
    })
  ) {
    return true;
  }
  return [...MEDIA_URL_LIST_KEYS, MEDIA_CLIP_LIST_KEY].some((key) => {
    const value = data[key];
    return Array.isArray(value) && value.length > 0;
  });
}

/**
 * Cópia do job com cada URL de mídia do usuário trocada por `refresh(url)` (campos de jobCarriesUserMedia, inclusive
 * a `url` dos clipes do Omni). O resto do job e o que não é texto ficam iguais; o job original não muda.
 */
export async function withRefreshedMediaUrls<T>(
  jobData: T,
  refresh: (url: string) => Promise<string>,
): Promise<T> {
  if (!jobData || typeof jobData !== 'object' || Array.isArray(jobData)) {
    return jobData;
  }
  const data = jobData as Record<string, unknown>;
  const copy: Record<string, unknown> = { ...data };
  const refreshText = async (value: unknown): Promise<unknown> =>
    typeof value === 'string' && value.trim() !== '' ? refresh(value) : value;

  for (const key of SINGLE_MEDIA_KEYS) {
    if (key in data) copy[key] = await refreshText(data[key]);
  }
  for (const key of MEDIA_URL_LIST_KEYS) {
    const list = data[key];
    if (Array.isArray(list))
      copy[key] = await Promise.all(list.map(refreshText));
  }
  const clips = data[MEDIA_CLIP_LIST_KEY];
  if (Array.isArray(clips)) {
    copy[MEDIA_CLIP_LIST_KEY] = await Promise.all(
      clips.map(async (clip: unknown) => {
        if (!clip || typeof clip !== 'object') return clip;
        const { url } = clip as { url?: unknown };
        return typeof url === 'string'
          ? {
              ...(clip as Record<string, unknown>),
              url: await refreshText(url),
            }
          : clip;
      }),
    );
  }
  return copy as T;
}

export type RefinedPromptVerdict =
  | { status: 'ok' }
  /** a trava acusou menor de idade: termo ou idade que disparou */
  | { status: 'minor'; match: string | undefined }
  /** a trava não conseguiu ler o texto (alfabeto sem lista, texto grande demais): não vai ao provedor */
  | { status: 'unchecked' };

/**
 * O prompt reescrito pelo agente refinador passa pela mesma trava de texto da API (minor-guard) antes de ir ao
 * provedor: o LLM pode reintroduzir o que o pedido original disfarçava. Onda 1: o classificador semântico entra
 * aqui também.
 */
export function checkRefinedPrompt(
  refinedPrompt: string,
): RefinedPromptVerdict {
  const assessment = assessText(refinedPrompt);
  if (!assessment.blocked) return { status: 'ok' };
  if (assessment.reason === 'size' || assessment.reason === 'script') {
    return { status: 'unchecked' };
  }
  return { status: 'minor', match: assessment.match };
}

/**
 * Bloqueio terminal para o prompt reescrito, ou null quando ele pode ir ao provedor. Nada acusado aqui vai ao
 * provedor; muda só como a geração é encerrada e registrada:
 *  - a trava acusa menor na reescrita e TAMBÉM no pedido original → RefinedPromptMinorBlockError (CONTENT_POLICY_MINOR,
 *    MINOR_BLOCKED como `refiner:<modelo>` com o termo do original). Só acontece se o original escapou da trava de
 *    entrada (rota sem o interceptor, job antigo);
 *  - a trava acusa só a reescrita (o original passou) → UnverifiedContentBlockError `refiner_flagged`
 *    (CONTENT_SAFETY_BLOCKED, sem evento de menor): o termo foi escrito pelo NOSSO refinador ("garota de 25 anos"
 *    vira "young girl"), e acusar a cliente de pedir menor travaria a exclusão LGPD dela pela guarda legal;
 *  - texto que a trava não lê → UnverifiedContentBlockError `refiner_unchecked` (CONTENT_SAFETY_BLOCKED).
 */
export function refinedPromptBlockOf(
  refinedPrompt: string,
  originalPrompt: string,
): RefinedPromptMinorBlockError | UnverifiedContentBlockError | null {
  const verdict = checkRefinedPrompt(refinedPrompt);
  if (verdict.status === 'ok') return null;
  if (verdict.status === 'unchecked') {
    return new UnverifiedContentBlockError(
      'refined prompt not checkable by the text guard',
      '',
      'refiner_unchecked',
    );
  }
  const original = checkRefinedPrompt(originalPrompt);
  if (original.status === 'minor') {
    return new RefinedPromptMinorBlockError(original.match);
  }
  return new UnverifiedContentBlockError(
    'refined prompt flagged by the text guard; original prompt passed',
    '',
    'refiner_flagged',
    verdict.match,
  );
}

/**
 * Identifica um texto no log sem gravá-lo: tamanho e sha256 do texto normalizado (NFC, espaços colapsados, sem
 * diferença de caixa). Dá para correlacionar repetições sem expor o pedido da cliente.
 */
export function textFingerprintForLog(text: string | null | undefined): string {
  const normalized = (text ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex');
  return `len=${normalized.length} sha256=${digest}`;
}

/**
 * URL de mídia no log: só origem e caminho. A query sai (a URL assinada da entrada privada leva X-Amz-Signature e
 * baixa a foto enquanto vale) e `data:` nunca entra (é a própria mídia).
 */
export function mediaUrlForLog(url: string | null | undefined): string {
  if (!url) return 'none';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid-url';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `${parsed.protocol}…`;
  }
  return `${parsed.origin}${parsed.pathname}`;
}

/** Texto do pedido mais curto que isso não é trocado na mensagem (trocaria pedaços de palavras comuns). */
const MIN_REQUEST_TEXT_TO_REDACT = 8;
/** Tamanho máximo da mensagem do provedor no log. */
const PROVIDER_MESSAGE_LOG_MAX = 300;

/**
 * Mensagem de erro de provedor para o log. O provedor às vezes repete o prompt na mensagem, e o erro de download
 * traz a URL assinada. Então: cada texto do pedido vira a impressão digital dele, a query de toda URL sai, `data:`
 * vira marcador, espaços colapsam e o texto é cortado. Ainda serve para depurar a falha.
 */
export function providerMessageForLog(
  error: unknown,
  requestTexts: ReadonlyArray<string | null | undefined> = [],
): string {
  let text =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error ?? '');
  for (const requestText of requestTexts) {
    const needle = requestText?.trim();
    if (!needle || needle.length < MIN_REQUEST_TEXT_TO_REDACT) continue;
    text = text.split(needle).join(`<pedido ${textFingerprintForLog(needle)}>`);
  }
  text = text
    .replace(/\bdata:[^\s"'<>]*/gi, 'data:…')
    .replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > PROVIDER_MESSAGE_LOG_MAX
    ? `${text.slice(0, PROVIDER_MESSAGE_LOG_MAX)}…(+${text.length - PROVIDER_MESSAGE_LOG_MAX})`
    : text;
}

/** Textos do pedido que o job leva (prompt, negativo, texto da voz): o que providerMessageForLog tira da mensagem. */
export function requestTextsOfJob(jobData: unknown): string[] {
  if (!jobData || typeof jobData !== 'object') return [];
  const data = jobData as Record<string, unknown>;
  return ['prompt', 'negativePrompt', 'text']
    .map((key) => data[key])
    .filter((value): value is string => typeof value === 'string');
}

/**
 * Pilha do erro para o log sem a mensagem (a 1ª linha da pilha repete a mensagem crua do provedor): nome + quadros.
 * Undefined quando não há quadros.
 */
export function stackFramesForLog(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.stack) return undefined;
  const firstFrame = error.stack.search(/\n\s+at\s/);
  return firstFrame === -1
    ? undefined
    : `${error.name}${error.stack.slice(firstFrame)}`;
}
