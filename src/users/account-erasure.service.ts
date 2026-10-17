import {
  BadRequestException,
  BeforeApplicationShutdown,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AvatarStatus,
  CommunityPostStatus,
  ContentReportCategory,
  ContentReportStatus,
  ContentSafetyEventKind,
  GenerationStatus,
  Prisma,
  Subscription,
  SubscriptionStatus,
  UserRole,
} from '@prisma/client';
import {
  ACTIVE_USER_CACHE_TTL_MS,
  invalidateActiveUser,
} from '../auth/strategies/jwt.strategy';
import { HeyGenProvider } from '../avatars/providers/heygen.provider';
import { assessText } from '../content-safety/minor-guard';
import { IMAGE_EVIDENCE_EVENT_KINDS } from '../content-safety/safety-event-kinds';
import { minimizeAccountScans } from '../content-safety/image-safety/scan-retention';
import { AsaasSubscriptionsService } from '../payments/asaas-subscriptions.service';
import { CaktoApiService } from '../payments/cakto-api.service';
import { StripeService } from '../payments/stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageDeleteError, UploadsService } from '../uploads/uploads.service';

// ─── Valores que ficam no lugar dos dados da pessoa ──────────────────────────

export const ERASED_USER_NAME = 'Conta excluída';
export const ERASED_AFFILIATE_NAME = 'Afiliado excluído';
export const ERASED_AVATAR_NAME = 'Avatar excluído';
export const ERASED_VOICE_NAME = 'Voz excluída';
export const ERASED_WORKSPACE_NAME = 'Quadro excluído';
export const ERASED_VIDEO_PROJECT_NAME = 'Projeto excluído';

/** E-mail que substitui o da pessoa: único por conta e num domínio que nunca recebe e-mail. */
export function erasedEmailFor(userId: string): string {
  return `erased+${userId}@invalid.local`;
}

// ─── Regras ──────────────────────────────────────────────────────────────────

/** Assinatura que ainda pode renovar ou cobrar. */
const RUNNING_SUBSCRIPTION: ReadonlySet<SubscriptionStatus> = new Set([
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.TRIALING,
]);
const IN_FLIGHT_GENERATION: ReadonlySet<GenerationStatus> = new Set([
  GenerationStatus.PENDING,
  GenerationStatus.PROCESSING,
]);
const ENDED_PIX_AUTHORIZATION = new Set(['CANCELED', 'EXPIRED', 'REJECTED']);

/**
 * Denúncia destas categorias (aberta, em análise, ou confirmada até a evidência ser liberada) segura a conta inteira:
 * é evidência para as autoridades. Uso de imagem só segura quando quem denuncia é a própria pessoa retratada.
 */
const HOLD_CATEGORIES: ReadonlySet<ContentReportCategory> = new Set([
  ContentReportCategory.MINOR,
  ContentReportCategory.ILLEGAL,
  ContentReportCategory.NON_CONSENSUAL,
]);
/**
 * Bloqueios por menor de idade de pedido só com texto (filtro de texto, ou recusa do provedor sem foto/vídeo enviado)
 * que seguram a conta: a partir de 3 TENTATIVAS distintas em 90 dias (ver countMinorAttempts).
 */
export const MINOR_BLOCKED_HOLD_THRESHOLD = 3;
export const MINOR_BLOCKED_WINDOW_DAYS = 90;
/**
 * Janelas de uma tentativa (as mesmas do cockpit): o mesmo trecho em até 10 min é o mesmo pedido (as gerações em
 * paralelo de um clique e o reenvio na hora); bloqueio sem trecho só se junta à tentativa aberta há até 2 min.
 */
export const MINOR_SAME_TEXT_WINDOW_MS = 10 * 60_000;
export const MINOR_ATTEMPT_WINDOW_MS = 2 * 60_000;
/**
 * Rota gravada quando o provedor de IA recusou o pedido por detectar menor de idade (`provider:<modelo>`). Com foto ou
 * vídeo enviado pela conta na geração, é evidência da própria mídia: segura a conta com 1 só, sem prazo, e o
 * ignoreSafetyEvents não libera (só o jurídico, evento por evento, em PATCH /admin/content-safety/events/:id/release).
 * Pedido só com texto conta junto com os bloqueios do filtro de texto (tentativas, 90 dias, ignoreSafetyEvents vale).
 */
export const PROVIDER_MINOR_ROUTE_PREFIX = 'provider:';
/** O admin só pode ignorar os bloqueios (nunca denúncia) com um motivo de verdade. */
export const SAFETY_OVERRIDE_REASON_MIN_LENGTH = 10;
/** Código do 409 da exclusão definitiva (DELETE /admin/users/:id) de uma conta sob guarda legal. */
export const ACCOUNT_LEGAL_HOLD_CODE = 'ACCOUNT_LEGAL_HOLD';
const REPORT_SCAN_PAGE = 1000;
/**
 * Folga da 2ª passada das denúncias (dentro da transação): denúncia criada ou alterada desde um pouco antes da 1ª
 * passada é relida, para um relógio de outra instância um pouco atrás não deixar nenhuma de fora.
 */
const REPORT_RECHECK_MARGIN_MS = 5 * 60_000;
const MAX_HOLD_REASON_LINES = 20;
/** O JwtStrategy confere se a conta está ativa com cache curto: sessão aberta funciona até ele vencer. */
const SESSION_CHECK_MINUTES = Math.max(
  1,
  Math.ceil(ACTIVE_USER_CACHE_TTL_MS / 60_000),
);
/** Motivo gravado nos posts da comunidade tirados do ar pela guarda legal (a linha fica como evidência). */
export const LEGAL_HOLD_POST_REJECTION_REASON = 'legal_hold';
/** Posts que a guarda tira do ar: publicados e os que ainda esperam aprovação (não podem ir ao ar depois). */
const VISIBLE_POST_STATUSES: CommunityPostStatus[] = [
  CommunityPostStatus.APPROVED,
  CommunityPostStatus.PENDING,
];

/** Pastas de cada geração no bucket (o UploadsService grava em `<pasta>/<id da geração>/<uuid>/<arquivo>`). */
export const GENERATION_STORAGE_ROOTS = [
  'generations',
  'outputs',
  'thumbnails',
  'inputs',
  'samples',
] as const;
const ID_SEGMENT = /^[A-Za-z0-9_-]{10,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Toda pasta apagada tem a forma `<raiz conhecida>/<id>/`: nunca uma raiz inteira do bucket. */
const SAFE_PREFIX =
  /^(generations|outputs|thumbnails|inputs|samples|voices|workspaces|avatar_source|avatar_audio|video-editor)\/[A-Za-z0-9_-]{10,64}\/$/;

/** Chaves técnicas de `generation.parameters` que podem ficar (texto curto, sem espaço, sem link). */
const TECHNICAL_PARAMETER_KEYS: ReadonlySet<string> = new Set([
  'provider',
  'model',
  'mode',
  'engine',
  'resolution',
  'aspectRatio',
  'mimeType',
  'output_format',
  'feature',
  'freeGenType',
  'generationType',
  'modelVariant',
  'seedreamFallbackFrom',
  'fallbackFrom',
]);
const TECHNICAL_VALUE = /^[A-Za-z0-9._:+/-]{1,64}$/;
/** Chave do áudio próprio do avatar falante em `generation.parameters` (única pista da pasta avatar_audio/<uuid>/). */
const CUSTOM_AUDIO_KEY = 'customAudioKey';

const DEFAULT_SYNC_BUDGET_MS = 20_000;
const MAX_SYNC_BUDGET_MS = 120_000;
const STORAGE_CONCURRENCY = 8;
const IN_CHUNK = 1000;
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 };
const FINALIZE_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

const CATEGORY_LABEL: Record<ContentReportCategory, string> = {
  [ContentReportCategory.MINOR]: 'menor de idade',
  [ContentReportCategory.NON_CONSENSUAL]: 'imagem íntima sem consentimento',
  [ContentReportCategory.IMPERSONATION]: 'uso da imagem de quem denuncia',
  [ContentReportCategory.COPYRIGHT]: 'direito autoral',
  [ContentReportCategory.ILLEGAL]: 'conteúdo ilegal',
  [ContentReportCategory.OTHER]: 'outro motivo',
};
const STATUS_LABEL: Record<ContentReportStatus, string> = {
  [ContentReportStatus.OPEN]: 'aberta',
  [ContentReportStatus.IN_REVIEW]: 'em análise',
  [ContentReportStatus.ACTIONED]: 'confirmada',
  [ContentReportStatus.DISMISSED]: 'descartada',
};

// ─── Contrato ────────────────────────────────────────────────────────────────

export type SubscriptionErasureResult =
  | 'cancelled'
  | 'manual_action_required'
  | 'not_active'
  | 'error';

export interface SubscriptionErasureOutcome {
  id: string;
  /** stripe | cakto | perfectpay | asaas | admin | none (plano sem gateway) ou o nome gravado */
  gateway: string;
  /** status antes desta rodada */
  status: SubscriptionStatus;
  result: SubscriptionErasureResult;
  /** true quando esta rodada mudou o banco (renovação desligada aqui); false na 2ª rodada */
  changed: boolean;
  detail: string;
}

export interface EraseAccountOptions {
  confirm: boolean;
  reason?: string | null;
  /** e-mail do admin que pediu (vai para o log) */
  requestedBy?: string | null;
  /**
   * Ignora só a guarda por bloqueios de menor em pedido só com texto (o filtro de texto e o provedor podem errar).
   * Exige motivo com 10+ caracteres. Denúncia e recusa do provedor por menor em pedido com foto ou vídeo enviado
   * continuam segurando a conta.
   */
  ignoreSafetyEvents?: boolean;
}

/**
 * report: denúncia de outra pessoa (ou da própria, citando conteúdo dela); safety_events: 3+ tentativas bloqueadas por
 * menor em pedido só com texto em 90 dias (o admin pode ignorar com motivo); provider_minor: o provedor de IA recusou
 * por menor um pedido com foto ou vídeo enviado pela conta (qualquer data, nunca ignorado; só o jurídico libera cada
 * recusa). Evento liberado pelo jurídico (releasedAt) não conta em nenhum dos dois.
 */
export type LegalHoldKind = 'report' | 'safety_events' | 'provider_minor';

export interface AccountLegalHold {
  /** true: a conta só foi bloqueada; nada foi anonimizado nem apagado */
  active: boolean;
  kinds: LegalHoldKind[];
  /** motivos em pt-BR, prontos para mostrar */
  reasons: string[];
  /** denúncias que seguram a conta */
  reportIds: string[];
  /** conteúdo desta conta citado pelas denúncias (e o que está ligado a ele) */
  generationIds: string[];
  communityPostIds: string[];
  avatarIds: string[];
  voiceProfileIds: string[];
  /**
   * pedidos só com texto bloqueados por menor nos últimos 90 dias (filtro de texto e recusa do provedor sem mídia
   * enviada; sem os liberados; conta mesmo quando ignorados). Cada geração em paralelo de um clique conta aqui.
   */
  minorBlockedEvents: number;
  /** tentativas distintas entre os minorBlockedEvents: é o que a guarda compara com o limite de 3 */
  minorBlockedAttempts: number;
  /**
   * pedidos com foto ou vídeo enviado pela conta recusados pelo provedor de IA por menor (qualquer data; nunca
   * ignorados; sem os liberados pelo jurídico)
   */
  providerMinorBlockedEvents: number;
  /**
   * posts da comunidade desta conta tirados do ar agora pela guarda (publicados ou esperando aprovação viram
   * REJECTED com o motivo legal_hold; as linhas ficam). 0 quando não há guarda ou numa rodada que repete a guarda.
   */
  communityPostsUnpublished: number;
  /**
   * gerações desta conta que perderam agora o prazo de expiração da galeria (expiresAt = null), para o cron de limpeza
   * não apagar a evidência. 0 quando não há guarda ou numa rodada que repete a guarda.
   */
  generationsExpiryCleared: number;
}

export interface AccountErasureReport {
  userId: string;
  /** false quando a guarda legal segurou a conta (só bloqueio) */
  anonymized: boolean;
  /** a conta já estava anonimizada antes desta rodada */
  alreadyErased: boolean;
  requestedBy: string | null;
  reason: string | null;
  erasedAt: string;
  /** sessões vivas (refresh token válido) encerradas agora */
  sessionsRevoked: number;
  /** tokens apagados: refresh, troca de senha e verificação de e-mail */
  tokensDeleted: number;
  /** arquivos apagados do bucket */
  filesDeleted: number;
  /** pastas do bucket que não deu para apagar (lista em failedPrefixes) */
  filesFailed: number;
  failedPrefixes: string[];
  storage: {
    configured: boolean;
    /**
     * o bucket terminou nesta resposta (pastas apagadas ou com falha); false = segue em segundo plano, ou o bucket não
     * está configurado (nenhum arquivo foi tocado)
     */
    completed: boolean;
    prefixesTotal: number;
    prefixesDone: number;
    /**
     * true só quando a 2ª etapa (apagar ou limpar no banco as linhas cujas pastas o bucket confirmou) rodou e gravou
     * (ou não tinha linha para limpar). false: ainda em segundo plano, a transação falhou (finalizeError), o bucket
     * não está configurado ou houve guarda legal (nada é apagado). Pasta com falha não entra aqui: fica em
     * failedPrefixes.
     */
    finalized: boolean;
    /** por que a 2ª etapa falhou (as linhas ficam como pista para a próxima rodada) */
    finalizeError?: string;
  };
  /** gerações que tinham texto, arquivo ou vínculo pessoal e foram limpas agora */
  generationsScrubbed: number;
  /** gerações ainda em processamento: podem gerar arquivo depois desta rodada */
  generationsInFlight: number;
  /**
   * gerações com bloqueio por menor de idade (content_safety_events.generation_id) que ficaram intactas como evidência:
   * texto, imagens de entrada, saídas e pastas no bucket não são tocados por nenhum caminho da exclusão
   */
  generationsKeptAsEvidence: number;
  deleted: {
    refreshTokens: number;
    passwordResetTokens: number;
    emailVerificationTokens: number;
    notifications: number;
    communityPosts: number;
    communityLikes: number;
    follows: number;
    folders: number;
    workspaces: number;
    brands: number;
    videoProjects: number;
    feedback: number;
    voiceProfiles: number;
    influencers: number;
    generationOutputs: number;
    generationInputImages: number;
    unlimitedUsage: number;
    freeGenerationBalances: number;
    weeklyClaims: number;
    emailSequenceLogs: number;
    analyticsEvents: number;
    marketingLeads: number;
  };
  scrubbed: {
    userAvatars: number;
    recoveryCampaigns: number;
    broadcastRecipients: number;
    freeGenerationGrants: number;
    affiliate: number;
  };
  subscriptions: SubscriptionErasureOutcome[];
  providers: {
    heygenAvatarGroups: {
      /** grupos que a HeyGen confirmou apagados (ou que já não existiam lá) */
      requested: number;
      failed: number;
      /** grupos da HeyGen que não saíram: a próxima rodada tenta de novo */
      failedIds: string[];
    };
  };
  legalHold: AccountLegalHold;
  kept: {
    payments: number;
    creditTransactions: number;
    affiliateEarnings: number;
    subscriptions: number;
    generations: number;
    contentReports: number;
    contentSafetyEvents: number;
  };
  /** o que ainda depende de alguém (gateway manual, arquivo que falhou, guarda legal, rodar de novo) */
  nextSteps: string[];
}

// ─── Funções puras (testadas à parte) ────────────────────────────────────────

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort())
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    return sorted;
  }
  return value ?? null;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * O que sobra de `generation.parameters`: booleanos e números do primeiro nível (ilimitado, fallback, duração,
 * custo) e texto curto só das chaves técnicas. Roteiro, prompt original, link, chave de arquivo, nome de voz,
 * listas e objetos aninhados saem. Sem nada técnico, vira null.
 */
export function sanitizeGenerationParameters(
  value: unknown,
): Record<string, string | number | boolean> | null {
  if (!isPlainObject(value)) return null;
  const kept: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (typeof entry === 'boolean') kept[key] = entry;
    else if (typeof entry === 'number' && Number.isFinite(entry))
      kept[key] = entry;
    else if (
      typeof entry === 'string' &&
      TECHNICAL_PARAMETER_KEYS.has(key) &&
      TECHNICAL_VALUE.test(entry) &&
      !entry.includes('//')
    ) {
      kept[key] = entry;
    }
  }
  return Object.keys(kept).length ? kept : null;
}

/** Pastas de uma geração no bucket. Id fora do formato não vira pasta (nunca apaga uma raiz). */
export function generationStoragePrefixes(generationId: string): string[] {
  if (!ID_SEGMENT.test(generationId)) return [];
  return GENERATION_STORAGE_ROOTS.map((root) => `${root}/${generationId}/`);
}

/** Pasta de um upload pré-assinado (`<propósito>/<uuid>/<arquivo>`), só se for do propósito esperado. */
export function uploadFolderFromKey(
  key: unknown,
  purpose: 'avatar_source' | 'avatar_audio',
): string | null {
  if (typeof key !== 'string') return null;
  const [root, folder, ...file] = key.split('/');
  if (
    root !== purpose ||
    !folder ||
    !UUID.test(folder) ||
    !file.length ||
    !file.join('/')
  )
    return null;
  return `${root}/${folder}/`;
}

/**
 * Parâmetros da geração durante a exclusão: os limpos e, enquanto a pasta do áudio próprio (avatar_audio/<uuid>/)
 * não sair do bucket, a chave dela. A chave é a única pista da pasta; sai na 2ª etapa, depois da confirmação.
 */
export function scrubbedGenerationParameters(value: unknown): {
  interim: Record<string, string | number | boolean> | null;
  final: Record<string, string | number | boolean> | null;
  audioFolder: string | null;
} {
  const final = sanitizeGenerationParameters(value);
  const audioKey = isPlainObject(value) ? value[CUSTOM_AUDIO_KEY] : undefined;
  const audioFolder = uploadFolderFromKey(audioKey, 'avatar_audio');
  const interim =
    audioFolder && typeof audioKey === 'string'
      ? { ...(final ?? {}), [CUSTOM_AUDIO_KEY]: audioKey }
      : final;
  return { interim, final, audioFolder };
}

/** Os parâmetros gravados já estão como a exclusão deixa? (objeto vazio conta como limpo, igual a null) */
function parametersAlreadyScrubbed(value: unknown): boolean {
  const normalized =
    isPlainObject(value) && Object.keys(value).length === 0
      ? null
      : (value ?? null);
  return (
    canonicalJson(normalized) ===
    canonicalJson(scrubbedGenerationParameters(value).interim)
  );
}

export interface StorageLocation {
  /** S3_PUBLIC_URL sem a barra final */
  publicUrlBase: string;
  bucket: string;
}

/** Chave do bucket a partir da URL pública (S3_PUBLIC_URL) ou de URL no estilo `/<bucket>/<chave>`. */
export function storageKeyFromUrl(
  url: string | null | undefined,
  storage: StorageLocation,
): string | null {
  if (!url) return null;
  const clean = url.split(/[?#]/)[0];
  let key: string | null = null;
  if (storage.publicUrlBase && clean.startsWith(`${storage.publicUrlBase}/`)) {
    key = clean.slice(storage.publicUrlBase.length + 1);
  } else {
    try {
      const pathname = new URL(clean).pathname;
      const marker = `/${storage.bucket}/`;
      const at = pathname.indexOf(marker);
      if (at !== -1) key = pathname.slice(at + marker.length);
    } catch {
      return null;
    }
  }
  if (!key) return null;
  try {
    return decodeURIComponent(key);
  } catch {
    return null;
  }
}

/** Pasta do vídeo montado no editor (`video-editor/<uuid>/render-<id do projeto>.mp4`), só se for deste projeto. */
export function videoRenderFolder(
  projectId: string,
  outputUrl: string | null,
  storage: StorageLocation,
): string | null {
  const key = storageKeyFromUrl(outputUrl, storage);
  if (!key) return null;
  const match = /^video-editor\/([^/]+)\/render-([^/]+)\.mp4$/.exec(key);
  if (!match || !UUID.test(match[1]) || match[2] !== projectId) return null;
  return `video-editor/${match[1]}/`;
}

const CUID_TOKEN = /(?<![a-z0-9])c[a-z0-9]{24}(?![a-z0-9])/gi;

/** Ids no formato cuid citados num texto (link, id solto, URL de arquivo). */
export function citedIds(text: string | null | undefined): string[] {
  if (!text) return [];
  return Array.from(text.matchAll(CUID_TOKEN), (match) =>
    match[0].toLowerCase(),
  );
}

/** O texto cita o e-mail inteiro (não um pedaço de outro e-mail, como maria@x.com dentro de maria@x.com.br)? */
export function mentionsEmail(
  text: string | null | undefined,
  email: string | null | undefined,
): boolean {
  if (!text || !email) return false;
  const haystack = text.toLowerCase();
  const needle = email.trim().toLowerCase();
  if (!needle.includes('@')) return false;
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + 1)
  ) {
    const before = haystack[at - 1];
    const after = haystack.slice(at + needle.length);
    if (before && /[a-z0-9._%+-]/.test(before)) continue;
    if (/^\.?[a-z0-9-]/.test(after)) continue;
    return true;
  }
  return false;
}

function citesMinor(text: string | null | undefined): boolean {
  const assessment = assessText(text);
  return (
    assessment.blocked &&
    (assessment.reason === 'term' || assessment.reason === 'age')
  );
}

export interface HoldReport {
  id: string;
  category: ContentReportCategory;
  status: ContentReportStatus;
  target: string;
  description: string;
  isDepictedPerson?: boolean | null;
  /** marcada urgente pela API (categoria urgente, a própria pessoa denunciando ou texto que cita menor) */
  urgent?: boolean | null;
  /** conta logada que denunciou */
  reporterUserId?: string | null;
  /** e-mail de contato de quem denunciou */
  reporterEmail?: string | null;
  /** caso encerrado e evidência entregue: marcado pelo admin em Denúncias */
  evidenceReleasedAt?: Date | string | null;
}

/** Caso encerrado com a evidência entregue (confirmada e marcada "evidência liberada" no admin). */
function evidenceReleased(
  report: Pick<HoldReport, 'status' | 'evidenceReleasedAt'>,
): boolean {
  return (
    report.status === ContentReportStatus.ACTIONED &&
    report.evidenceReleasedAt !== null &&
    report.evidenceReleasedAt !== undefined &&
    report.evidenceReleasedAt !== ''
  );
}

/**
 * O caso da denúncia ainda segura evidência, qualquer que seja a categoria: não foi descartada e a evidência não foi
 * liberada (confirmada + "evidência liberada"). É a régua do cron de limpeza da galeria, que não apaga nada citado.
 */
export function reportCaseOpen(
  report: Pick<HoldReport, 'status' | 'evidenceReleasedAt'>,
): boolean {
  return (
    report.status !== ContentReportStatus.DISMISSED && !evidenceReleased(report)
  );
}

/**
 * A denúncia segura evidência? Menor, crime ou imagem íntima sem consentimento; uso de imagem quando quem denuncia
 * é a pessoa retratada; ou texto que cita menor (a marca de urgência da API, conferida de novo no texto para as
 * denúncias antigas). Confirmada (ACTIONED) segura até o admin marcar "evidência liberada" (evidenceReleasedAt):
 * aí o caso está encerrado e a evidência entregue. Descartada não segura nada. Aberta ou em análise segura mesmo
 * com a marca (o caso não fechou).
 */
export function reportHoldsEvidence(report: HoldReport): boolean {
  if (report.status === ContentReportStatus.DISMISSED) return false;
  if (evidenceReleased(report)) return false;
  if (HOLD_CATEGORIES.has(report.category)) return true;
  if (
    report.category === ContentReportCategory.IMPERSONATION &&
    report.isDepictedPerson === true
  )
    return true;
  return (
    report.urgent === true ||
    citesMinor(report.target) ||
    citesMinor(report.description)
  );
}

/**
 * A denúncia foi feita pela própria conta (logada, ou com o e-mail dela como contato)? Quando ela só cita o próprio
 * perfil ou e-mail (a vítima pedindo ajuda), não segura a conta; citando conteúdo da própria conta (geração, post,
 * avatar, voz), segura como qualquer outra (ver computeLegalHold).
 */
export function reportFiledByAccount(
  report: Pick<HoldReport, 'reporterUserId' | 'reporterEmail'>,
  account: Pick<HoldAccount, 'userId' | 'email'>,
): boolean {
  if (report.reporterUserId && report.reporterUserId === account.userId)
    return true;
  const reporterEmail = report.reporterEmail?.trim().toLowerCase();
  const accountEmail = account.email?.trim().toLowerCase();
  return Boolean(
    reporterEmail && accountEmail && reporterEmail === accountEmail,
  );
}

/** O que a conta tem e que uma denúncia pode citar. */
export interface HoldAccount {
  userId: string;
  /** e-mail original (null quando a conta já estava anonimizada) */
  email: string | null;
  generations: Array<{
    id: string;
    userAvatarId: string | null;
    voiceProfileId: string | null;
  }>;
  posts: Array<{ id: string; generationId: string | null }>;
  avatarIds: string[];
  voiceProfileIds: string[];
}

export interface ReportCitation {
  /** cita o perfil (id da conta, como no link /community/users/<id>) */
  profile: boolean;
  email: boolean;
  generationIds: string[];
  postIds: string[];
  avatarIds: string[];
  voiceProfileIds: string[];
}

/** Monta a busca de uma vez (conjuntos de ids) e devolve o que cada denúncia cita desta conta, ou null. */
export function createAccountMatcher(
  account: HoldAccount,
): (
  report: Pick<HoldReport, 'target' | 'description'>,
) => ReportCitation | null {
  const userId = account.userId.toLowerCase();
  const generationIds = new Set(
    account.generations.map((item) => item.id.toLowerCase()),
  );
  const postIds = new Set(account.posts.map((item) => item.id.toLowerCase()));
  const avatarIds = new Set(account.avatarIds.map((id) => id.toLowerCase()));
  const voiceIds = new Set(
    account.voiceProfileIds.map((id) => id.toLowerCase()),
  );
  // o id volta com a grafia do banco (cuid é minúsculo, mas o texto da denúncia pode vir em maiúsculas)
  const original = new Map<string, string>();
  for (const id of [
    ...account.generations.map((item) => item.id),
    ...account.posts.map((item) => item.id),
    ...account.avatarIds,
    ...account.voiceProfileIds,
  ])
    original.set(id.toLowerCase(), id);

  return (report) => {
    const citation: ReportCitation = {
      profile: false,
      email:
        mentionsEmail(report.target, account.email) ||
        mentionsEmail(report.description, account.email),
      generationIds: [],
      postIds: [],
      avatarIds: [],
      voiceProfileIds: [],
    };
    const seen = new Set<string>();
    for (const token of [
      ...citedIds(report.target),
      ...citedIds(report.description),
    ]) {
      if (seen.has(token)) continue;
      seen.add(token);
      const id = original.get(token) ?? token;
      if (token === userId) citation.profile = true;
      if (generationIds.has(token)) citation.generationIds.push(id);
      if (postIds.has(token)) citation.postIds.push(id);
      if (avatarIds.has(token)) citation.avatarIds.push(id);
      if (voiceIds.has(token)) citation.voiceProfileIds.push(id);
    }
    const cites =
      citation.profile ||
      citation.email ||
      citation.generationIds.length > 0 ||
      citation.postIds.length > 0 ||
      citation.avatarIds.length > 0 ||
      citation.voiceProfileIds.length > 0;
    return cites ? citation : null;
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function describeCitation(citation: ReportCitation): string {
  const parts: string[] = [];
  if (citation.profile) parts.push('o perfil');
  if (citation.email) parts.push('o e-mail');
  if (citation.generationIds.length)
    parts.push(plural(citation.generationIds.length, 'geração', 'gerações'));
  if (citation.postIds.length)
    parts.push(
      plural(
        citation.postIds.length,
        'post da comunidade',
        'posts da comunidade',
      ),
    );
  if (citation.avatarIds.length)
    parts.push(plural(citation.avatarIds.length, 'avatar', 'avatares'));
  if (citation.voiceProfileIds.length)
    parts.push(plural(citation.voiceProfileIds.length, 'voz', 'vozes'));
  return parts.join(', ');
}

/** A denúncia cita só o perfil ou o e-mail da conta (nenhum conteúdo dela)? */
function citesOnlyIdentity(citation: ReportCitation): boolean {
  return (
    citation.generationIds.length === 0 &&
    citation.postIds.length === 0 &&
    citation.avatarIds.length === 0 &&
    citation.voiceProfileIds.length === 0
  );
}

function holdReasonForReport(
  report: HoldReport,
  citation: ReportCitation,
  filedByAccount = false,
): string {
  const byCategory =
    HOLD_CATEGORIES.has(report.category) ||
    (report.category === ContentReportCategory.IMPERSONATION &&
      report.isDepictedPerson === true);
  const label =
    CATEGORY_LABEL[report.category] ?? String(report.category).toLowerCase();
  const releaseNote =
    report.evidenceReleasedAt && !evidenceReleased(report)
      ? ', marcada como evidência liberada, mas a denúncia ainda não foi encerrada'
      : '';
  return (
    `Denúncia ${report.id} (${label}${byCategory ? '' : ', o texto cita menor de idade'}, ` +
    `${STATUS_LABEL[report.status] ?? String(report.status).toLowerCase()}${releaseNote}` +
    `${filedByAccount ? ', feita pela própria conta' : ''}) aponta para ` +
    `${describeCitation(citation)} desta conta.`
  );
}

/**
 * Guarda legal da conta, calculada antes de qualquer mudança. Denúncia de menor, crime ou imagem íntima (não
 * descartada e sem a evidência liberada) que cita algo da conta segura TUDO: a conta só é bloqueada e nada é
 * anonimizado ou apagado, para a evidência continuar ligada a quem a criou. Denúncia feita pela própria conta só não
 * segura quando cita apenas o perfil ou o e-mail dela. Recusa do provedor por menor em pedido com foto ou vídeo enviado
 * segura com 1 só, de qualquer data. Bloqueios por menor em pedido só com texto (3+ tentativas distintas em 90 dias)
 * também seguram, mas o admin pode ignorar só esses (filtro e provedor erram no texto), nunca a denúncia nem a recusa
 * com mídia.
 */
export function computeLegalHold(input: {
  reports: HoldReport[];
  account: HoldAccount;
  /** bloqueios por menor em pedido só com texto nos últimos 90 dias (todos, inclusive as repetições de um clique) */
  minorBlockedEvents: number;
  /** tentativas distintas entre esses bloqueios (sem o valor, cada bloqueio conta como uma tentativa) */
  minorBlockedAttempts?: number;
  /** recusas do provedor por menor em pedido com foto ou vídeo enviado (rota provider:, qualquer data) */
  providerMinorBlockedEvents?: number;
  ignoreSafetyEvents: boolean;
}): AccountLegalHold {
  const { account } = input;
  const match = createAccountMatcher(account);
  const generationIds = new Set<string>();
  const postIds = new Set<string>();
  const avatarIds = new Set<string>();
  const voiceIds = new Set<string>();
  const reportIds: string[] = [];
  const reportReasons: string[] = [];

  for (const report of input.reports) {
    const citation = match(report);
    if (!citation || !reportHoldsEvidence(report)) continue;
    // a própria conta citando só o próprio perfil ou e-mail (a vítima pedindo ajuda) não trava a exclusão;
    // citando conteúdo dela (geração, post, avatar, voz), esse conteúdo é evidência e segura
    const filedByAccount = reportFiledByAccount(report, account);
    if (filedByAccount && citesOnlyIdentity(citation)) continue;
    reportIds.push(report.id);
    citation.generationIds.forEach((id) => generationIds.add(id));
    citation.postIds.forEach((id) => postIds.add(id));
    citation.avatarIds.forEach((id) => avatarIds.add(id));
    citation.voiceProfileIds.forEach((id) => voiceIds.add(id));
    reportReasons.push(holdReasonForReport(report, citation, filedByAccount));
  }

  // o que está ligado ao conteúdo citado: post ↔ geração, e o avatar e a voz usados na geração
  const ownGenerations = new Set(account.generations.map((item) => item.id));
  const ownAvatars = new Set(account.avatarIds);
  const ownVoices = new Set(account.voiceProfileIds);
  for (const post of account.posts) {
    if (
      postIds.has(post.id) &&
      post.generationId &&
      ownGenerations.has(post.generationId)
    )
      generationIds.add(post.generationId);
  }
  for (const post of account.posts) {
    if (post.generationId && generationIds.has(post.generationId))
      postIds.add(post.id);
  }
  for (const generation of account.generations) {
    if (!generationIds.has(generation.id)) continue;
    if (generation.userAvatarId && ownAvatars.has(generation.userAvatarId))
      avatarIds.add(generation.userAvatarId);
    if (generation.voiceProfileId && ownVoices.has(generation.voiceProfileId))
      voiceIds.add(generation.voiceProfileId);
  }

  const kinds: LegalHoldKind[] = [];
  const reasons: string[] = reportReasons.slice(0, MAX_HOLD_REASON_LINES);
  if (reportReasons.length > MAX_HOLD_REASON_LINES) {
    reasons.push(
      `E mais ${plural(reportReasons.length - MAX_HOLD_REASON_LINES, 'denúncia', 'denúncias')} (lista completa em reportIds).`,
    );
  }
  if (reportIds.length) kinds.push('report');
  const providerMinorBlockedEvents = Math.max(
    0,
    Math.trunc(input.providerMinorBlockedEvents ?? 0),
  );
  const minorBlockedEvents = Math.max(0, Math.trunc(input.minorBlockedEvents));
  const minorBlockedAttempts = Math.min(
    minorBlockedEvents,
    Math.max(0, Math.trunc(input.minorBlockedAttempts ?? minorBlockedEvents)),
  );
  // evidência da mídia (o provedor recusou por menor um pedido com foto ou vídeo da conta): 1 basta, sem prazo, e o
  // override não vale aqui
  if (providerMinorBlockedEvents > 0) {
    kinds.push('provider_minor');
    reasons.push(
      `${plural(providerMinorBlockedEvents, 'pedido desta conta foi recusado', 'pedidos desta conta foram recusados')} ` +
        'pelo provedor de IA por detectar menor de idade, com foto ou vídeo enviado pela conta (evidência da própria ' +
        'mídia: a guarda não vence e não é liberada por ignoreSafetyEvents; só o jurídico libera cada recusa).',
    );
  }
  if (
    minorBlockedAttempts >= MINOR_BLOCKED_HOLD_THRESHOLD &&
    !input.ignoreSafetyEvents
  ) {
    kinds.push('safety_events');
    const attempts =
      minorBlockedAttempts === minorBlockedEvents
        ? ''
        : ` em ${plural(minorBlockedAttempts, 'tentativa distinta', 'tentativas distintas')}`;
    reasons.push(
      `${plural(minorBlockedEvents, 'pedido desta conta foi bloqueado', 'pedidos desta conta foram bloqueados')}${attempts} ` +
        `por menor de idade no texto do pedido nos últimos ${MINOR_BLOCKED_WINDOW_DAYS} dias (filtro de texto ou recusa do ` +
        `provedor de IA a pedido só com texto; a guarda começa em ${MINOR_BLOCKED_HOLD_THRESHOLD} tentativas distintas).`,
    );
  }

  return {
    active: kinds.length > 0,
    kinds,
    reasons,
    reportIds,
    generationIds: [...generationIds],
    communityPostIds: [...postIds],
    avatarIds: [...avatarIds],
    voiceProfileIds: [...voiceIds],
    minorBlockedEvents,
    minorBlockedAttempts,
    providerMinorBlockedEvents,
    communityPostsUnpublished: 0,
    generationsExpiryCleared: 0,
  };
}

/** ignoreSafetyEvents só vale com motivo de 10+ caracteres (fica no log). Lança 400 quando falta. */
export function assertSafetyOverride(
  ignoreSafetyEvents: unknown,
  reason: unknown,
): void {
  if (ignoreSafetyEvents === undefined || ignoreSafetyEvents === null) return;
  if (typeof ignoreSafetyEvents !== 'boolean') {
    throw new BadRequestException({
      code: 'ACCOUNT_ERASURE_INVALID_OVERRIDE',
      message: 'ignoreSafetyEvents precisa ser true ou false.',
    });
  }
  if (!ignoreSafetyEvents) return;
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < SAFETY_OVERRIDE_REASON_MIN_LENGTH) {
    throw new BadRequestException({
      code: 'ACCOUNT_ERASURE_OVERRIDE_REASON_REQUIRED',
      message: `Para ignorar os bloqueios por menor de idade, explique o motivo (mínimo de ${SAFETY_OVERRIDE_REASON_MIN_LENGTH} caracteres em "reason").`,
    });
  }
}

function chunk<T>(items: T[], size = IN_CHUNK): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    chunks.push(items.slice(start, start + size));
  return chunks;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A Stripe diz que a assinatura já acabou lá (cancelada ou inexistente)? */
function isStripeSubscriptionGone(error: unknown): boolean {
  const failure = error as {
    code?: unknown;
    raw?: { code?: unknown };
    message?: unknown;
  } | null;
  const code = failure?.code ?? failure?.raw?.code;
  const message = typeof failure?.message === 'string' ? failure.message : '';
  return code === 'resource_missing' || /canceled subscription/i.test(message);
}

function subscriptionGateway(subscription: Subscription): string {
  if (
    subscription.paymentMethod === 'pix_auto_asaas' ||
    subscription.paymentProvider === 'asaas'
  )
    return 'asaas';
  return subscription.paymentProvider ?? 'none';
}

async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  limit: number,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const task = tasks[next++];
      await task();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, () => worker()),
  );
}

function safePrefixes(prefixes: Array<string | null | undefined>): string[] {
  return [
    ...new Set(prefixes.filter((prefix): prefix is string => Boolean(prefix))),
  ].filter((prefix) => SAFE_PREFIX.test(prefix));
}

/** Falha ao gravar o estado da assinatura no banco depois do passo no gateway. */
class LocalSubscriptionUpdateError extends Error {
  constructor(
    readonly gatewayDone: string,
    cause: unknown,
  ) {
    super(errorMessage(cause));
  }
}

// ─── Guarda legal lida do banco (exclusão LGPD, exclusão definitiva do admin e cron da galeria) ───────

/** O que a guarda lê do banco: o PrismaService ou o cliente de uma transação. */
export type LegalHoldDb = Pick<
  Prisma.TransactionClient,
  | 'generation'
  | 'generationInputImage'
  | 'communityPost'
  | 'userAvatar'
  | 'voiceProfile'
  | 'contentReport'
  | 'contentSafetyEvent'
>;

const HOLD_REPORT_SELECT = {
  id: true,
  category: true,
  status: true,
  target: true,
  description: true,
  isDepictedPerson: true,
  urgent: true,
  reporterUserId: true,
  reporterEmail: true,
  evidenceReleasedAt: true,
} satisfies Prisma.ContentReportSelect;

/** E-mail que a busca nas denúncias usa: null quando a conta já foi anonimizada (o gravado é o substituto). */
export function holdAccountEmail(user: {
  id: string;
  email: string;
}): string | null {
  return user.email === erasedEmailFor(user.id) ? null : user.email;
}

/** Ids do que a conta tem e que uma denúncia pode citar (sem texto nenhum). */
export async function readHoldAccount(
  db: LegalHoldDb,
  userId: string,
  email: string | null,
): Promise<HoldAccount> {
  const generations = await db.generation.findMany({
    where: { userId },
    select: { id: true, userAvatarId: true, voiceProfileId: true },
  });
  const posts = await db.communityPost.findMany({
    where: { userId },
    select: { id: true, generationId: true },
  });
  const avatars = await db.userAvatar.findMany({
    where: { userId },
    select: { id: true },
  });
  const voices = await db.voiceProfile.findMany({
    where: { userId },
    select: { id: true },
  });
  return {
    userId,
    email,
    generations,
    posts,
    avatarIds: avatars.map((avatar) => avatar.id),
    voiceProfileIds: voices.map((voice) => voice.id),
  };
}

export interface ReportScan {
  /** denúncias não descartadas que citavam a conta na 1ª passada */
  candidateIds: string[];
  /** quando a 1ª passada começou: a 2ª relê também o que foi criado ou alterado desde então */
  startedAt: Date;
}

/**
 * 1ª passada, FORA da transação longa: lê todas as denúncias não descartadas, em páginas (nenhuma fica de fora por
 * limite), e guarda só os ids das que citam a conta. A transação relê só essas (recheckReportsCitingAccount), sem
 * varrer a tabela inteira com a transação de 60 s aberta.
 */
export async function scanReportsCitingAccount(
  db: Pick<LegalHoldDb, 'contentReport'>,
  account: HoldAccount,
): Promise<ReportScan> {
  const startedAt = new Date();
  const match = createAccountMatcher(account);
  const candidateIds: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: Array<Pick<HoldReport, 'id' | 'target' | 'description'>> =
      await db.contentReport.findMany({
        where: {
          status: { not: ContentReportStatus.DISMISSED },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true, target: true, description: true },
        orderBy: { id: 'asc' },
        take: REPORT_SCAN_PAGE,
      });
    for (const report of page) if (match(report)) candidateIds.push(report.id);
    if (page.length < REPORT_SCAN_PAGE) break;
    cursor = page[page.length - 1].id;
  }
  return { candidateIds, startedAt };
}

/**
 * 2ª passada, DENTRO da transação: relê as candidatas da 1ª passada e as denúncias criadas ou alteradas desde pouco
 * antes dela (nova, reaberta, evidência liberada), com os dados de agora; a citação é conferida de novo com a conta lida
 * na transação. Devolve em ordem de id, com quem denunciou e a liberação da evidência (o computeLegalHold decide).
 */
export async function recheckReportsCitingAccount(
  db: Pick<LegalHoldDb, 'contentReport'>,
  account: HoldAccount,
  scan: ReportScan,
): Promise<HoldReport[]> {
  const match = createAccountMatcher(account);
  const found = new Map<string, HoldReport>();
  const keep = (rows: HoldReport[]): void => {
    for (const report of rows) if (match(report)) found.set(report.id, report);
  };
  for (const ids of chunk([...new Set(scan.candidateIds)])) {
    keep(
      await db.contentReport.findMany({
        where: {
          id: { in: ids },
          status: { not: ContentReportStatus.DISMISSED },
        },
        select: HOLD_REPORT_SELECT,
      }),
    );
  }
  const since = new Date(scan.startedAt.getTime() - REPORT_RECHECK_MARGIN_MS);
  let cursor: string | null = null;
  for (;;) {
    const page: HoldReport[] = await db.contentReport.findMany({
      where: {
        status: { not: ContentReportStatus.DISMISSED },
        OR: [{ createdAt: { gte: since } }, { updatedAt: { gte: since } }],
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: HOLD_REPORT_SELECT,
      orderBy: { id: 'asc' },
      take: REPORT_SCAN_PAGE,
    });
    keep(page);
    if (page.length < REPORT_SCAN_PAGE) break;
    cursor = page[page.length - 1].id;
  }
  return [...found.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

/** Trecho do pedido comparável entre bloqueios (a API já junta os espaços e corta em 300; aqui só normaliza). */
function attemptExcerptKey(excerpt: string | null | undefined): string | null {
  const key = (excerpt ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return key || null;
}

/**
 * Tentativas distintas de UMA conta, com a mesma regra do cockpit (Denúncias › reincidência). O bloqueio só entra numa
 * tentativa que já existe quando é o MESMO pedido:
 * - com trecho: a tentativa mais recente que já teve esse trecho e começou há até 10 min (as gerações em paralelo do
 *   mesmo clique e o mesmo pedido reenviado na hora);
 * - sem trecho (não dá para comparar): a tentativa aberta, se ela começou há até 2 min;
 * - com trecho, numa tentativa aberta há até 2 min que ainda não tem trecho nenhum (o bloqueio sem trecho e o com
 *   trecho podem ser do mesmo clique).
 * Texto diferente abre outra tentativa, mesmo segundos depois (reescrever o pedido é tentar de novo). As janelas contam
 * a partir do primeiro bloqueio da tentativa: quem reenvia o mesmo texto ao longo do dia não vira uma tentativa só.
 */
export function countMinorAttempts(
  blocks: Array<{ at: number; excerpt: string | null | undefined }>,
): number {
  const attempts: Array<{ startAt: number; excerpts: Set<string> }> = [];
  const sameTextAttempt = (text: string, at: number) => {
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      const attempt = attempts[index];
      // as anteriores começaram ainda antes: nenhuma está dentro da janela
      if (at - attempt.startAt > MINOR_SAME_TEXT_WINDOW_MS) break;
      if (attempt.excerpts.has(text)) return attempt;
    }
    return undefined;
  };
  const ordered = blocks
    .filter((block) => Number.isFinite(block.at))
    .sort((left, right) => left.at - right.at);
  for (const block of ordered) {
    const text = attemptExcerptKey(block.excerpt);
    const open = attempts[attempts.length - 1];
    const burst =
      open !== undefined && block.at - open.startAt <= MINOR_ATTEMPT_WINDOW_MS
        ? open
        : undefined;
    const target = text
      ? (sameTextAttempt(text, block.at) ??
        (burst && burst.excerpts.size === 0 ? burst : undefined))
      : burst;
    if (target) {
      if (text) target.excerpts.add(text);
      continue;
    }
    attempts.push({ startAt: block.at, excerpts: new Set(text ? [text] : []) });
  }
  return attempts.length;
}

/** Flags de generation.parameters que dizem que o pedido levou mídia da conta (vídeo de referência, fotos). */
const USER_MEDIA_PARAMETER_FLAGS = [
  'hasVideoInput',
  'hasInputImages',
  'hasImageInput',
] as const;
/** Chaves de generation.parameters que guardam mídia enviada pela conta (link ou chave do bucket). */
const USER_MEDIA_PARAMETER_KEYS = [
  'imageUrl',
  'imageUrls',
  'inputImageUrl',
  'inputImageUrls',
  'referenceImageUrls',
  'referenceVideoUrls',
  'sourceImageUrl',
  'targetImageUrl',
  'sourceVideoUrl',
  'firstFrameUrl',
  'lastFrameUrl',
  'videoUrl',
] as const;

function hasMediaValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value))
    return value.some(
      (item) => typeof item === 'string' && item.trim().length > 0,
    );
  return false;
}

/**
 * generation.parameters mostra mídia enviada pela conta? Só sinais que não deixam dúvida: a flag gravada pela própria
 * API (`hasVideoInput: true`, do motion control e do Seedance com vídeo de referência) ou uma chave de mídia de entrada
 * com valor. Texto, modelo e prompt nunca contam.
 */
export function parametersShowUserMedia(parameters: unknown): boolean {
  if (!isPlainObject(parameters)) return false;
  if (USER_MEDIA_PARAMETER_FLAGS.some((flag) => parameters[flag] === true))
    return true;
  return USER_MEDIA_PARAMETER_KEYS.some((key) =>
    hasMediaValue(parameters[key]),
  );
}

/**
 * Gerações (entre as pedidas) em que a conta enviou mídia: imagem de entrada gravada (generation_input_images), atestado
 * de consentimento de imagem ligado à geração (as ferramentas de foto exigem), avatar próprio usado nela ou mídia
 * marcada em generation.parameters. Erro de leitura sobe (quem chama decide; na exclusão, a transação cai e nada muda).
 */
export async function generationsWithUserMedia(
  db: Pick<
    LegalHoldDb,
    'generation' | 'generationInputImage' | 'contentSafetyEvent'
  >,
  generationIds: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const ids of chunk([...new Set(generationIds)])) {
    for (const row of await db.generationInputImage.findMany({
      where: { generationId: { in: ids } },
      select: { generationId: true },
    }))
      found.add(row.generationId);
    for (const row of await db.contentSafetyEvent.findMany({
      where: {
        kind: ContentSafetyEventKind.CONSENT_ATTESTED,
        generationId: { in: ids },
      },
      select: { generationId: true },
    }))
      if (row.generationId) found.add(row.generationId);
    const pending = ids.filter((id) => !found.has(id));
    if (!pending.length) continue;
    for (const row of await db.generation.findMany({
      where: { id: { in: pending } },
      select: { id: true, userAvatarId: true, parameters: true },
    })) {
      if (row.userAvatarId || parametersShowUserMedia(row.parameters))
        found.add(row.id);
    }
  }
  return found;
}

/** Bloqueio por menor lido do banco para a guarda (só o que a contagem usa). */
export interface MinorBlockRecord {
  route: string;
  excerpt: string | null;
  createdAt: Date;
  generationId: string | null;
}

/** O que a guarda conta dos bloqueios por menor de uma conta. */
export interface MinorBlockTally {
  /** bloqueios de pedido só com texto nos últimos 90 dias (filtro de texto e recusa do provedor sem mídia da conta) */
  recent: number;
  /** tentativas distintas entre os `recent` (é o que a guarda compara com o limite) */
  recentAttempts: number;
  /** recusas do provedor por menor em pedido com foto ou vídeo da conta (qualquer data) */
  provider: number;
}

export function isProviderMinorRoute(
  route: string | null | undefined,
): boolean {
  return (
    typeof route === 'string' && route.startsWith(PROVIDER_MINOR_ROUTE_PREFIX)
  );
}

/**
 * Separa os bloqueios por menor de uma conta (já sem os liberados pelo jurídico): recusa do provedor numa geração com
 * mídia da conta vira provider_minor (qualquer data); o resto (filtro de texto e recusa do provedor a pedido só com
 * texto, inclusive sem geração para conferir) conta como pedido de texto, só nos últimos 90 dias e por tentativa.
 */
export function tallyMinorBlocks(
  events: MinorBlockRecord[],
  generationsWithMedia: ReadonlySet<string>,
  now: Date,
): MinorBlockTally {
  const since = now.getTime() - MINOR_BLOCKED_WINDOW_DAYS * 86_400_000;
  let provider = 0;
  const textBlocks: Array<{ at: number; excerpt: string | null }> = [];
  for (const event of events) {
    if (
      isProviderMinorRoute(event.route) &&
      event.generationId &&
      generationsWithMedia.has(event.generationId)
    ) {
      provider++;
      continue;
    }
    const at = new Date(event.createdAt).getTime();
    if (!Number.isFinite(at) || at < since) continue;
    textBlocks.push({ at, excerpt: event.excerpt });
  }
  return {
    recent: textBlocks.length,
    recentAttempts: countMinorAttempts(textBlocks),
    provider,
  };
}

/**
 * Bloqueios por menor da conta, sem os liberados pelo jurídico (releasedAt): os de pedido só com texto nos últimos 90
 * dias (em tentativas distintas) e as recusas do provedor com mídia da conta (qualquer data).
 */
export async function countMinorBlocks(
  db: Pick<
    LegalHoldDb,
    'contentSafetyEvent' | 'generation' | 'generationInputImage'
  >,
  userId: string,
  now: Date,
): Promise<MinorBlockTally> {
  const since = new Date(
    now.getTime() - MINOR_BLOCKED_WINDOW_DAYS * 86_400_000,
  );
  const events: MinorBlockRecord[] = await db.contentSafetyEvent.findMany({
    where: {
      userId,
      kind: ContentSafetyEventKind.MINOR_BLOCKED,
      releasedAt: null,
      OR: [
        { createdAt: { gte: since } },
        { route: { startsWith: PROVIDER_MINOR_ROUTE_PREFIX } },
      ],
    },
    select: { route: true, excerpt: true, createdAt: true, generationId: true },
    orderBy: { createdAt: 'asc' },
  });
  const providerGenerationIds = events
    .filter((event) => isProviderMinorRoute(event.route) && event.generationId)
    .map((event) => event.generationId as string);
  const withMedia = providerGenerationIds.length
    ? await generationsWithUserMedia(db, providerGenerationIds)
    : new Set<string>();
  const tally = tallyMinorBlocks(events, withMedia, now);
  // checagem de imagem da plataforma (foto/resultado com menor, ou segurado sem decisão do revisor): evidência de
  // mídia como a recusa do provedor com foto — qualquer data, não ignorável, sem depender de generationsWithUserMedia
  const imageEvidence = await db.contentSafetyEvent.findMany({
    where: {
      userId,
      kind: { in: [...IMAGE_EVIDENCE_EVENT_KINDS] },
      releasedAt: null,
    },
    select: { id: true },
  });
  return { ...tally, provider: tally.provider + imageEvidence.length };
}

/**
 * Guarda legal a partir do banco (2ª passada das denúncias + bloqueios por menor). Usada dentro da transação da
 * exclusão LGPD e da exclusão definitiva do admin, com a 1ª passada (scanReportsCitingAccount) feita antes, fora dela.
 */
export async function loadLegalHold(
  db: LegalHoldDb,
  input: {
    account: HoldAccount;
    scan: ReportScan;
    now: Date;
    ignoreSafetyEvents: boolean;
  },
): Promise<AccountLegalHold> {
  const reports = await recheckReportsCitingAccount(
    db,
    input.account,
    input.scan,
  );
  const blocks = await countMinorBlocks(db, input.account.userId, input.now);
  return computeLegalHold({
    reports,
    account: input.account,
    minorBlockedEvents: blocks.recent,
    minorBlockedAttempts: blocks.recentAttempts,
    providerMinorBlockedEvents: blocks.provider,
    ignoreSafetyEvents: input.ignoreSafetyEvents,
  });
}

/**
 * Gerações com evento de bloqueio por menor ligado a elas (content_safety_events.generation_id, qualquer rota) e ainda
 * não liberado pelo jurídico: são evidência, e nenhum caminho da exclusão (nem o cron da galeria) apaga as entradas, as
 * saídas ou os arquivos delas. Liberado (releasedAt) = caso encerrado ou falso positivo: a geração volta à regra comum.
 */
export async function minorBlockedGenerationIds(
  db: Pick<LegalHoldDb, 'contentSafetyEvent'>,
  generationIds: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const ids of chunk([...new Set(generationIds)])) {
    const rows = await db.contentSafetyEvent.findMany({
      where: {
        kind: ContentSafetyEventKind.MINOR_BLOCKED,
        releasedAt: null,
        generationId: { in: ids },
      },
      select: { generationId: true },
    });
    for (const row of rows) if (row.generationId) found.add(row.generationId);
    // foto/resultado barrado ou segurado pela checagem de imagem da plataforma (sem decisão do revisor) também é evidência
    const imageRows = await db.contentSafetyEvent.findMany({
      where: {
        kind: { in: [...IMAGE_EVIDENCE_EVENT_KINDS] },
        releasedAt: null,
        generationId: { in: ids },
      },
      select: { generationId: true },
    });
    for (const row of imageRows)
      if (row.generationId) found.add(row.generationId);
  }
  return found;
}

const HOLD_KIND_LABEL: Record<LegalHoldKind, string> = {
  report: 'denúncia em aberto',
  safety_events: 'bloqueios por menor de idade',
  provider_minor:
    'recusa do provedor de IA por menor de idade em pedido com foto ou vídeo enviado',
};

/**
 * 409 da exclusão definitiva (DELETE /api/v1/admin/users/:id): ela apaga a conta em cascata (gerações, posts,
 * avatares) e levaria a evidência junto. O caminho com guarda é a exclusão LGPD, que só bloqueia e guarda.
 */
export function legalHoldDeletionConflict(
  hold: AccountLegalHold,
): ConflictException {
  const kinds = hold.kinds.map((kind) => HOLD_KIND_LABEL[kind] ?? kind);
  return new ConflictException({
    code: ACCOUNT_LEGAL_HOLD_CODE,
    message:
      `Esta conta está sob guarda legal (${kinds.join('; ')}) e a exclusão definitiva apagaria a evidência. ` +
      'Use "Excluir dados (LGPD)": ele bloqueia a conta, tira os posts do ar e guarda os dados até o caso ser encerrado.',
    reasons: hold.reasons,
    reportIds: hold.reportIds,
  });
}

/** Geração de um lote do cron da galeria, com o que uma denúncia pode citar dela. */
export interface EvidenceCandidate {
  id: string;
  userId: string;
  /** e-mail original da dona (null quando a conta já foi anonimizada) */
  email: string | null;
  userAvatarId: string | null;
  voiceProfileId: string | null;
}

/**
 * Gerações de um lote citadas por alguma denúncia, com o mesmo matcher da guarda legal: a própria geração, um post
 * dela, o avatar ou a voz usados nela, ou o perfil ou o e-mail da dona (aí todas as gerações dela no lote).
 */
export function generationsCitedByReports(
  reports: Array<Pick<HoldReport, 'target' | 'description'>>,
  generations: EvidenceCandidate[],
  posts: Array<{ id: string; generationId: string | null }>,
): Set<string> {
  const cited = new Set<string>();
  if (!reports.length || !generations.length) return cited;
  const byUser = new Map<string, EvidenceCandidate[]>();
  for (const generation of generations) {
    const own = byUser.get(generation.userId) ?? [];
    own.push(generation);
    byUser.set(generation.userId, own);
  }
  for (const [userId, own] of byUser) {
    const ownIds = new Set(own.map((generation) => generation.id));
    const ownPosts = posts.filter(
      (post) => post.generationId !== null && ownIds.has(post.generationId),
    );
    const match = createAccountMatcher({
      userId,
      email: own.find((generation) => generation.email)?.email ?? null,
      generations: own.map((generation) => ({
        id: generation.id,
        userAvatarId: generation.userAvatarId,
        voiceProfileId: generation.voiceProfileId,
      })),
      posts: ownPosts,
      avatarIds: [
        ...new Set(
          own
            .map((generation) => generation.userAvatarId)
            .filter((id): id is string => Boolean(id)),
        ),
      ],
      voiceProfileIds: [
        ...new Set(
          own
            .map((generation) => generation.voiceProfileId)
            .filter((id): id is string => Boolean(id)),
        ),
      ],
    });
    for (const report of reports) {
      const citation = match(report);
      if (!citation) continue;
      if (citation.profile || citation.email) {
        own.forEach((generation) => cited.add(generation.id));
        break;
      }
      citation.generationIds.forEach((id) => cited.add(id));
      const postIds = new Set(citation.postIds);
      for (const post of ownPosts)
        if (postIds.has(post.id) && post.generationId)
          cited.add(post.generationId);
      const avatarIds = new Set(citation.avatarIds);
      const voiceIds = new Set(citation.voiceProfileIds);
      for (const generation of own) {
        if (
          (generation.userAvatarId && avatarIds.has(generation.userAvatarId)) ||
          (generation.voiceProfileId && voiceIds.has(generation.voiceProfileId))
        )
          cited.add(generation.id);
      }
    }
  }
  return cited;
}

// ─── Tipos internos ──────────────────────────────────────────────────────────

const GENERATION_SELECT = {
  id: true,
  status: true,
  prompt: true,
  negativePrompt: true,
  errorMessage: true,
  isDeleted: true,
  isFavorited: true,
  voiceProfileId: true,
  influencer_id: true,
  userAvatarId: true,
  parameters: true,
} satisfies Prisma.GenerationSelect;

const AVATAR_SELECT = {
  id: true,
  name: true,
  sourceVideoKey: true,
  sourceVideoUrl: true,
  heygenGroupId: true,
  heygenLookId: true,
  consentUrl: true,
  previewImageUrl: true,
  previewVideoUrl: true,
  defaultVoiceId: true,
  errorMessage: true,
  isDeleted: true,
  deletedAt: true,
} satisfies Prisma.UserAvatarSelect;

const VOICE_SELECT = {
  id: true,
  name: true,
  sampleUrl: true,
  sampleMime: true,
  previewUrl: true,
  previewText: true,
  isDeleted: true,
} satisfies Prisma.VoiceProfileSelect;

type AccountGeneration = Prisma.GenerationGetPayload<{
  select: typeof GENERATION_SELECT;
}>;
type AccountAvatar = Prisma.UserAvatarGetPayload<{
  select: typeof AVATAR_SELECT;
}>;
type AccountVoice = Prisma.VoiceProfileGetPayload<{
  select: typeof VOICE_SELECT;
}>;

interface AccountRows {
  generations: AccountGeneration[];
  posts: Array<{ id: string; generationId: string | null }>;
  avatars: AccountAvatar[];
  voices: AccountVoice[];
}

interface EraseContext {
  userId: string;
  /** e-mail original (null quando a conta já estava anonimizada) */
  originalEmail: string | null;
  erasedEmail: string;
  now: Date;
  storage: StorageLocation;
  ignoreSafetyEvents: boolean;
  /** 1ª passada das denúncias, feita antes da transação */
  reportScan: ReportScan;
}

interface AccessRevocation {
  sessionsRevoked: number;
  refreshTokens: number;
  passwordResetTokens: number;
  emailVerificationTokens: number;
}

/** Linha que é a única pista de pastas no bucket: fica até as pastas saírem, depois é apagada ou limpa. */
interface CleanupItem {
  id: string;
  prefixes: string[];
}

interface GenerationCleanupItem extends CleanupItem {
  /** tem saída ou imagem de entrada gravada (linhas que saem na 2ª etapa) */
  hasRows: boolean;
  /** parâmetros finais quando a chave do áudio próprio ainda está gravada (sai na 2ª etapa) */
  finalParameters?: Record<string, string | number | boolean> | null;
}

/** O que a 2ª etapa faz depois de o bucket (e a HeyGen) confirmarem. */
interface CleanupPlan {
  prefixes: string[];
  workspaces: CleanupItem[];
  videoProjects: CleanupItem[];
  avatarSources: CleanupItem[];
  voices: CleanupItem[];
  generations: GenerationCleanupItem[];
  heygen: Array<{ avatarId: string; groupId: string }>;
}

interface DatabaseErasure {
  access: AccessRevocation;
  generationsScrubbed: number;
  generationsInFlight: number;
  /** gerações com bloqueio por menor, deixadas intactas (evidência) */
  generationsKeptAsEvidence: number;
  deleted: AccountErasureReport['deleted'];
  scrubbed: AccountErasureReport['scrubbed'];
  kept: AccountErasureReport['kept'];
  plan: CleanupPlan;
}

interface HeldDatabase {
  access: AccessRevocation;
  recoveryCampaigns: number;
  /** posts tirados do ar nesta rodada (REJECTED, motivo legal_hold) */
  communityPostsUnpublished: number;
  /** gerações que perderam o prazo de expiração nesta rodada (o cron da galeria não apaga evidência) */
  generationsExpiryCleared: number;
  kept: AccountErasureReport['kept'];
}

type DatabasePhase =
  | { kind: 'held'; hold: AccountLegalHold; held: HeldDatabase }
  | { kind: 'erased'; hold: AccountLegalHold; erasure: DatabaseErasure };

interface FinalizeCounts {
  workspaces: number;
  videoProjects: number;
  voiceProfiles: number;
  generationOutputs: number;
  generationInputImages: number;
  avatarSources: number;
  heygenUnlinked: number;
  generationParameters: number;
}

interface CleanupProgress {
  filesDeleted: number;
  filesFailed: number;
  failedPrefixes: string[];
  prefixesTotal: number;
  prefixesDone: number;
  confirmedPrefixes: Set<string>;
  heygenRequested: number;
  heygenFailedIds: string[];
  /** avatar → grupo que a HeyGen confirmou apagado */
  confirmedAvatars: Map<string, string>;
  finalized: FinalizeCounts | null;
  finalizeError: string | null;
}

interface ProgressSnapshot {
  filesDeleted: number;
  filesFailed: number;
  failedPrefixes: string[];
  prefixesTotal: number;
  prefixesDone: number;
  heygenRequested: number;
  heygenFailedIds: string[];
  finalized: FinalizeCounts | null;
  finalizeError: string | null;
}

function emptyDeleted(): AccountErasureReport['deleted'] {
  return {
    refreshTokens: 0,
    passwordResetTokens: 0,
    emailVerificationTokens: 0,
    notifications: 0,
    communityPosts: 0,
    communityLikes: 0,
    follows: 0,
    folders: 0,
    workspaces: 0,
    brands: 0,
    videoProjects: 0,
    feedback: 0,
    voiceProfiles: 0,
    influencers: 0,
    generationOutputs: 0,
    generationInputImages: 0,
    unlimitedUsage: 0,
    freeGenerationBalances: 0,
    weeklyClaims: 0,
    emailSequenceLogs: 0,
    analyticsEvents: 0,
    marketingLeads: 0,
  };
}

function sessionWindowStep(): string {
  return (
    `Uma sessão que já estava aberta ainda pode funcionar por até ${plural(SESSION_CHECK_MINUTES, 'minuto', 'minutos')} ` +
    '(a API confere a conta com um cache curto): rode a exclusão de novo depois disso para garantir que nada novo foi criado.'
  );
}

/**
 * Exclusão de conta pedida pela pessoa (LGPD), feita pelo admin. O acesso cai na hora; os dados da conta, as
 * gerações e os arquivos são apagados ou anonimizados; ficam só os registros de pagamento e fiscais (Payment,
 * CreditTransaction, AffiliateEarning, Subscription) e os de segurança (content_reports, content_safety_events).
 * Rodar de novo é seguro: a 2ª rodada não acha mais nada e mostra zero.
 *
 * Guarda legal (antes de qualquer mudança): denúncia de menor/crime/imagem íntima citando a conta (feita por outra
 * pessoa, ou pela própria citando conteúdo dela), recusa do provedor por menor em pedido com foto ou vídeo enviado
 * (qualquer data), ou 3+ tentativas bloqueadas por menor em pedido só com texto em 90 dias, seguram a conta inteira
 * (bloqueio liberado pelo jurídico não conta). Aí ela só é bloqueada (acesso,
 * sessões, renovação), os posts dela saem do ar, as gerações perdem o prazo de expiração da galeria e nada é
 * anonimizado nem apagado (LGPD art. 16, I, e art. 7º, VI) até o caso ser encerrado (denúncia descartada, ou
 * confirmada e marcada "evidência liberada") e a exclusão rodar de novo. As denúncias são lidas em duas passadas: a
 * tabela inteira antes da transação e, dentro dela, só as candidatas e as criadas ou alteradas desde então.
 *
 * Ordem sem guarda: (1) banco numa transação (bloqueia o acesso, anonimiza, apaga, limpa as gerações); as linhas que
 * são a única pista de uma pasta do bucket ficam, sem conteúdo; (2) renovação das assinaturas, uma a uma, sem deixar
 * um gateway com erro parar o resto; (3) arquivos no bucket e avatar na HeyGen, em paralelo, com teto de tempo; o que
 * passar do teto continua em segundo plano; (4) transação pequena que apaga ou limpa as linhas cujas pastas (e
 * avatares na HeyGen) foram confirmadas. O que falhou fica com a pista e a próxima rodada tenta de novo.
 */
@Injectable()
export class AccountErasureService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(AccountErasureService.name);
  /** contas com exclusão em andamento neste processo (inclui a limpeza de arquivos em segundo plano) */
  private readonly running = new Set<string>();
  private readonly backgroundCleanups = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadsService,
    private readonly stripe: StripeService,
    private readonly cakto: CaktoApiService,
    private readonly asaas: AsaasSubscriptionsService,
    private readonly heygen: HeyGenProvider,
    private readonly config: ConfigService,
  ) {}

  async beforeApplicationShutdown(): Promise<void> {
    await this.drainBackground();
  }

  async erase(
    userId: string,
    options: EraseAccountOptions,
  ): Promise<AccountErasureReport> {
    if (options?.confirm !== true) {
      throw new BadRequestException({
        code: 'ACCOUNT_ERASURE_CONFIRM_REQUIRED',
        message: 'Confirme a exclusão: envie { "confirm": true }.',
      });
    }
    assertSafetyOverride(options.ignoreSafetyEvents, options.reason);
    if (this.running.has(userId)) {
      throw new ConflictException({
        code: 'ACCOUNT_ERASURE_IN_PROGRESS',
        message:
          'A exclusão desta conta já está em andamento. Espere terminar e rode de novo para conferir.',
      });
    }

    this.running.add(userId);
    let releaseInBackground = false;
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, role: true },
      });
      if (!user) throw new NotFoundException('Usuário não encontrado');
      if (user.role === UserRole.ADMIN) {
        throw new ForbiddenException({
          code: 'ACCOUNT_ERASURE_ADMIN',
          message:
            'Conta de administrador não é apagada por aqui: tire o papel de admin antes.',
        });
      }

      const erasedEmail = erasedEmailFor(user.id);
      const alreadyErased = user.email === erasedEmail;
      const originalEmail = holdAccountEmail(user);
      const now = new Date();
      // 1ª passada das denúncias fora da transação (a tabela inteira, em páginas); dentro, só as candidatas e as novas
      const reportScan = await scanReportsCitingAccount(
        this.prisma,
        await readHoldAccount(this.prisma, user.id, originalEmail),
      );
      const context: EraseContext = {
        userId: user.id,
        originalEmail,
        erasedEmail,
        now,
        storage: this.storageLocation(),
        ignoreSafetyEvents: options.ignoreSafetyEvents === true,
        reportScan,
      };

      const phase = await this.prisma.$transaction(
        (tx) => this.runDatabasePhase(tx, context),
        TRANSACTION_OPTIONS,
      );
      if (phase.kind === 'held') {
        // geração que terminou durante a transação da guarda (o processador leu a conta ainda ativa) pode ter gravado
        // o prazo depois da limpeza de dentro dela: tirar de novo logo depois do commit fecha essa janela
        const lateExpiryCleared = await this.clearLateExpiry(user.id);
        phase.hold.generationsExpiryCleared += lateExpiryCleared;
        phase.held.generationsExpiryCleared += lateExpiryCleared;
      }
      // Conta gravada como inativa (com ou sem guarda): a sessão aberta cai já na próxima requisição a ESTE processo.
      // As outras instâncias da API só percebem quando o cache delas vence (até ACTIVE_USER_CACHE_TTL_MS).
      invalidateActiveUser(user.id);
      // com ou sem guarda: a renovação é desligada (a pessoa pediu para sair; guardar evidência não é cobrar)
      const subscriptions = await this.cancelSubscriptions(user.id);
      const storageConfigured = Boolean(this.config.get<string>('S3_ENDPOINT'));

      if (phase.kind === 'held') {
        const report = this.buildHeldReport({
          userId: user.id,
          alreadyErased,
          options,
          now,
          hold: phase.hold,
          held: phase.held,
          subscriptions,
          storageConfigured,
        });
        this.logger.warn(
          `account-erasure: conta ${user.id} só BLOQUEADA (guarda legal: ${phase.hold.kinds.join(', ')}) a pedido de ` +
            `${report.requestedBy ?? 'admin'}${report.reason ? ` (motivo: ${report.reason})` : ''}: ${JSON.stringify(
              {
                reportIds: phase.hold.reportIds,
                minorBlockedEvents: phase.hold.minorBlockedEvents,
                minorBlockedAttempts: phase.hold.minorBlockedAttempts,
                providerMinorBlockedEvents:
                  phase.hold.providerMinorBlockedEvents,
                generationsExpiryCleared: phase.hold.generationsExpiryCleared,
                sessionsRevoked: report.sessionsRevoked,
                subscriptions: subscriptions.map(
                  (outcome) => `${outcome.gateway}:${outcome.result}`,
                ),
              },
            )}`,
        );
        return report;
      }

      // checagens de imagem e texto da conta: ficam só veredito, regra e data (sem hash, chave nem idades)
      await this.minimizeSafetyScans(user.id);
      const plan = phase.erasure.plan;
      const cleanup = this.startExternalCleanup(plan, storageConfigured);
      const completed = await this.settleWithin(
        cleanup.done,
        this.syncBudgetMs(),
      );
      if (!completed) {
        releaseInBackground = true;
        this.continueInBackground(user.id, cleanup);
      }

      const report = this.buildErasedReport({
        userId: user.id,
        alreadyErased,
        options,
        now,
        hold: phase.hold,
        erasure: phase.erasure,
        subscriptions,
        progress: this.snapshot(cleanup.progress),
        storageConfigured,
        completed,
      });
      this.logger.log(
        `account-erasure: conta ${user.id} apagada por ${report.requestedBy ?? 'admin'}` +
          `${report.reason ? ` (motivo: ${report.reason})` : ''}: ${JSON.stringify(
            {
              alreadyErased,
              sessionsRevoked: report.sessionsRevoked,
              generationsScrubbed: report.generationsScrubbed,
              generationsKeptAsEvidence: report.generationsKeptAsEvidence,
              filesDeleted: report.filesDeleted,
              filesFailed: report.filesFailed,
              storageCompleted: completed,
              finalized: report.storage.finalized,
              heygenFailed: report.providers.heygenAvatarGroups.failedIds,
              subscriptions: subscriptions.map(
                (outcome) => `${outcome.gateway}:${outcome.result}`,
              ),
              ignoredMinorBlockedEvents:
                context.ignoreSafetyEvents &&
                phase.hold.minorBlockedAttempts >= MINOR_BLOCKED_HOLD_THRESHOLD
                  ? phase.hold.minorBlockedEvents
                  : 0,
              ignoredMinorBlockedAttempts:
                context.ignoreSafetyEvents &&
                phase.hold.minorBlockedAttempts >= MINOR_BLOCKED_HOLD_THRESHOLD
                  ? phase.hold.minorBlockedAttempts
                  : 0,
            },
          )}`,
      );
      return report;
    } finally {
      if (!releaseInBackground) this.running.delete(userId);
    }
  }

  /**
   * Conta apagada sem guarda legal: as checagens da segurança de imagem e texto perdem hash, pHash, chave do arquivo e
   * sinais (idade por rosto) na hora; a linha com evidência guardada fica inteira. Melhor esforço depois do commit: a
   * falha vira log e o cron de minimização das checagens apaga os sinais no prazo dele.
   */
  private async minimizeSafetyScans(userId: string): Promise<void> {
    try {
      await minimizeAccountScans(this.prisma, userId);
    } catch (error) {
      this.logger.warn(
        `account-erasure: conta ${userId}: checagens de segurança não minimizadas agora (${errorMessage(error)}); o cron de minimização apaga os sinais no prazo`,
      );
    }
  }

  /** Espera a limpeza de arquivos em segundo plano (desligamento do servidor; teto para nunca travar). */
  async drainBackground(timeoutMs = 30_000): Promise<void> {
    if (!this.backgroundCleanups.size) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    });
    const drain = (async () => {
      while (this.backgroundCleanups.size)
        await Promise.allSettled([...this.backgroundCleanups]);
    })();
    await Promise.race([drain, timeout]);
    if (timer) clearTimeout(timer);
  }

  // ─── 1. Banco ──────────────────────────────────────────────────────────────

  private async runDatabasePhase(
    tx: Prisma.TransactionClient,
    context: EraseContext,
  ): Promise<DatabasePhase> {
    const { userId, now } = context;

    // O que a conta tem, lido dentro da transação e antes de qualquer mudança.
    const rows: AccountRows = {
      generations: await tx.generation.findMany({
        where: { userId },
        select: GENERATION_SELECT,
      }),
      posts: await tx.communityPost.findMany({
        where: { userId },
        select: { id: true, generationId: true },
      }),
      avatars: await tx.userAvatar.findMany({
        where: { userId },
        select: AVATAR_SELECT,
      }),
      voices: await tx.voiceProfile.findMany({
        where: { userId },
        select: VOICE_SELECT,
      }),
    };
    const account: HoldAccount = {
      userId,
      email: context.originalEmail,
      generations: rows.generations.map((generation) => ({
        id: generation.id,
        userAvatarId: generation.userAvatarId,
        voiceProfileId: generation.voiceProfileId,
      })),
      posts: rows.posts,
      avatarIds: rows.avatars.map((avatar) => avatar.id),
      voiceProfileIds: rows.voices.map((voice) => voice.id),
    };
    const hold = await loadLegalHold(tx, {
      account,
      scan: context.reportScan,
      now,
      ignoreSafetyEvents: context.ignoreSafetyEvents,
    });

    if (hold.active) {
      const held = await this.holdAccount(tx, context);
      return {
        kind: 'held',
        hold: {
          ...hold,
          communityPostsUnpublished: held.communityPostsUnpublished,
          generationsExpiryCleared: held.generationsExpiryCleared,
        },
        held,
      };
    }
    return {
      kind: 'erased',
      hold,
      erasure: await this.eraseAccountData(tx, context, rows),
    };
  }

  /**
   * Guarda legal: só bloqueia (acesso, sessões, e-mails de cobrança), tira os posts da comunidade do ar e tira o prazo
   * de expiração das gerações (senão o cron da galeria apagaria a evidência quando o prazo do plano vencesse); nada é
   * anonimizado, limpo ou apagado.
   */
  private async holdAccount(
    tx: Prisma.TransactionClient,
    context: EraseContext,
  ): Promise<HeldDatabase> {
    const { userId, now } = context;
    await tx.user.update({
      where: { id: userId },
      // a pessoa pediu para sair: sem login e sem marketing; o resto da linha fica como evidência
      data: { isActive: false, marketingOptOut: true },
    });
    const access = await this.revokeAccess(tx, userId, now);
    // conteúdo sob denúncia não pode seguir publicado (nem ir ao ar depois): a linha fica, só sai do feed
    const communityPostsUnpublished = (
      await tx.communityPost.updateMany({
        where: { userId, status: { in: VISIBLE_POST_STATUSES } },
        data: {
          status: CommunityPostStatus.REJECTED,
          rejectionReason: LEGAL_HOLD_POST_REJECTION_REASON,
        },
      })
    ).count;
    // na mesma transação do bloqueio: geração que ainda terminar depois disso fica de fora do cron pela conta inativa
    const generationsExpiryCleared = (
      await tx.generation.updateMany({
        where: { userId, expiresAt: { not: null } },
        data: { expiresAt: null },
      })
    ).count;
    const recoveryCampaigns = await this.closeRecoveryCampaigns(
      tx,
      userId,
      now,
      { scrubCard: false },
    );
    return {
      access,
      recoveryCampaigns,
      communityPostsUnpublished,
      generationsExpiryCleared,
      kept: await this.countKept(tx, userId),
    };
  }

  /**
   * Depois do commit da guarda: tira o prazo de expiração que uma geração concluída no meio dela gravou (o processador
   * não grava prazo para conta inativa, mas pode ter lido a conta antes do commit). Melhor esforço: a guarda já está
   * gravada; a falha vira log e a próxima rodada da exclusão tira de novo.
   */
  private async clearLateExpiry(userId: string): Promise<number> {
    try {
      const cleared = await this.prisma.generation.updateMany({
        where: { userId, expiresAt: { not: null } },
        data: { expiresAt: null },
      });
      return cleared.count;
    } catch (error) {
      this.logger.error(
        `account-erasure: conta ${userId} sob guarda: falha ao conferir o prazo das gerações depois do commit ` +
          `(${errorMessage(error)}); rode a exclusão de novo para tirar o prazo de alguma geração concluída no meio`,
      );
      return 0;
    }
  }

  private async revokeAccess(
    tx: Prisma.TransactionClient,
    userId: string,
    now: Date,
  ): Promise<AccessRevocation> {
    const sessionsRevoked = await tx.refreshToken.count({
      where: { userId, revoked: false, expiresAt: { gt: now } },
    });
    const refreshTokens = (
      await tx.refreshToken.deleteMany({ where: { userId } })
    ).count;
    const passwordResetTokens = (
      await tx.passwordResetToken.deleteMany({ where: { userId } })
    ).count;
    const emailVerificationTokens = (
      await tx.emailVerificationToken.deleteMany({ where: { userId } })
    ).count;
    return {
      sessionsRevoked,
      refreshTokens,
      passwordResetTokens,
      emailVerificationTokens,
    };
  }

  /** O que fica guardado (contagem para o relatório; nada disso é alterado). */
  private async countKept(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<AccountErasureReport['kept']> {
    const affiliate = await tx.affiliate.findUnique({
      where: { userId },
      select: { id: true },
    });
    return {
      payments: await tx.payment.count({ where: { userId } }),
      creditTransactions: await tx.creditTransaction.count({
        where: { userId },
      }),
      affiliateEarnings: await tx.affiliateEarning.count({
        where: {
          OR: [
            { userId },
            ...(affiliate ? [{ affiliateId: affiliate.id }] : []),
          ],
        },
      }),
      subscriptions: await tx.subscription.count({ where: { userId } }),
      generations: await tx.generation.count({ where: { userId } }),
      contentReports: await tx.contentReport.count({
        where: { reporterUserId: userId },
      }),
      contentSafetyEvents: await tx.contentSafetyEvent.count({
        where: { userId },
      }),
    };
  }

  private async eraseAccountData(
    tx: Prisma.TransactionClient,
    context: EraseContext,
    rows: AccountRows,
  ): Promise<DatabaseErasure> {
    const { userId, originalEmail, erasedEmail, now } = context;
    const { generations, posts, avatars, voices } = rows;
    const deleted = emptyDeleted();

    // Acesso bloqueado e dados pessoais da conta fora. Ficam os ids dos gateways (conciliação dos pagamentos),
    // o aceite do termo, moeda, idioma e o código de quem indicou (comissões guardadas).
    await tx.user.update({
      where: { id: userId },
      data: {
        email: erasedEmail,
        name: ERASED_USER_NAME,
        passwordHash: null,
        avatarUrl: null,
        oauthProvider: null,
        oauthProviderId: null,
        phone: null,
        phoneVerified: null,
        taxId: null,
        fbclid: null,
        fbp: null,
        fbc: null,
        gclid: null,
        landingPage: null,
        referrer: null,
        utmCampaign: null,
        utmContent: null,
        utmMedium: null,
        utmSource: null,
        utmTerm: null,
        country: null,
        timezone: null,
        marketingOptOut: true,
        isActive: false,
        unlimitedModeImage: false,
        unlimitedModeVideo: false,
      },
    });

    const access = await this.revokeAccess(tx, userId, now);
    deleted.refreshTokens = access.refreshTokens;
    deleted.passwordResetTokens = access.passwordResetTokens;
    deleted.emailVerificationTokens = access.emailVerificationTokens;

    // Comunidade: curtidas (e o contador dos posts curtidos), posts, seguidores, notificações.
    const likedPostIds = [
      ...new Set(
        (
          await tx.communityPostLike.findMany({
            where: { userId },
            select: { postId: true },
          })
        ).map((like) => like.postId),
      ),
    ];
    deleted.communityLikes = likedPostIds.length
      ? (await tx.communityPostLike.deleteMany({ where: { userId } })).count
      : 0;
    for (const ids of chunk(likedPostIds)) {
      await tx.communityPost.updateMany({
        where: { id: { in: ids }, likesCount: { gt: 0 } },
        data: { likesCount: { decrement: 1 } },
      });
    }
    for (const ids of chunk(posts.map((post) => post.id))) {
      await tx.communityPostLike.deleteMany({ where: { postId: { in: ids } } });
      deleted.communityPosts += (
        await tx.communityPost.deleteMany({ where: { id: { in: ids } } })
      ).count;
    }
    deleted.follows = (
      await tx.userFollow.deleteMany({
        where: { OR: [{ followerId: userId }, { followingId: userId }] },
      })
    ).count;
    deleted.notifications =
      (await tx.notification.deleteMany({ where: { userId } })).count +
      // "fulano começou a seguir você" na caixa de outras pessoas leva o nome desta conta
      (
        await tx.notification.deleteMany({
          where: {
            type: 'user-followed',
            data: { path: ['followerId'], equals: userId },
          },
        })
      ).count;

    // Organização do conteúdo: pastas, quadros, marcas, editor de vídeo, pesquisa de satisfação.
    const folderIds = (
      await tx.folder.findMany({ where: { userId }, select: { id: true } })
    ).map((folder) => folder.id);
    for (const ids of chunk(folderIds))
      await tx.generationFolder.deleteMany({
        where: { folderId: { in: ids } },
      });
    for (const ids of chunk(generations.map((generation) => generation.id))) {
      await tx.generationFolder.deleteMany({
        where: { generationId: { in: ids } },
      });
    }
    deleted.folders = (await tx.folder.deleteMany({ where: { userId } })).count;

    // Quadros: a linha fica, sem conteúdo, até a pasta workspaces/<id>/ sair do bucket (é a única pista dela).
    const workspaces = await tx.workspace.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        nodes: true,
        edges: true,
        viewport: true,
        thumbnailUrl: true,
        favorite: true,
      },
    });
    const isEmptyList = (value: Prisma.JsonValue): boolean =>
      Array.isArray(value) && value.length === 0;
    const workspacesToScrub = workspaces
      .filter(
        (workspace) =>
          workspace.name !== ERASED_WORKSPACE_NAME ||
          !isEmptyList(workspace.nodes) ||
          !isEmptyList(workspace.edges) ||
          workspace.viewport !== null ||
          workspace.thumbnailUrl !== null ||
          workspace.favorite,
      )
      .map((workspace) => workspace.id);
    for (const ids of chunk(workspacesToScrub)) {
      await tx.workspace.updateMany({
        where: { id: { in: ids } },
        data: {
          name: ERASED_WORKSPACE_NAME,
          nodes: [],
          edges: [],
          viewport: Prisma.DbNull,
          thumbnailUrl: null,
          favorite: false,
        },
      });
    }
    const workspaceItems: CleanupItem[] = workspaces.map((workspace) => ({
      id: workspace.id,
      prefixes: safePrefixes([
        ID_SEGMENT.test(workspace.id) ? `workspaces/${workspace.id}/` : null,
      ]),
    }));

    deleted.brands = (await tx.brand.deleteMany({ where: { userId } })).count;

    // Editor de vídeo: os cortes saem; o projeto fica, sem nome nem erro, até a pasta do vídeo montado sair do bucket.
    const projects = await tx.videoProject.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        outputUrl: true,
        outputThumbnailUrl: true,
        errorMessage: true,
      },
    });
    for (const ids of chunk(projects.map((project) => project.id))) {
      await tx.videoProjectClip.deleteMany({
        where: { projectId: { in: ids } },
      });
    }
    const projectsToScrub = projects
      .filter(
        (project) =>
          project.name !== ERASED_VIDEO_PROJECT_NAME ||
          project.outputThumbnailUrl !== null ||
          project.errorMessage !== null,
      )
      .map((project) => project.id);
    for (const ids of chunk(projectsToScrub)) {
      await tx.videoProject.updateMany({
        where: { id: { in: ids } },
        data: {
          name: ERASED_VIDEO_PROJECT_NAME,
          outputThumbnailUrl: null,
          errorMessage: null,
        },
      });
    }
    const videoProjectItems: CleanupItem[] = projects.map((project) => ({
      id: project.id,
      prefixes: safePrefixes([
        videoRenderFolder(project.id, project.outputUrl, context.storage),
      ]),
    }));

    deleted.feedback = (
      await tx.feedback.deleteMany({ where: { userId } })
    ).count;

    // Vozes e influencers: solta os vínculos das gerações (que ficam). Influencer sai; a voz fica, sem dados, até a
    // pasta voices/<id da conta>/ sair do bucket.
    const voiceIds = voices.map((voice) => voice.id);
    const influencerIds = (
      await tx.influencers.findMany({
        where: { user_id: userId },
        select: { id: true },
      })
    ).map((influencer) => influencer.id);
    for (const ids of chunk(voiceIds)) {
      await tx.generation.updateMany({
        where: { voiceProfileId: { in: ids } },
        data: { voiceProfileId: null },
      });
      await tx.influencers.updateMany({
        where: { voice_profile_id: { in: ids } },
        data: { voice_profile_id: null },
      });
    }
    for (const ids of chunk(influencerIds)) {
      await tx.generation.updateMany({
        where: { influencer_id: { in: ids } },
        data: { influencer_id: null },
      });
    }
    deleted.influencers = (
      await tx.influencers.deleteMany({ where: { user_id: userId } })
    ).count;
    const voicesToScrub = voices
      .filter(
        (voice) =>
          voice.name !== ERASED_VOICE_NAME ||
          voice.sampleUrl !== '' ||
          voice.sampleMime !== null ||
          voice.previewUrl !== null ||
          voice.previewText !== null ||
          !voice.isDeleted,
      )
      .map((voice) => voice.id);
    for (const ids of chunk(voicesToScrub)) {
      await tx.voiceProfile.updateMany({
        where: { id: { in: ids } },
        data: {
          name: ERASED_VOICE_NAME,
          sampleUrl: '',
          sampleMime: null,
          previewUrl: null,
          previewText: null,
          isDeleted: true,
          deletedAt: now,
        },
      });
    }
    const voicesPrefix = safePrefixes([
      ID_SEGMENT.test(userId) ? `voices/${userId}/` : null,
    ]);
    const voiceItems: CleanupItem[] = voiceIds.map((id) => ({
      id,
      prefixes: voicesPrefix,
    }));

    // Avatares: a linha fica anonimizada (o débito do treino em credit_transactions aponta para ela). A chave do vídeo
    // de origem e o grupo na HeyGen ficam até o bucket e a HeyGen confirmarem (são a única pista do que apagar).
    let userAvatars = 0;
    const avatarSourceItems: CleanupItem[] = [];
    for (const avatar of avatars) {
      const sourceFolder = uploadFolderFromKey(
        avatar.sourceVideoKey,
        'avatar_source',
      );
      const keepSourceKey = sourceFolder ? avatar.sourceVideoKey : '';
      const keepLookId = avatar.heygenGroupId ? avatar.heygenLookId : null;
      if (sourceFolder)
        avatarSourceItems.push({
          id: avatar.id,
          prefixes: safePrefixes([sourceFolder]),
        });
      const needsScrub =
        avatar.name !== ERASED_AVATAR_NAME ||
        avatar.sourceVideoKey !== keepSourceKey ||
        avatar.sourceVideoUrl !== '' ||
        avatar.heygenLookId !== keepLookId ||
        avatar.consentUrl !== null ||
        avatar.previewImageUrl !== null ||
        avatar.previewVideoUrl !== null ||
        avatar.defaultVoiceId !== null ||
        avatar.errorMessage !== null ||
        !avatar.isDeleted;
      if (!needsScrub) continue;
      userAvatars++;
      await tx.userAvatar.update({
        where: { id: avatar.id },
        data: {
          name: ERASED_AVATAR_NAME,
          status: AvatarStatus.DELETING,
          sourceVideoKey: keepSourceKey,
          sourceVideoUrl: '',
          heygenLookId: keepLookId,
          consentUrl: null,
          previewImageUrl: null,
          previewVideoUrl: null,
          defaultVoiceId: null,
          errorMessage: null,
          isDeleted: true,
          deletedAt: avatar.deletedAt ?? now,
        },
      });
    }

    // Gerações: a linha fica (créditos, cobrança, ligação com registro de segurança); texto e vínculo saem agora.
    // Saídas e imagens de entrada saem na 2ª etapa, depois das pastas da geração. Geração com bloqueio por menor ligado
    // a ela (e não liberado pelo jurídico) é evidência (com mídia da conta, a guarda provider_minor já segura a conta;
    // isto cobre a recusa a pedido só com texto, o evento sem userId e o gravado no meio da transação): texto,
    // entradas, saídas e pastas dela ficam intactos em todos os caminhos daqui para frente.
    const evidenceGenerationIds = await minorBlockedGenerationIds(
      tx,
      generations.map((generation) => generation.id),
    );
    const erasableGenerations = generations.filter(
      (generation) => !evidenceGenerationIds.has(generation.id),
    );
    const generationIds = erasableGenerations.map(
      (generation) => generation.id,
    );
    const withOutputs = new Set<string>();
    const withInputs = new Set<string>();
    for (const ids of chunk(generationIds)) {
      for (const row of await tx.generationOutput.findMany({
        where: { generationId: { in: ids } },
        select: { generationId: true },
      })) {
        withOutputs.add(row.generationId);
      }
      for (const row of await tx.generationInputImage.findMany({
        where: { generationId: { in: ids } },
        select: { generationId: true },
      })) {
        withInputs.add(row.generationId);
      }
    }
    deleted.unlimitedUsage = (
      await tx.unlimitedUsage.deleteMany({ where: { userId } })
    ).count;

    const scrubGroups = new Map<
      string,
      {
        parameters: Record<string, string | number | boolean> | null;
        ids: string[];
      }
    >();
    const generationItems: GenerationCleanupItem[] = [];
    let generationsScrubbed = 0;
    for (const generation of erasableGenerations) {
      const parameters = scrubbedGenerationParameters(generation.parameters);
      const hasRows =
        withOutputs.has(generation.id) || withInputs.has(generation.id);
      if (hasRows || parameters.audioFolder) {
        generationItems.push({
          id: generation.id,
          prefixes: safePrefixes([
            ...generationStoragePrefixes(generation.id),
            parameters.audioFolder,
          ]),
          hasRows,
          ...(parameters.audioFolder
            ? { finalParameters: parameters.final }
            : {}),
        });
      }
      const needsScrub =
        generation.prompt !== null ||
        generation.negativePrompt !== null ||
        generation.errorMessage !== null ||
        !generation.isDeleted ||
        generation.isFavorited ||
        generation.voiceProfileId !== null ||
        generation.influencer_id !== null ||
        hasRows ||
        !parametersAlreadyScrubbed(generation.parameters);
      if (!needsScrub) continue;
      generationsScrubbed++;
      const key = canonicalJson(parameters.interim);
      const group = scrubGroups.get(key) ?? {
        parameters: parameters.interim,
        ids: [],
      };
      group.ids.push(generation.id);
      scrubGroups.set(key, group);
    }
    for (const group of scrubGroups.values()) {
      for (const ids of chunk(group.ids)) {
        await tx.generation.updateMany({
          where: { id: { in: ids } },
          data: {
            prompt: null,
            negativePrompt: null,
            errorMessage: null,
            isDeleted: true,
            isFavorited: false,
            voiceProfileId: null,
            influencer_id: null,
            parameters: group.parameters ?? Prisma.DbNull,
          },
        });
      }
    }
    const generationsInFlight = generations.filter((generation) =>
      IN_FLIGHT_GENERATION.has(generation.status),
    ).length;

    // Contadores e registros auxiliares sem valor fiscal.
    deleted.freeGenerationBalances = (
      await tx.userFreeGeneration.deleteMany({ where: { userId } })
    ).count;
    deleted.weeklyClaims = (
      await tx.weeklyClaim.deleteMany({ where: { userId } })
    ).count;
    deleted.emailSequenceLogs = (
      await tx.emailSequenceLog.deleteMany({ where: { userId } })
    ).count;
    deleted.analyticsEvents = (
      await tx.analyticsEvent.deleteMany({ where: { userId } })
    ).count;
    deleted.marketingLeads = originalEmail
      ? (
          await tx.marketingLead.deleteMany({
            where: { email: { equals: originalEmail, mode: 'insensitive' } },
          })
        ).count
      : 0;

    // Registros que ficam, sem o e-mail: destinatários de campanha (estatística) e isca comprada (venda no gateway).
    const sameEmail = originalEmail
      ? [
          {
            email: {
              equals: originalEmail,
              mode: Prisma.QueryMode.insensitive,
            },
          },
        ]
      : [];
    const broadcastRecipients = (
      await tx.emailBroadcastRecipient.updateMany({
        where: { OR: [{ userId }, ...sameEmail], NOT: { email: erasedEmail } },
        data: { email: erasedEmail, name: null },
      })
    ).count;
    const freeGenerationGrants = (
      await tx.pendingFreeGenerationGrant.updateMany({
        where: {
          OR: [{ consumedByUserId: userId }, ...sameEmail],
          NOT: { email: erasedEmail },
        },
        data: { email: erasedEmail },
      })
    ).count;

    const recoveryCampaigns = await this.closeRecoveryCampaigns(
      tx,
      userId,
      now,
      { scrubCard: true },
    );

    // Afiliado: chave PIX e nome fora, desativado; as comissões ficam.
    const affiliate = await tx.affiliate.findUnique({
      where: { userId },
      select: {
        id: true,
        name: true,
        pixKey: true,
        pixKeyType: true,
        isActive: true,
      },
    });
    let affiliateScrubbed = 0;
    if (
      affiliate &&
      (affiliate.isActive ||
        affiliate.pixKey !== null ||
        affiliate.pixKeyType !== null ||
        affiliate.name !== ERASED_AFFILIATE_NAME)
    ) {
      await tx.affiliate.update({
        where: { id: affiliate.id },
        data: {
          name: ERASED_AFFILIATE_NAME,
          pixKey: null,
          pixKeyType: null,
          isActive: false,
        },
      });
      affiliateScrubbed = 1;
    }

    const kept = await this.countKept(tx, userId);

    // Pastas no bucket: as das linhas que ficaram como pista e as de cada geração (o id da geração não some).
    const prefixes = safePrefixes([
      ...avatarSourceItems.flatMap((item) => item.prefixes),
      ...generationItems.flatMap((item) => item.prefixes),
      ...workspaceItems.flatMap((item) => item.prefixes),
      ...videoProjectItems.flatMap((item) => item.prefixes),
      ...voicesPrefix,
      ...erasableGenerations.flatMap((generation) =>
        generationStoragePrefixes(generation.id),
      ),
    ]);

    return {
      access,
      generationsScrubbed,
      generationsInFlight,
      generationsKeptAsEvidence: evidenceGenerationIds.size,
      deleted,
      scrubbed: {
        userAvatars,
        recoveryCampaigns,
        broadcastRecipients,
        freeGenerationGrants,
        affiliate: affiliateScrubbed,
      },
      kept,
      plan: {
        prefixes,
        workspaces: workspaceItems,
        videoProjects: videoProjectItems,
        avatarSources: avatarSourceItems,
        voices: voiceItems,
        generations: generationItems,
        heygen: avatars
          .filter((avatar) => Boolean(avatar.heygenGroupId))
          .map((avatar) => ({
            avatarId: avatar.id,
            groupId: avatar.heygenGroupId as string,
          })),
      },
    };
  }

  /**
   * Campanha de recuperação de cobrança: fecha a aberta e (na exclusão) tira os dados do cartão. Assinatura Stripe
   * com falha de pagamento e sem campanha ganha uma já encerrada: sem ela o cron de recuperação inscreveria a
   * assinatura, buscaria o cartão na Stripe de novo e mandaria e-mail de cobrança para quem pediu para sair.
   */
  private async closeRecoveryCampaigns(
    tx: Prisma.TransactionClient,
    userId: string,
    now: Date,
    options: { scrubCard: boolean },
  ): Promise<number> {
    const campaigns = await tx.paymentRecoveryCampaign.findMany({
      where: { userId },
      select: {
        id: true,
        subscriptionId: true,
        recoveredAt: true,
        abandonedAt: true,
        cardBrand: true,
        cardLast4: true,
        declineCode: true,
      },
    });
    const open = campaigns
      .filter((campaign) => !campaign.recoveredAt && !campaign.abandonedAt)
      .map((campaign) => campaign.id);
    const withCard = options.scrubCard
      ? campaigns
          .filter(
            (campaign) =>
              campaign.cardBrand !== null ||
              campaign.cardLast4 !== null ||
              campaign.declineCode !== null,
          )
          .map((campaign) => campaign.id)
      : [];
    for (const ids of chunk(open))
      await tx.paymentRecoveryCampaign.updateMany({
        where: { id: { in: ids } },
        data: { abandonedAt: now },
      });
    for (const ids of chunk(withCard)) {
      await tx.paymentRecoveryCampaign.updateMany({
        where: { id: { in: ids } },
        data: { cardBrand: null, cardLast4: null, declineCode: null },
      });
    }

    const withCampaign = new Set(
      campaigns.map((campaign) => campaign.subscriptionId),
    );
    const failedStripe = await tx.subscription.findMany({
      where: {
        userId,
        paymentProvider: 'stripe',
        OR: [
          { status: SubscriptionStatus.PAST_DUE },
          { paymentRetryCount: { gt: 0 } },
        ],
      },
      select: { id: true },
    });
    const missing = failedStripe
      .map((subscription) => subscription.id)
      .filter((id) => !withCampaign.has(id));
    const blocked = missing.length
      ? (
          await tx.paymentRecoveryCampaign.createMany({
            data: missing.map((subscriptionId) => ({
              userId,
              subscriptionId,
              enrolledAt: now,
              abandonedAt: now,
            })),
            skipDuplicates: true,
          })
        ).count
      : 0;
    return new Set([...open, ...withCard]).size + blocked;
  }

  // ─── 2. Assinaturas ────────────────────────────────────────────────────────

  private async cancelSubscriptions(
    userId: string,
  ): Promise<SubscriptionErasureOutcome[]> {
    let subscriptions: Subscription[];
    try {
      subscriptions = await this.prisma.subscription.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
    } catch (error) {
      this.logger.error(
        `account-erasure: não deu para ler as assinaturas da conta ${userId}: ${errorMessage(error)}`,
      );
      return [];
    }
    const outcomes: SubscriptionErasureOutcome[] = [];
    // uma por vez: o gateway de uma não pode derrubar as outras
    for (const subscription of subscriptions)
      outcomes.push(await this.cancelSubscription(subscription));
    return outcomes;
  }

  /**
   * Desliga a renovação seguindo as mesmas regras do SubscriptionsService.cancel (Stripe: cancel_at_period_end;
   * Cakto: API de cancelamento; Perfect Pay: sem API, só marca aqui) e do cancelamento do PIX Automático (autorização
   * cancelada no Asaas, como no webhook). Não usa o cancel(userId) direto porque ele só acha a primeira assinatura
   * ACTIVE, ignora PAST_DUE/TRIALING, engole a falha da Cakto (o relatório diria "cancelada" sem estar) e não cancela
   * a autorização do PIX Automático (o cron de cobrança continuaria cobrando).
   */
  private async cancelSubscription(
    subscription: Subscription,
  ): Promise<SubscriptionErasureOutcome> {
    const gateway = subscriptionGateway(subscription);
    const base = { id: subscription.id, gateway, status: subscription.status };
    if (!RUNNING_SUBSCRIPTION.has(subscription.status)) {
      return {
        ...base,
        result: 'not_active',
        changed: false,
        detail: 'Assinatura já encerrada.',
      };
    }

    try {
      switch (gateway) {
        case 'stripe':
          return { ...base, ...(await this.cancelStripe(subscription)) };
        case 'cakto':
          return { ...base, ...(await this.cancelCakto(subscription)) };
        case 'perfectpay':
          return { ...base, ...(await this.cancelPerfectPay(subscription)) };
        case 'asaas':
          return { ...base, ...(await this.cancelAsaas(subscription)) };
        case 'none':
        case 'admin':
          return {
            ...base,
            ...(await this.cancelWithoutGateway(subscription)),
          };
        default:
          return {
            ...base,
            result: 'manual_action_required',
            changed: false,
            detail: `Gateway "${gateway}" sem cancelamento automático: cancele a recorrência no painel dele.`,
          };
      }
    } catch (error) {
      if (error instanceof LocalSubscriptionUpdateError) {
        this.logger.error(
          `account-erasure: assinatura ${subscription.id} (${gateway}): ${error.gatewayDone}, mas não gravou aqui: ${error.message}`,
        );
        return {
          ...base,
          result: 'error',
          changed: true,
          detail: `${error.gatewayDone}, mas não deu para gravar aqui (${error.message}). Rode a exclusão de novo.`,
        };
      }
      const message = errorMessage(error);
      this.logger.error(
        `account-erasure: assinatura ${subscription.id} (${gateway}) não foi cancelada: ${message}`,
      );
      return {
        ...base,
        result: 'error',
        changed: false,
        detail: `O gateway recusou o cancelamento (${message}). A renovação pode continuar: rode a exclusão de novo ou cancele no painel do gateway.`,
      };
    }
  }

  private async cancelStripe(
    subscription: Subscription,
  ): Promise<
    Pick<SubscriptionErasureOutcome, 'result' | 'changed' | 'detail'>
  > {
    const endsAt = isoDate(subscription.currentPeriodEnd);
    if (subscription.cancelAtPeriodEnd) {
      return {
        result: 'cancelled',
        changed: false,
        detail: `Renovação já estava cancelada na Stripe; a assinatura termina em ${endsAt}.`,
      };
    }
    if (!subscription.externalSubscriptionId) {
      return {
        result: 'manual_action_required',
        changed: false,
        detail:
          'Assinatura Stripe sem o id da Stripe gravado: confira no painel da Stripe pelo cliente da conta e cancele lá.',
      };
    }
    let detail = `Renovação cancelada na Stripe; a assinatura termina em ${endsAt} e o acesso já está bloqueado.`;
    try {
      await this.stripe.cancelSubscription(subscription.externalSubscriptionId);
    } catch (error) {
      if (!isStripeSubscriptionGone(error)) throw error;
      detail =
        'A Stripe já não tem essa assinatura ativa (cancelada ou inexistente lá); renovação desligada aqui também.';
    }
    await this.markLocal(
      subscription.id,
      { cancelAtPeriodEnd: true, scheduledPlanId: null },
      'Renovação cancelada na Stripe',
    );
    if (subscription.status === SubscriptionStatus.PAST_DUE) {
      detail +=
        ' A fatura em atraso já emitida pode continuar em cobrança pela Stripe: para perdoar, anule a fatura no painel da Stripe.';
    }
    return { result: 'cancelled', changed: true, detail };
  }

  /**
   * Cakto: sempre chama a API de cancelamento (404 = já cancelada lá). O cancelAtPeriodEnd daqui não prova nada: o
   * SubscriptionsService.cancel liga esse campo mesmo quando a API da Cakto falhou. `changed` diz se o banco mudou.
   */
  private async cancelCakto(
    subscription: Subscription,
  ): Promise<
    Pick<SubscriptionErasureOutcome, 'result' | 'changed' | 'detail'>
  > {
    const localNote = subscription.cancelAtPeriodEnd
      ? ' A renovação aparece desligada aqui, mas isso não garante o cancelamento na Cakto.'
      : '';
    if (!subscription.externalSubscriptionId) {
      return {
        result: 'manual_action_required',
        changed: false,
        detail:
          'Assinatura Cakto sem o código da recorrência gravado: cancele no painel da Cakto, achando a venda pelos pagamentos da conta.' +
          localNote,
      };
    }
    if (!this.cakto.isConfigured()) {
      return {
        result: 'manual_action_required',
        changed: false,
        detail:
          `CAKTO_CLIENT_ID/CAKTO_CLIENT_SECRET ausentes na API: cancele a recorrência ${subscription.externalSubscriptionId} no painel da Cakto.` +
          localNote,
      };
    }
    await this.cakto.cancelSubscription(subscription.externalSubscriptionId);
    const endsAt = isoDate(subscription.currentPeriodEnd);
    const changed =
      !subscription.cancelAtPeriodEnd || subscription.scheduledPlanId !== null;
    if (changed) {
      await this.markLocal(
        subscription.id,
        { cancelAtPeriodEnd: true, scheduledPlanId: null },
        'Recorrência cancelada na Cakto',
      );
    }
    return {
      result: 'cancelled',
      changed,
      detail: subscription.cancelAtPeriodEnd
        ? `Cancelamento confirmado na API da Cakto (a renovação já aparecia desligada aqui); a assinatura termina em ${endsAt}.`
        : `Recorrência cancelada na API da Cakto; a assinatura termina em ${endsAt}.`,
    };
  }

  private async cancelPerfectPay(
    subscription: Subscription,
  ): Promise<
    Pick<SubscriptionErasureOutcome, 'result' | 'changed' | 'detail'>
  > {
    const changed = !subscription.cancelAtPeriodEnd;
    if (changed) {
      await this.markLocal(
        subscription.id,
        { cancelAtPeriodEnd: true, scheduledPlanId: null },
        'Perfect Pay sem API de cancelamento',
      );
    }
    const code = subscription.externalSubscriptionId
      ? ` ${subscription.externalSubscriptionId}`
      : '';
    return {
      result: 'manual_action_required',
      changed,
      detail:
        `A Perfect Pay não tem API de cancelamento: a cliente precisa cancelar a assinatura${code} na área do comprador da ` +
        'Perfect Pay (ou o dono cancela pelo painel da Perfect Pay). Aqui a renovação já foi desligada e o acesso está ' +
        `bloqueado; sem o cancelamento lá, a Perfect Pay continua cobrando. Termina aqui em ${isoDate(subscription.currentPeriodEnd)}.`,
    };
  }

  private async cancelAsaas(
    subscription: Subscription,
  ): Promise<
    Pick<SubscriptionErasureOutcome, 'result' | 'changed' | 'detail'>
  > {
    const authorizationId = subscription.asaasAuthorizationId;
    const authorizationLive =
      Boolean(authorizationId) &&
      !ENDED_PIX_AUTHORIZATION.has(subscription.asaasAuthorizationStatus ?? '');
    if (authorizationId && authorizationLive)
      await this.asaas.cancelAuthorization(authorizationId);
    await this.markLocal(
      subscription.id,
      {
        status: SubscriptionStatus.CANCELED,
        // autorização que já tinha acabado (expirada, recusada) fica com o status que tinha
        asaasAuthorizationStatus: authorizationLive
          ? 'CANCELED'
          : subscription.asaasAuthorizationStatus,
        cancelAtPeriodEnd: false,
        scheduledPlanId: null,
      },
      authorizationLive
        ? 'Autorização do PIX Automático cancelada no Asaas'
        : 'PIX Automático sem autorização ativa',
    );
    return {
      result: 'cancelled',
      changed: true,
      detail: authorizationLive
        ? 'Autorização do PIX Automático cancelada no Asaas; assinatura encerrada.'
        : 'Sem autorização ativa do PIX Automático; assinatura encerrada aqui.',
    };
  }

  private async cancelWithoutGateway(
    subscription: Subscription,
  ): Promise<
    Pick<SubscriptionErasureOutcome, 'result' | 'changed' | 'detail'>
  > {
    if (subscription.cancelAtPeriodEnd)
      return {
        result: 'cancelled',
        changed: false,
        detail: 'Renovação já estava desligada.',
      };
    await this.markLocal(
      subscription.id,
      { cancelAtPeriodEnd: true, scheduledPlanId: null },
      'Plano sem gateway',
    );
    return {
      result: 'cancelled',
      changed: true,
      detail: 'Sem gateway de pagamento: renovação desligada aqui.',
    };
  }

  private async markLocal(
    subscriptionId: string,
    data: Prisma.SubscriptionUncheckedUpdateInput,
    gatewayDone: string,
  ): Promise<void> {
    try {
      await this.prisma.subscription.update({
        where: { id: subscriptionId },
        data,
      });
    } catch (error) {
      throw new LocalSubscriptionUpdateError(gatewayDone, error);
    }
  }

  // ─── 3. Arquivos e HeyGen ──────────────────────────────────────────────────

  private startExternalCleanup(
    plan: CleanupPlan,
    storageConfigured: boolean,
  ): { progress: CleanupProgress; done: Promise<void> } {
    const prefixes = storageConfigured ? plan.prefixes : [];
    const progress: CleanupProgress = {
      filesDeleted: 0,
      filesFailed: 0,
      failedPrefixes: [],
      prefixesTotal: prefixes.length,
      prefixesDone: 0,
      confirmedPrefixes: new Set(),
      heygenRequested: 0,
      heygenFailedIds: [],
      confirmedAvatars: new Map(),
      finalized: null,
      finalizeError: null,
    };
    const tasks: Array<() => Promise<void>> = [
      ...plan.heygen.map(({ avatarId, groupId }) => async () => {
        try {
          await this.heygen.deleteAvatarGroupStrict(groupId);
          progress.heygenRequested++;
          progress.confirmedAvatars.set(avatarId, groupId);
        } catch (error) {
          progress.heygenFailedIds.push(groupId);
          this.logger.warn(
            `account-erasure: avatar ${groupId} não foi apagado na HeyGen: ${errorMessage(error)}`,
          );
        }
      }),
      ...prefixes.map((prefix) => async () => {
        try {
          // estrito: objeto recusado pelo bucket (Errors[] do DeleteObjects) faz a pasta falhar, não some calado.
          // O await antes da soma: `x += await y` lê x antes de esperar e as tarefas paralelas apagariam a soma umas das outras
          const deleted = await this.uploads.deleteByPrefixStrict(prefix);
          progress.filesDeleted += deleted;
          progress.confirmedPrefixes.add(prefix);
        } catch (error) {
          // o que o bucket confirmou antes da falha saiu de verdade; a pasta não está confirmada e a pista fica
          if (error instanceof StorageDeleteError)
            progress.filesDeleted += error.deleted;
          progress.filesFailed++;
          progress.failedPrefixes.push(prefix);
          this.logger.warn(
            `account-erasure: pasta ${prefix} não foi apagada: ${errorMessage(error)}`,
          );
        } finally {
          progress.prefixesDone++;
        }
      }),
    ];
    const done = runWithConcurrency(tasks, STORAGE_CONCURRENCY)
      .then(() => this.finalizeCleanup(plan, progress))
      .catch((error: unknown) => {
        // a 2ª etapa não rodou: o relatório não pode dizer que terminou
        progress.finalizeError ??= errorMessage(error);
        this.logger.error(
          `account-erasure: limpeza de arquivos parou: ${errorMessage(error)}`,
        );
      });
    return { progress, done };
  }

  /**
   * 2ª etapa: com as pastas e os avatares confirmados, apaga ou limpa as linhas que eram a pista deles. O que falhou
   * fica com a pista para a próxima rodada tentar de novo.
   */
  private async finalizeCleanup(
    plan: CleanupPlan,
    progress: CleanupProgress,
  ): Promise<void> {
    const ready = (item: CleanupItem): boolean =>
      item.prefixes.every((prefix) => progress.confirmedPrefixes.has(prefix));
    const readyIds = (items: CleanupItem[]): string[] =>
      items.filter(ready).map((item) => item.id);
    const workspaceIds = readyIds(plan.workspaces);
    const projectIds = readyIds(plan.videoProjects);
    const avatarSourceIds = readyIds(plan.avatarSources);
    const voiceIds = readyIds(plan.voices);
    const generations = plan.generations.filter(ready);
    const heygen = [...progress.confirmedAvatars.entries()];
    if (
      !workspaceIds.length &&
      !projectIds.length &&
      !avatarSourceIds.length &&
      !voiceIds.length &&
      !generations.length &&
      !heygen.length
    ) {
      progress.finalized = {
        workspaces: 0,
        videoProjects: 0,
        voiceProfiles: 0,
        generationOutputs: 0,
        generationInputImages: 0,
        avatarSources: 0,
        heygenUnlinked: 0,
        generationParameters: 0,
      };
      return;
    }

    try {
      progress.finalized = await this.prisma.$transaction(async (tx) => {
        const counts: FinalizeCounts = {
          workspaces: 0,
          videoProjects: 0,
          voiceProfiles: 0,
          generationOutputs: 0,
          generationInputImages: 0,
          avatarSources: 0,
          heygenUnlinked: 0,
          generationParameters: 0,
        };
        for (const ids of chunk(workspaceIds))
          counts.workspaces += (
            await tx.workspace.deleteMany({ where: { id: { in: ids } } })
          ).count;
        for (const ids of chunk(projectIds)) {
          await tx.videoProjectClip.deleteMany({
            where: { projectId: { in: ids } },
          });
          counts.videoProjects += (
            await tx.videoProject.deleteMany({ where: { id: { in: ids } } })
          ).count;
        }
        for (const ids of chunk(voiceIds)) {
          // a geração pode ter voltado a apontar para a voz (geração em andamento): solta antes de apagar
          await tx.generation.updateMany({
            where: { voiceProfileId: { in: ids } },
            data: { voiceProfileId: null },
          });
          await tx.influencers.updateMany({
            where: { voice_profile_id: { in: ids } },
            data: { voice_profile_id: null },
          });
          counts.voiceProfiles += (
            await tx.voiceProfile.deleteMany({ where: { id: { in: ids } } })
          ).count;
        }
        for (const ids of chunk(avatarSourceIds))
          counts.avatarSources += (
            await tx.userAvatar.updateMany({
              where: { id: { in: ids } },
              data: { sourceVideoKey: '' },
            })
          ).count;
        for (const [avatarId, groupId] of heygen) {
          // só solta se o grupo gravado ainda é o que a HeyGen confirmou apagado
          counts.heygenUnlinked += (
            await tx.userAvatar.updateMany({
              where: { id: avatarId, heygenGroupId: groupId },
              data: { heygenGroupId: null, heygenLookId: null },
            })
          ).count;
        }
        const withRows = generations
          .filter((item) => item.hasRows)
          .map((item) => item.id);
        for (const ids of chunk(withRows)) {
          counts.generationOutputs += (
            await tx.generationOutput.deleteMany({
              where: { generationId: { in: ids } },
            })
          ).count;
          counts.generationInputImages += (
            await tx.generationInputImage.deleteMany({
              where: { generationId: { in: ids } },
            })
          ).count;
        }
        for (const item of generations) {
          if (item.finalParameters === undefined) continue;
          counts.generationParameters += (
            await tx.generation.updateMany({
              where: { id: item.id },
              data: { parameters: item.finalParameters ?? Prisma.DbNull },
            })
          ).count;
        }
        return counts;
      }, FINALIZE_TRANSACTION_OPTIONS);
    } catch (error) {
      progress.finalizeError = errorMessage(error);
      this.logger.error(
        `account-erasure: limpeza final do banco falhou (as pistas ficam para a próxima rodada): ${progress.finalizeError}`,
      );
    }
  }

  private async settleWithin(
    done: Promise<void>,
    budgetMs: number,
  ): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), budgetMs);
      timer.unref();
    });
    try {
      return await Promise.race([done.then(() => true), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private continueInBackground(
    userId: string,
    cleanup: { progress: CleanupProgress; done: Promise<void> },
  ): void {
    const task: Promise<void> = cleanup.done
      .then(() => {
        const { progress } = cleanup;
        this.logger.log(
          `account-erasure: arquivos da conta ${userId} terminados em segundo plano: ${progress.filesDeleted} apagados, ` +
            `${progress.filesFailed} pastas com falha${progress.failedPrefixes.length ? ` (${progress.failedPrefixes.join(', ')})` : ''}, ` +
            `HeyGen com falha: ${progress.heygenFailedIds.length ? progress.heygenFailedIds.join(', ') : 'nenhum'}, ` +
            `limpeza final: ${progress.finalizeError ? `falhou (${progress.finalizeError})` : JSON.stringify(progress.finalized)}`,
        );
      })
      .finally(() => {
        this.running.delete(userId);
        this.backgroundCleanups.delete(task);
      });
    this.backgroundCleanups.add(task);
  }

  private snapshot(progress: CleanupProgress): ProgressSnapshot {
    return {
      filesDeleted: progress.filesDeleted,
      filesFailed: progress.filesFailed,
      failedPrefixes: [...progress.failedPrefixes],
      prefixesTotal: progress.prefixesTotal,
      prefixesDone: progress.prefixesDone,
      heygenRequested: progress.heygenRequested,
      heygenFailedIds: [...progress.heygenFailedIds],
      finalized: progress.finalized ? { ...progress.finalized } : null,
      finalizeError: progress.finalizeError,
    };
  }

  private syncBudgetMs(): number {
    const configured = Number(
      this.config.get<string>('ACCOUNT_ERASURE_SYNC_BUDGET_MS'),
    );
    return Number.isFinite(configured) && configured > 0
      ? Math.min(configured, MAX_SYNC_BUDGET_MS)
      : DEFAULT_SYNC_BUDGET_MS;
  }

  private storageLocation(): StorageLocation {
    return {
      publicUrlBase: (this.config.get<string>('S3_PUBLIC_URL') ?? '')
        .trim()
        .replace(/\/$/, ''),
      bucket:
        (this.config.get<string>('S3_BUCKET_NAME') ?? '').trim() ||
        'ai-generations',
    };
  }

  // ─── Relatório ─────────────────────────────────────────────────────────────

  private subscriptionSteps(
    subscriptions: SubscriptionErasureOutcome[],
  ): string[] {
    return subscriptions
      .filter(
        (outcome) =>
          outcome.result === 'manual_action_required' ||
          outcome.result === 'error',
      )
      .map(
        (outcome) =>
          `Assinatura ${outcome.id} (${outcome.gateway}): ${outcome.detail}`,
      );
  }

  private reportBase(input: {
    userId: string;
    alreadyErased: boolean;
    options: EraseAccountOptions;
    now: Date;
  }): Pick<
    AccountErasureReport,
    'userId' | 'alreadyErased' | 'requestedBy' | 'reason' | 'erasedAt'
  > {
    const reason = input.options.reason?.trim();
    return {
      userId: input.userId,
      alreadyErased: input.alreadyErased,
      requestedBy: input.options.requestedBy ?? null,
      reason: reason ? reason.slice(0, 500) : null,
      erasedAt: input.now.toISOString(),
    };
  }

  private buildHeldReport(input: {
    userId: string;
    alreadyErased: boolean;
    options: EraseAccountOptions;
    now: Date;
    hold: AccountLegalHold;
    held: HeldDatabase;
    subscriptions: SubscriptionErasureOutcome[];
    storageConfigured: boolean;
  }): AccountErasureReport {
    const { hold, held } = input;
    const nextSteps: string[] = [
      'Acesso bloqueado e sessões encerradas: login (senha ou Google) e renovação de sessão são recusados.',
      'Dados retidos por obrigação legal (LGPD, art. 16, I, e art. 7º, VI) enquanto houver denúncia ou investigação: ' +
        'nada foi anonimizado nem apagado (dados da conta, gerações, posts, avatares, vozes e arquivos ficam como estavam).',
      'Avise o titular de que os dados dele ficam retidos por obrigação legal enquanto o caso estiver aberto e serão ' +
        'apagados quando ele for encerrado.',
    ];
    if (held.communityPostsUnpublished > 0) {
      nextSteps.push(
        `${plural(held.communityPostsUnpublished, 'post da comunidade desta conta saiu', 'posts da comunidade desta conta saíram')} ` +
          `do ar (status REJECTED, motivo "${LEGAL_HOLD_POST_REJECTION_REASON}"); as linhas ficam como evidência.`,
      );
    }
    if (held.generationsExpiryCleared > 0) {
      nextSteps.push(
        `${plural(held.generationsExpiryCleared, 'geração desta conta tinha', 'gerações desta conta tinham')} prazo de ` +
          'expiração na galeria: o prazo foi retirado para a limpeza automática não apagar a evidência.',
      );
    }
    if (hold.kinds.includes('report')) {
      nextSteps.push(
        'Quando o caso for encerrado e a evidência entregue às autoridades, marque cada denúncia que segura a conta ' +
          '(reportIds) como "evidência liberada" no admin (Denúncias) e rode a exclusão de novo para apagar e anonimizar ' +
          'tudo. Denúncia descartada também libera; aberta ou em análise continua segurando.',
      );
    }
    if (
      (hold.kinds.includes('report') ||
        hold.kinds.includes('provider_minor')) &&
      input.options.ignoreSafetyEvents
    ) {
      nextSteps.push(
        'ignoreSafetyEvents vale só para os bloqueios por menor de idade em pedido só com texto: denúncia e recusa do ' +
          'provedor por menor em pedido com foto ou vídeo enviado continuam segurando a conta.',
      );
    }
    if (hold.kinds.includes('provider_minor')) {
      nextSteps.push(
        'O provedor de IA recusou por menor de idade um pedido desta conta que tinha foto ou vídeo enviado por ela: é ' +
          'evidência da própria mídia. Essa guarda não vence com o tempo e não sai com ignoreSafetyEvents; leve o caso ao ' +
          'jurídico (denúncia às autoridades) antes de qualquer exclusão. As mídias de entrada e os registros ficam ' +
          'guardados. Se for engano do provedor ou o caso estiver encerrado, o jurídico libera cada recusa em ' +
          'PATCH /api/v1/admin/content-safety/events/:id/release (com a nota) e a exclusão roda de novo.',
      );
    }
    if (hold.kinds.includes('safety_events')) {
      nextSteps.push(
        'Se os bloqueios por menor de idade forem engano (filtro de texto ou provedor num pedido só com texto), rode de ' +
          `novo com ignoreSafetyEvents: true e o motivo em "reason" (mínimo de ${SAFETY_OVERRIDE_REASON_MIN_LENGTH} ` +
          'caracteres), ou libere cada bloqueio em PATCH /api/v1/admin/content-safety/events/:id/release. Sem isso, a ' +
          `guarda por bloqueios sai quando houver menos de ${MINOR_BLOCKED_HOLD_THRESHOLD} tentativas distintas nos ` +
          `últimos ${MINOR_BLOCKED_WINDOW_DAYS} dias: rode a exclusão de novo.`,
      );
    }
    if (input.alreadyErased) {
      nextSteps.push(
        'A conta já tinha sido anonimizada numa exclusão anterior; o que ainda existe dela fica retido.',
      );
    }
    nextSteps.push(...this.subscriptionSteps(input.subscriptions));
    nextSteps.push(sessionWindowStep());

    const deleted = emptyDeleted();
    deleted.refreshTokens = held.access.refreshTokens;
    deleted.passwordResetTokens = held.access.passwordResetTokens;
    deleted.emailVerificationTokens = held.access.emailVerificationTokens;
    return {
      ...this.reportBase(input),
      anonymized: false,
      sessionsRevoked: held.access.sessionsRevoked,
      tokensDeleted:
        deleted.refreshTokens +
        deleted.passwordResetTokens +
        deleted.emailVerificationTokens,
      filesDeleted: 0,
      filesFailed: 0,
      failedPrefixes: [],
      storage: {
        configured: input.storageConfigured,
        // guarda legal: nada a apagar no bucket (sem bucket configurado, nada foi tocado e completed fica false)
        completed: input.storageConfigured,
        prefixesTotal: 0,
        prefixesDone: 0,
        // guarda legal: não existe 2ª etapa (nada é apagado)
        finalized: false,
      },
      generationsScrubbed: 0,
      generationsInFlight: 0,
      generationsKeptAsEvidence: 0,
      deleted,
      scrubbed: {
        userAvatars: 0,
        recoveryCampaigns: held.recoveryCampaigns,
        broadcastRecipients: 0,
        freeGenerationGrants: 0,
        affiliate: 0,
      },
      subscriptions: input.subscriptions,
      providers: {
        heygenAvatarGroups: { requested: 0, failed: 0, failedIds: [] },
      },
      legalHold: hold,
      kept: held.kept,
      nextSteps,
    };
  }

  private buildErasedReport(input: {
    userId: string;
    alreadyErased: boolean;
    options: EraseAccountOptions;
    now: Date;
    hold: AccountLegalHold;
    erasure: DatabaseErasure;
    subscriptions: SubscriptionErasureOutcome[];
    progress: ProgressSnapshot;
    storageConfigured: boolean;
    completed: boolean;
  }): AccountErasureReport {
    const { erasure, progress } = input;
    const nextSteps: string[] = [
      ...this.subscriptionSteps(input.subscriptions),
    ];
    if (!input.storageConfigured)
      nextSteps.push(
        'S3_ENDPOINT ausente na API: os arquivos no bucket NÃO foram tocados (nenhum foi apagado). As linhas que ' +
          'apontam para as pastas ficam (sem conteúdo) para a próxima rodada: configure o bucket e rode a exclusão de novo.',
      );
    if (erasure.generationsKeptAsEvidence > 0) {
      nextSteps.push(
        `${plural(erasure.generationsKeptAsEvidence, 'geração tem', 'gerações têm')} bloqueio por menor de idade ` +
          'registrado: ficaram intactas como evidência (texto, imagens de entrada, saídas e arquivos). Leve ao jurídico ' +
          'antes de qualquer exclusão manual.',
      );
    }
    if (progress.failedPrefixes.length) {
      nextSteps.push(
        `${progress.failedPrefixes.length} pasta(s) do bucket não foram apagadas (failedPrefixes): rode a exclusão de novo, ` +
          'ela tenta essas pastas outra vez (ou apague direto no bucket).',
      );
    }
    if (!input.completed) {
      nextSteps.push(
        `Os arquivos continuam sendo apagados em segundo plano (${progress.prefixesDone} de ${progress.prefixesTotal} pastas até agora). ` +
          'Rode a exclusão de novo em alguns minutos para conferir: a 2ª rodada deve mostrar 0.',
      );
    }
    if (erasure.generationsInFlight) {
      nextSteps.push(
        `${erasure.generationsInFlight} geração(ões) ainda estavam em processamento e podem gravar arquivo depois desta rodada: rode a exclusão de novo em 1 hora.`,
      );
    }
    if (progress.heygenFailedIds.length) {
      nextSteps.push(
        `${progress.heygenFailedIds.length} avatar(es) não foram apagados na HeyGen (grupos ${progress.heygenFailedIds.join(', ')}): ` +
          'rode a exclusão de novo, ela tenta outra vez; se continuar falhando, apague no painel da HeyGen (confira HEYGEN_API_KEY).',
      );
    }
    if (progress.finalizeError) {
      nextSteps.push(
        `A limpeza final do banco (linhas que apontam para os arquivos já apagados) falhou (${progress.finalizeError}): rode a exclusão de novo.`,
      );
    }
    if (
      input.options.ignoreSafetyEvents &&
      input.hold.minorBlockedAttempts >= MINOR_BLOCKED_HOLD_THRESHOLD
    ) {
      nextSteps.push(
        `${input.hold.minorBlockedEvents} bloqueios por menor de idade (${plural(input.hold.minorBlockedAttempts, 'tentativa distinta', 'tentativas distintas')}) ` +
          `nos últimos ${MINOR_BLOCKED_WINDOW_DAYS} dias foram ignorados a pedido do admin; o motivo ficou registrado no log.`,
      );
    }
    nextSteps.push(sessionWindowStep());

    const finalized = progress.finalized;
    const deleted = { ...erasure.deleted };
    if (finalized) {
      deleted.workspaces += finalized.workspaces;
      deleted.videoProjects += finalized.videoProjects;
      deleted.voiceProfiles += finalized.voiceProfiles;
      deleted.generationOutputs += finalized.generationOutputs;
      deleted.generationInputImages += finalized.generationInputImages;
    }
    return {
      ...this.reportBase(input),
      anonymized: true,
      sessionsRevoked: erasure.access.sessionsRevoked,
      tokensDeleted:
        deleted.refreshTokens +
        deleted.passwordResetTokens +
        deleted.emailVerificationTokens,
      filesDeleted: progress.filesDeleted,
      filesFailed: progress.filesFailed,
      failedPrefixes: progress.failedPrefixes,
      storage: {
        configured: input.storageConfigured,
        // sem bucket nenhum arquivo foi tocado: nem o bucket nem a 2ª etapa terminaram de verdade
        completed: input.storageConfigured && input.completed,
        prefixesTotal: progress.prefixesTotal,
        prefixesDone: progress.prefixesDone,
        finalized:
          input.storageConfigured &&
          progress.finalized !== null &&
          !progress.finalizeError,
        ...(progress.finalizeError
          ? { finalizeError: progress.finalizeError }
          : {}),
      },
      generationsScrubbed: erasure.generationsScrubbed,
      generationsInFlight: erasure.generationsInFlight,
      generationsKeptAsEvidence: erasure.generationsKeptAsEvidence,
      deleted,
      scrubbed: erasure.scrubbed,
      subscriptions: input.subscriptions,
      providers: {
        heygenAvatarGroups: {
          requested: progress.heygenRequested,
          failed: progress.heygenFailedIds.length,
          failedIds: progress.heygenFailedIds,
        },
      },
      legalHold: input.hold,
      kept: erasure.kept,
      nextSteps,
    };
  }
}
