import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { activeUserCache } from '../../auth/strategies/jwt.strategy';
import {
  ACCOUNT_LEGAL_HOLD_CODE,
  AccountErasureReport,
  AccountErasureService,
  ERASED_AFFILIATE_NAME,
  ERASED_AVATAR_NAME,
  ERASED_USER_NAME,
  ERASED_VIDEO_PROJECT_NAME,
  ERASED_VOICE_NAME,
  ERASED_WORKSPACE_NAME,
  citedIds,
  computeLegalHold,
  countMinorAttempts,
  erasedEmailFor,
  generationsCitedByReports,
  legalHoldDeletionConflict,
  reportCaseOpen,
  mentionsEmail,
  generationStoragePrefixes,
  parametersShowUserMedia,
  reportFiledByAccount,
  reportHoldsEvidence,
  sanitizeGenerationParameters,
  storageKeyFromUrl,
  tallyMinorBlocks,
  uploadFolderFromKey,
  videoRenderFolder,
} from '../account-erasure.service';
import { StorageDeleteError } from '../../uploads/uploads.service';

// ─── Prisma em memória: só os filtros que o serviço usa ──────────────────────

type Row = Record<string, any>;
type Seed = Record<string, Row[]>;

const PRISMA_NULLS = new Set<unknown>([Prisma.DbNull, Prisma.JsonNull]);

/** Cópia profunda no realm do teste (o structuredClone do Node devolve Date de outro realm e quebra o expect.any(Date)). */
function clone<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (value && typeof value === 'object' && !PRISMA_NULLS.has(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clone(item)]),
    ) as T;
  }
  return value;
}

function compare(left: unknown, right: unknown): number {
  if (typeof left === 'string' && typeof right === 'string')
    return left < right ? -1 : left > right ? 1 : 0;
  const a = left instanceof Date ? left.getTime() : Number(left);
  const b = right instanceof Date ? right.getTime() : Number(right);
  return a - b;
}

function matchValue(actual: unknown, condition: unknown): boolean {
  if (condition === null) return actual === null || actual === undefined;
  if (condition instanceof Date)
    return actual instanceof Date && actual.getTime() === condition.getTime();
  if (typeof condition !== 'object' || Array.isArray(condition))
    return actual === condition;
  const filter = condition as Row;
  if (Array.isArray(filter.path)) {
    let value: unknown = actual;
    for (const key of filter.path)
      value =
        value && typeof value === 'object' ? (value as Row)[key] : undefined;
    return value === filter.equals;
  }
  for (const [op, expected] of Object.entries(filter)) {
    if (op === 'mode') continue;
    if (op === 'equals') {
      const insensitive =
        filter.mode === 'insensitive' &&
        typeof actual === 'string' &&
        typeof expected === 'string';
      if (
        insensitive
          ? actual.toLowerCase() !== expected.toLowerCase()
          : actual !== expected
      )
        return false;
    } else if (op === 'in') {
      if (!(expected as unknown[]).includes(actual)) return false;
    } else if (op === 'startsWith') {
      if (typeof actual !== 'string' || !actual.startsWith(String(expected)))
        return false;
    } else if (op === 'not') {
      if (matchValue(actual, expected)) return false;
    } else if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
      if (actual === null || actual === undefined) return false;
      const order = compare(actual, expected);
      const ok =
        op === 'gt'
          ? order > 0
          : op === 'gte'
            ? order >= 0
            : op === 'lt'
              ? order < 0
              : order <= 0;
      if (!ok) return false;
    } else {
      throw new Error(`Prisma em memória: filtro "${op}" não suportado`);
    }
  }
  return true;
}

function matchWhere(row: Row, where?: Row): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR')
      return (condition as Row[]).some((part) => matchWhere(row, part));
    if (key === 'AND')
      return (condition as Row[]).every((part) => matchWhere(row, part));
    if (key === 'NOT')
      return !(Array.isArray(condition) ? condition : [condition]).some(
        (part: Row) => matchWhere(row, part),
      );
    return matchValue(row[key], condition);
  });
}

function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (PRISMA_NULLS.has(value)) row[key] = null;
    else if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      ('increment' in value || 'decrement' in value)
    ) {
      row[key] =
        Number(row[key]) + (value.increment ?? 0) - (value.decrement ?? 0);
    } else row[key] = clone(value);
  }
}

function project(row: Row, select?: Row): Row {
  const copy = clone(row);
  if (!select) return copy;
  return Object.fromEntries(
    Object.keys(select)
      .filter((key) => select[key])
      .map((key) => [key, copy[key] ?? null]),
  );
}

const UNIQUE_KEYS: Record<string, string[]> = {
  paymentRecoveryCampaign: ['subscriptionId'],
};

function createFakePrisma(seed: Seed) {
  const tables: Seed = Object.fromEntries(
    Object.entries(seed).map(([name, rows]) => [
      name,
      rows.map((row) => clone(row)),
    ]),
  );
  let sequence = 0;
  const rowsOf = (name: string): Row[] => (tables[name] ??= []);
  const makeDelegate = (name: string) => ({
    findMany: jest.fn(async (args: Row = {}) => {
      const rows = rowsOf(name).filter((row) => matchWhere(row, args.where));
      const [sortKey, direction] = Object.entries(
        (args.orderBy ?? {}) as Row,
      )[0] ?? [null, 'asc'];
      if (sortKey)
        rows.sort(
          (left, right) =>
            compare(left[sortKey], right[sortKey]) *
            (direction === 'desc' ? -1 : 1),
        );
      return rows
        .slice(0, args.take ?? undefined)
        .map((row) => project(row, args.select));
    }),
    findUnique: jest.fn(async (args: Row) => {
      const row = rowsOf(name).find((candidate) =>
        matchWhere(candidate, args.where),
      );
      return row ? project(row, args.select) : null;
    }),
    count: jest.fn(
      async (args: Row = {}) =>
        rowsOf(name).filter((row) => matchWhere(row, args.where)).length,
    ),
    update: jest.fn(async (args: Row) => {
      const row = rowsOf(name).find((candidate) =>
        matchWhere(candidate, args.where),
      );
      if (!row) throw new Error(`${name} não encontrado`);
      applyData(row, args.data);
      return clone(row);
    }),
    updateMany: jest.fn(async (args: Row) => {
      const rows = rowsOf(name).filter((row) => matchWhere(row, args.where));
      rows.forEach((row) => applyData(row, args.data));
      return { count: rows.length };
    }),
    deleteMany: jest.fn(async (args: Row = {}) => {
      const before = rowsOf(name).length;
      tables[name] = rowsOf(name).filter((row) => !matchWhere(row, args.where));
      return { count: before - tables[name].length };
    }),
    createMany: jest.fn(async (args: Row) => {
      let count = 0;
      for (const data of args.data as Row[]) {
        const unique = UNIQUE_KEYS[name] ?? [];
        if (
          args.skipDuplicates &&
          unique.some((key) =>
            rowsOf(name).some((row) => row[key] === data[key]),
          )
        )
          continue;
        rowsOf(name).push({ id: `${name}-${++sequence}`, ...clone(data) });
        count++;
      }
      return { count };
    }),
  });
  const delegates: Record<string, ReturnType<typeof makeDelegate>> = {};
  const prisma: Row = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === '$transaction')
          return async (callback: (tx: unknown) => Promise<unknown>) =>
            callback(prisma);
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        return (delegates[prop] ??= makeDelegate(prop));
      },
    },
  );
  return { prisma, tables, delegates };
}

// ─── Conta de teste ──────────────────────────────────────────────────────────

const cid = (tag: string): string => `c${tag}${'0'.repeat(24 - tag.length)}`;
const U = cid('user');
const O = cid('other');
const G1 = cid('gena');
const G2 = cid('genb');
const G3 = cid('genc');
const GO = cid('genother');
const P1 = cid('posta');
const P2 = cid('postb');
const P3 = cid('postc');
const P4 = cid('postd');
const W1 = cid('worka');
const F1 = cid('foldera');
const VP1 = cid('videoa');
const V1 = cid('voicea');
const I1 = cid('infla');
const A1 = cid('avatara');
const SOURCE_UUID = '11111111-2222-4333-8444-555555555555';
const AUDIO_UUID = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const RENDER_UUID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const PUBLIC = 'https://cdn.theaimodelab.com';
const CREATED = new Date('2026-10-01T12:00:00.000Z');
const PERIOD_END = new Date('2026-11-01T00:00:00.000Z');
const CONFIRM = {
  confirm: true,
  reason: 'pedido pelo e-mail de privacidade',
  requestedBy: 'admin@theaimodelab.com',
};

const inOneDay = (): Date => new Date(Date.now() + 86_400_000);

function subscription(id: string, extra: Row): Row {
  return {
    id,
    userId: U,
    status: 'ACTIVE',
    paymentProvider: null,
    paymentMethod: null,
    externalSubscriptionId: null,
    asaasAuthorizationId: null,
    asaasAuthorizationStatus: null,
    cancelAtPeriodEnd: false,
    scheduledPlanId: null,
    paymentRetryCount: 0,
    currentPeriodEnd: PERIOD_END,
    createdAt: CREATED,
    ...extra,
  };
}

function baseSeed(): Seed {
  return {
    user: [
      {
        id: U,
        email: 'Maria@Exemplo.com',
        name: 'Maria Souza',
        role: 'USER',
        passwordHash: 'bcrypt-hash',
        avatarUrl: 'https://lh3.googleusercontent.com/a/foto',
        oauthProvider: 'google',
        oauthProviderId: 'google-123',
        phone: '+5511999990000',
        phoneVerified: true,
        taxId: '12345678901',
        fbclid: 'fbclid-1',
        fbp: 'fb.1.1',
        fbc: 'fb.1.2',
        gclid: 'gclid-1',
        landingPage: 'https://www.theaimodelab.com/?utm_source=ig',
        referrer: 'https://instagram.com',
        utmCampaign: 'camp',
        utmContent: 'content',
        utmMedium: 'paid',
        utmSource: 'ig',
        utmTerm: 'term',
        country: 'BR',
        timezone: 'America/Sao_Paulo',
        marketingOptOut: false,
        isActive: true,
        unlimitedModeImage: true,
        unlimitedModeVideo: true,
        stripeCustomerId: 'cus_123',
        asaasCustomerId: 'asaas_123',
        referredByCode: 'AFIL10',
        termsVersion: '2026-10-15',
        currency: 'BRL',
        locale: 'pt-BR',
        createdAt: CREATED,
      },
      {
        id: O,
        email: 'outra@exemplo.com',
        name: 'Outra Pessoa',
        role: 'USER',
        isActive: true,
      },
    ],
    refreshToken: [
      { id: 'rt-1', userId: U, revoked: false, expiresAt: inOneDay() },
      { id: 'rt-2', userId: U, revoked: false, expiresAt: inOneDay() },
      { id: 'rt-3', userId: U, revoked: true, expiresAt: inOneDay() },
      {
        id: 'rt-4',
        userId: U,
        revoked: false,
        expiresAt: new Date(Date.now() - 1000),
      },
      { id: 'rt-o', userId: O, revoked: false, expiresAt: inOneDay() },
    ],
    passwordResetToken: [{ id: 'pr-1', userId: U }],
    emailVerificationToken: [{ id: 'ev-1', userId: U }],
    payment: [
      {
        id: 'pay-1',
        userId: U,
        type: 'SUBSCRIPTION',
        amountCents: 9700,
        currency: 'BRL',
        status: 'COMPLETED',
        provider: 'stripe',
        externalPaymentId: 'pi_1',
        metadata: { email: 'maria@exemplo.com' },
        createdAt: CREATED,
      },
      {
        id: 'pay-2',
        userId: U,
        type: 'CREDIT_PURCHASE',
        amountCents: 2990,
        currency: 'USD',
        status: 'REFUNDED',
        provider: 'perfectpay',
        externalPaymentId: 'PPCPMS1',
        createdAt: CREATED,
      },
      {
        id: 'pay-o',
        userId: O,
        type: 'SUBSCRIPTION',
        amountCents: 9700,
        currency: 'BRL',
        status: 'COMPLETED',
        provider: 'stripe',
      },
    ],
    creditTransaction: [
      {
        id: 'ct-1',
        userId: U,
        type: 'SUBSCRIPTION_RENEWAL',
        amount: 1000,
        source: 'plan',
        description: 'Renovação',
        paymentId: 'pay-1',
      },
      {
        id: 'ct-2',
        userId: U,
        type: 'GENERATION_DEBIT',
        amount: -50,
        source: 'plan',
        generationId: G1,
      },
      {
        id: 'ct-3',
        userId: U,
        type: 'AVATAR_TRAINING_DEBIT',
        amount: -500,
        source: 'plan',
        userAvatarId: A1,
        description: 'Treinamento de avatar: Maria Avatar',
      },
    ],
    affiliateEarning: [
      {
        id: 'ae-1',
        affiliateId: 'aff-x',
        paymentId: 'pay-1',
        userId: U,
        amountCents: 9700,
        commissionCents: 2910,
        status: 'PENDING',
      },
    ],
    contentReport: [
      {
        id: 'rep-by-user',
        category: 'OTHER',
        status: 'OPEN',
        target: 'https://x.com/algo',
        description: 'Denúncia feita pela própria conta.',
        reporterUserId: U,
        reporterEmail: 'maria@exemplo.com',
        createdAt: CREATED,
      },
    ],
    contentSafetyEvent: [
      {
        id: 'cse-1',
        userId: U,
        kind: 'CONSENT_ATTESTED',
        route: '/api/v1/generations/face-swap',
        generationId: G1,
      },
    ],
    generation: [
      {
        id: G1,
        userId: U,
        type: 'AVATAR_VIDEO',
        status: 'COMPLETED',
        modelUsed: 'heygen-avatar_iv',
        resolution: 'RES_720P',
        creditsConsumed: 50,
        prompt: 'Oi, eu sou a Maria',
        negativePrompt: 'feio',
        errorMessage: null,
        isDeleted: false,
        isFavorited: true,
        voiceProfileId: V1,
        influencer_id: I1,
        userAvatarId: A1,
        createdAt: CREATED,
        parameters: {
          unlimited: true,
          provider: 'kie',
          fallbackFrom: 'veo3-fast',
          audioDurationSeconds: 12,
          script: 'Oi, eu sou a Maria',
          engine: 'avatar iv com espaço',
          customAudioKey: `avatar_audio/${AUDIO_UUID}/minha-voz.mp3`,
          customAudioUrl: `${PUBLIC}/avatar_audio/${AUDIO_UUID}/minha-voz.mp3`,
          backgroundImageUrl: 'https://x.com/fundo.png',
        },
      },
      {
        id: G2,
        userId: U,
        type: 'TEXT_TO_IMAGE',
        status: 'PROCESSING',
        modelUsed: 'nano-banana',
        resolution: 'RES_1K',
        creditsConsumed: 10,
        prompt: 'Retrato da Maria na praia',
        negativePrompt: null,
        errorMessage: null,
        isDeleted: false,
        isFavorited: false,
        voiceProfileId: null,
        influencer_id: null,
        userAvatarId: null,
        parameters: null,
        createdAt: CREATED,
      },
      {
        id: G3,
        userId: U,
        type: 'IMAGE_TO_IMAGE',
        status: 'FAILED',
        modelUsed: 'seedream',
        resolution: 'RES_2K',
        creditsConsumed: 0,
        prompt: null,
        negativePrompt: null,
        errorMessage: 'Your prompt "Maria nua" violates policy',
        errorCode: 'CONTENT_SAFETY',
        isDeleted: false,
        isFavorited: false,
        voiceProfileId: null,
        influencer_id: null,
        userAvatarId: null,
        parameters: { mimeType: 'image/png' },
        createdAt: CREATED,
      },
      {
        id: GO,
        userId: O,
        type: 'TEXT_TO_IMAGE',
        status: 'COMPLETED',
        modelUsed: 'x',
        prompt: 'prompt de outra pessoa',
        negativePrompt: null,
        errorMessage: null,
        isDeleted: false,
        isFavorited: false,
        voiceProfileId: null,
        influencer_id: null,
        userAvatarId: null,
        parameters: null,
      },
    ],
    generationOutput: [
      {
        id: 'out-1',
        generationId: G1,
        url: `${PUBLIC}/generations/${G1}/u/output_0.mp4`,
      },
      {
        id: 'out-2',
        generationId: G1,
        url: `${PUBLIC}/generations/${G1}/u/thumb.jpg`,
      },
      {
        id: 'out-o',
        generationId: GO,
        url: `${PUBLIC}/generations/${GO}/u/output_0.png`,
      },
    ],
    generationInputImage: [
      {
        id: 'in-1',
        generationId: G3,
        url: `${PUBLIC}/inputs/${G3}/u/input.png`,
        role: 'REFERENCE',
      },
    ],
    communityPost: [
      {
        id: P1,
        userId: U,
        generationId: G1,
        kind: 'video',
        mediaUrl: `${PUBLIC}/generations/${G1}/u/output_0.mp4`,
        prompt: 'Oi, eu sou a Maria',
        status: 'APPROVED',
        likesCount: 1,
      },
      {
        id: P2,
        userId: O,
        generationId: GO,
        kind: 'image',
        mediaUrl: 'x',
        prompt: 'p',
        status: 'APPROVED',
        likesCount: 3,
      },
    ],
    communityPostLike: [
      { id: 'like-1', postId: P1, userId: O },
      { id: 'like-2', postId: P2, userId: U },
    ],
    userFollow: [
      { id: 'fol-1', followerId: U, followingId: O },
      { id: 'fol-2', followerId: O, followingId: U },
    ],
    notification: [
      {
        id: 'n-1',
        userId: U,
        type: 'community-approved',
        data: { postId: P1 },
      },
      {
        id: 'n-2',
        userId: O,
        type: 'user-followed',
        data: { followerId: U, followerName: 'Maria Souza' },
      },
      {
        id: 'n-3',
        userId: O,
        type: 'community-approved',
        data: { postId: P2 },
      },
    ],
    folder: [{ id: F1, userId: U, name: 'Fotos da Maria' }],
    generationFolder: [{ id: 'gf-1', generationId: G1, folderId: F1 }],
    workspace: [{ id: W1, userId: U, name: 'Quadro', nodes: [], edges: [] }],
    brand: [
      { id: 'brand-1', userId: U, name: 'Marca da Maria', referenceAssets: [] },
    ],
    videoProject: [
      {
        id: VP1,
        userId: U,
        name: 'Projeto',
        outputUrl: `${PUBLIC}/video-editor/${RENDER_UUID}/render-${VP1}.mp4`,
      },
    ],
    videoProjectClip: [
      {
        id: 'clip-1',
        projectId: VP1,
        sourceUrl: 'x',
        order: 0,
        durationMs: 1000,
      },
    ],
    feedback: [
      {
        id: 'fb-1',
        userId: U,
        nps: 9,
        rating: 5,
        goal: 'x',
        highlight: 'x',
        improve: 'x',
        wishlist: 'x',
      },
    ],
    voiceProfile: [
      {
        id: V1,
        userId: U,
        name: 'Voz da Maria',
        sampleUrl: `${PUBLIC}/voices/${U}/u/sample.mp3`,
      },
    ],
    influencers: [
      {
        id: I1,
        user_id: U,
        name: 'Maria IA',
        voice_profile_id: V1,
        image_urls: [],
      },
    ],
    userAvatar: [
      {
        id: A1,
        userId: U,
        name: 'Maria Avatar',
        status: 'READY',
        sourceVideoKey: `avatar_source/${SOURCE_UUID}/selfie.mp4`,
        sourceVideoUrl: `${PUBLIC}/avatar_source/${SOURCE_UUID}/selfie.mp4`,
        heygenGroupId: 'hg-group-1',
        heygenLookId: 'hg-look-1',
        consentUrl: null,
        previewImageUrl: 'https://heygen.example/preview.jpg',
        previewVideoUrl: null,
        defaultVoiceId: 'voice-1',
        errorMessage: null,
        isDeleted: false,
        supportedEngines: ['avatar_iv'],
      },
    ],
    unlimitedUsage: [
      {
        id: 'uu-1',
        userId: U,
        generationId: G2,
        modelVariant: 'nb2',
        resolution: 'RES_1K',
      },
    ],
    userFreeGeneration: [{ id: 'ufg-1', userId: U, type: 'NB2', remaining: 3 }],
    weeklyClaim: [{ id: 'wc-1', userId: U, weekKey: '2026-W41', amount: 4 }],
    emailSequenceLog: [
      {
        id: 'esl-1',
        userId: U,
        sequence: 'onboarding',
        emailKey: 'onboarding-1',
      },
    ],
    analyticsEvent: [
      { id: 'an-1', userId: U, eventName: 'paywall', payload: { url: 'x' } },
      { id: 'an-o', userId: O, eventName: 'paywall', payload: {} },
    ],
    marketingLead: [
      {
        id: 'lead-1',
        email: 'maria@exemplo.com',
        source: 'sales_quiz',
        name: 'Maria',
      },
      {
        id: 'lead-o',
        email: 'outra@exemplo.com',
        source: 'sales_quiz',
        name: 'Outra',
      },
    ],
    emailBroadcastRecipient: [
      {
        id: 'br-1',
        broadcastId: 'b-1',
        email: 'maria@exemplo.com',
        userId: U,
        name: 'Maria Souza',
        plan: 'pro',
      },
      {
        id: 'br-o',
        broadcastId: 'b-1',
        email: 'outra@exemplo.com',
        userId: O,
        name: 'Outra',
        plan: 'free',
      },
    ],
    pendingFreeGenerationGrant: [
      {
        id: 'grant-1',
        email: 'maria@exemplo.com',
        consumedByUserId: U,
        bundle: { NB2: 5 },
        externalEventId: 'sale-1',
      },
      {
        id: 'grant-2',
        email: 'MARIA@EXEMPLO.COM',
        consumedByUserId: null,
        bundle: { NB2: 5 },
        externalEventId: 'sale-2',
      },
      {
        id: 'grant-o',
        email: 'outra@exemplo.com',
        consumedByUserId: null,
        bundle: {},
        externalEventId: 'sale-3',
      },
    ],
    paymentRecoveryCampaign: [
      {
        id: 'prc-1',
        userId: U,
        subscriptionId: 'sub-stripe',
        recoveredAt: null,
        abandonedAt: null,
        cardBrand: 'visa',
        cardLast4: '4242',
        declineCode: 'insufficient_funds',
      },
    ],
    affiliate: [
      {
        id: 'aff-1',
        userId: U,
        code: 'MARIA10',
        name: 'Maria Souza',
        pixKey: '12345678901',
        pixKeyType: 'CPF',
        isActive: true,
      },
    ],
    subscription: [
      subscription('sub-stripe', {
        paymentProvider: 'stripe',
        externalSubscriptionId: 'sub_1',
        scheduledPlanId: 'plan-down',
      }),
      subscription('sub-stripe-pastdue', {
        status: 'PAST_DUE',
        paymentProvider: 'stripe',
        externalSubscriptionId: 'sub_2',
        paymentRetryCount: 2,
      }),
      subscription('sub-pp', {
        paymentProvider: 'perfectpay',
        externalSubscriptionId: 'PPSUB1',
      }),
      subscription('sub-asaas', {
        paymentProvider: 'asaas',
        paymentMethod: 'pix_auto_asaas',
        asaasAuthorizationId: 'auth_1',
        asaasAuthorizationStatus: 'ACTIVE',
      }),
      subscription('sub-cakto', {
        paymentProvider: 'cakto',
        externalSubscriptionId: 'cakto-sub-1',
      }),
      subscription('sub-free', {}),
      subscription('sub-old', {
        status: 'CANCELED',
        paymentProvider: 'stripe',
        externalSubscriptionId: 'sub_0',
      }),
    ],
  };
}

/** Arquivos no bucket por pasta (12 no total). */
function bucketSeed(): Record<string, number> {
  return {
    [`generations/${G1}/`]: 2,
    [`thumbnails/${G1}/`]: 2,
    [`inputs/${G1}/`]: 1,
    [`generations/${G3}/`]: 1,
    [`voices/${U}/`]: 2,
    [`workspaces/${W1}/`]: 1,
    [`avatar_source/${SOURCE_UUID}/`]: 1,
    [`avatar_audio/${AUDIO_UUID}/`]: 1,
    [`video-editor/${RENDER_UUID}/`]: 1,
  };
}

const ALL_PREFIXES = [
  `avatar_source/${SOURCE_UUID}/`,
  `avatar_audio/${AUDIO_UUID}/`,
  `workspaces/${W1}/`,
  `video-editor/${RENDER_UUID}/`,
  `voices/${U}/`,
  ...[G1, G2, G3].flatMap((id) =>
    ['generations', 'outputs', 'thumbnails', 'inputs', 'samples'].map(
      (root) => `${root}/${id}/`,
    ),
  ),
];

interface SetupOptions {
  seed?: (seed: Seed) => void;
  env?: Record<string, string | undefined>;
}

function setup(options: SetupOptions = {}) {
  const seed = baseSeed();
  options.seed?.(seed);
  const fake = createFakePrisma(seed);
  const bucket = new Map(Object.entries(bucketSeed()));
  const uploads = {
    deleteByPrefixStrict: jest.fn(async (prefix: string): Promise<number> => {
      const count = bucket.get(prefix) ?? 0;
      bucket.set(prefix, 0);
      return count;
    }),
  };
  const stripe = {
    cancelSubscription: jest.fn(
      async (_externalId: string): Promise<void> => undefined,
    ),
  };
  const cakto = {
    isConfigured: jest.fn(() => true),
    cancelSubscription: jest.fn(
      async (_externalId: string): Promise<void> => undefined,
    ),
  };
  const asaas = {
    cancelAuthorization: jest.fn(
      async (_authorizationId: string): Promise<void> => undefined,
    ),
  };
  const heygen = {
    deleteAvatarGroupStrict: jest.fn(
      async (_groupId: string): Promise<'deleted' | 'not_found'> => 'deleted',
    ),
  };
  const env: Record<string, string | undefined> = {
    S3_ENDPOINT: 'https://s3.example',
    S3_PUBLIC_URL: PUBLIC,
    S3_BUCKET_NAME: 'ai-generations',
    ...options.env,
  };
  const config = { get: jest.fn((key: string) => env[key]) };
  const service = new AccountErasureService(
    fake.prisma as never,
    uploads as never,
    stripe as never,
    cakto as never,
    asaas as never,
    heygen as never,
    config as never,
  );
  return { service, ...fake, bucket, uploads, stripe, cakto, asaas, heygen };
}

const rowById = (rows: Row[] | undefined, id: string): Row | undefined =>
  rows?.find((row) => row.id === id);
const outcome = (report: AccountErasureReport, id: string) =>
  report.subscriptions.find((item) => item.id === id);

describe('AccountErasureService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('o que fica', () => {
    it('pagamentos, créditos, comissões e registros de segurança ficam intactos (nem lidos para escrita)', async () => {
      const ctx = setup();
      const before = clone({
        payment: ctx.tables.payment,
        creditTransaction: ctx.tables.creditTransaction,
        affiliateEarning: ctx.tables.affiliateEarning,
        contentReport: ctx.tables.contentReport,
        contentSafetyEvent: ctx.tables.contentSafetyEvent,
      });

      const report = await ctx.service.erase(U, CONFIRM);

      expect(ctx.tables.payment).toEqual(before.payment);
      expect(ctx.tables.creditTransaction).toEqual(before.creditTransaction);
      expect(ctx.tables.affiliateEarning).toEqual(before.affiliateEarning);
      expect(ctx.tables.contentReport).toEqual(before.contentReport);
      expect(ctx.tables.contentSafetyEvent).toEqual(before.contentSafetyEvent);
      for (const model of [
        'payment',
        'creditTransaction',
        'affiliateEarning',
        'contentReport',
        'contentSafetyEvent',
      ]) {
        const delegate = ctx.delegates[model];
        for (const write of [
          'update',
          'updateMany',
          'deleteMany',
          'createMany',
        ] as const) {
          expect(delegate?.[write] ?? jest.fn()).not.toHaveBeenCalled();
        }
      }
      expect(report.kept).toEqual({
        payments: 2,
        creditTransactions: 3,
        affiliateEarnings: 1,
        subscriptions: 7,
        generations: 3,
        contentReports: 1,
        contentSafetyEvents: 1,
      });
      // o avatar fica (anonimizado): o débito do treino continua apontando para ele
      expect(rowById(ctx.tables.userAvatar, A1)).toBeDefined();
    });

    it('a linha da conta fica anonimizada: dados pessoais fora, ids de gateway e aceite do termo ficam', async () => {
      const ctx = setup();
      const report = await ctx.service.erase(U, CONFIRM);
      const user = rowById(ctx.tables.user, U)!;

      expect(user).toMatchObject({
        email: erasedEmailFor(U),
        name: ERASED_USER_NAME,
        isActive: false,
        marketingOptOut: true,
        unlimitedModeImage: false,
        unlimitedModeVideo: false,
        stripeCustomerId: 'cus_123',
        asaasCustomerId: 'asaas_123',
        referredByCode: 'AFIL10',
        termsVersion: '2026-10-15',
        currency: 'BRL',
      });
      for (const field of [
        'passwordHash',
        'avatarUrl',
        'oauthProvider',
        'oauthProviderId',
        'phone',
        'phoneVerified',
        'taxId',
        'fbclid',
        'fbp',
        'fbc',
        'gclid',
        'landingPage',
        'referrer',
        'utmCampaign',
        'utmContent',
        'utmMedium',
        'utmSource',
        'utmTerm',
        'country',
        'timezone',
      ]) {
        expect([field, user[field]]).toEqual([field, null]);
      }
      expect(JSON.stringify(ctx.tables.user)).not.toMatch(/maria/i);
      expect(rowById(ctx.tables.user, O)).toMatchObject({
        email: 'outra@exemplo.com',
        name: 'Outra Pessoa',
        isActive: true,
      });
      expect(report).toMatchObject({
        userId: U,
        anonymized: true,
        alreadyErased: false,
        requestedBy: 'admin@theaimodelab.com',
        reason: 'pedido pelo e-mail de privacidade',
      });
    });
  });

  it('sessões e tokens: todos apagados; sessionsRevoked conta só as vivas', async () => {
    const ctx = setup();
    const report = await ctx.service.erase(U, CONFIRM);
    expect(ctx.tables.refreshToken.map((row) => row.id)).toEqual(['rt-o']);
    expect(ctx.tables.passwordResetToken).toEqual([]);
    expect(ctx.tables.emailVerificationToken).toEqual([]);
    expect(report.sessionsRevoked).toBe(2);
    expect(report.tokensDeleted).toBe(6);
    expect(report.deleted).toMatchObject({
      refreshTokens: 4,
      passwordResetTokens: 1,
      emailVerificationTokens: 1,
    });
  });

  describe('gerações', () => {
    it('linha fica (tipo, modelo, status, créditos, data); texto, arquivo e vínculo saem', async () => {
      const ctx = setup();
      const report = await ctx.service.erase(U, CONFIRM);
      const g1 = rowById(ctx.tables.generation, G1)!;

      expect(g1).toMatchObject({
        type: 'AVATAR_VIDEO',
        status: 'COMPLETED',
        modelUsed: 'heygen-avatar_iv',
        creditsConsumed: 50,
        createdAt: CREATED,
        prompt: null,
        negativePrompt: null,
        errorMessage: null,
        isDeleted: true,
        isFavorited: false,
        voiceProfileId: null,
        influencer_id: null,
        // técnico fica (ilimitado, provedor, fallback, duração); roteiro, chave e links saem
        parameters: {
          audioDurationSeconds: 12,
          fallbackFrom: 'veo3-fast',
          provider: 'kie',
          unlimited: true,
        },
      });
      expect(rowById(ctx.tables.generation, G2)).toMatchObject({
        prompt: null,
        parameters: null,
        isDeleted: true,
      });
      expect(rowById(ctx.tables.generation, G3)).toMatchObject({
        errorMessage: null,
        errorCode: 'CONTENT_SAFETY',
        parameters: { mimeType: 'image/png' },
      });
      // geração de outra pessoa intacta
      expect(rowById(ctx.tables.generation, GO)).toMatchObject({
        prompt: 'prompt de outra pessoa',
        isDeleted: false,
      });
      expect(ctx.tables.generationOutput.map((row) => row.id)).toEqual([
        'out-o',
      ]);
      expect(ctx.tables.generationInputImage).toEqual([]);
      expect(report.generationsScrubbed).toBe(3);
      expect(report.deleted).toMatchObject({
        generationOutputs: 2,
        generationInputImages: 1,
        unlimitedUsage: 1,
      });
    });

    it('pede ao bucket todas as pastas de cada geração, das vozes, quadros, editor de vídeo e uploads do avatar', async () => {
      const ctx = setup();
      const report = await ctx.service.erase(U, CONFIRM);
      const requested = ctx.uploads.deleteByPrefixStrict.mock.calls.map(
        ([prefix]) => prefix,
      );
      expect([...requested].sort()).toEqual([...ALL_PREFIXES].sort());
      expect(requested.some((prefix) => prefix.includes(GO))).toBe(false);
      expect(report).toMatchObject({
        filesDeleted: 12,
        filesFailed: 0,
        failedPrefixes: [],
        storage: {
          configured: true,
          completed: true,
          prefixesTotal: ALL_PREFIXES.length,
          prefixesDone: ALL_PREFIXES.length,
        },
      });
    });

    it('geração em processamento: avisa para rodar de novo', async () => {
      const ctx = setup();
      const report = await ctx.service.erase(U, CONFIRM);
      expect(report.generationsInFlight).toBe(1);
      expect(report.nextSteps).toContainEqual(
        expect.stringContaining('em processamento'),
      );
    });
  });

  it('apaga o resto da conta e anonimiza o que precisa ficar', async () => {
    const ctx = setup();
    const report = await ctx.service.erase(U, CONFIRM);
    const { tables } = ctx;

    // comunidade: post da conta (e a curtida nele) sai; a curtida dela no post de outra pessoa sai e o contador desce
    expect(tables.communityPost.map((row) => row.id)).toEqual([P2]);
    expect(rowById(tables.communityPost, P2)!.likesCount).toBe(2);
    expect(tables.communityPostLike).toEqual([]);
    expect(tables.userFollow).toEqual([]);
    expect(tables.notification.map((row) => row.id)).toEqual(['n-3']);
    // organização e perfis
    for (const model of [
      'folder',
      'generationFolder',
      'workspace',
      'brand',
      'videoProject',
      'videoProjectClip',
      'feedback',
      'voiceProfile',
      'influencers',
    ]) {
      expect([model, tables[model]]).toEqual([model, []]);
    }
    // contadores e logs
    for (const model of [
      'unlimitedUsage',
      'userFreeGeneration',
      'weeklyClaim',
      'emailSequenceLog',
    ]) {
      expect([model, tables[model]]).toEqual([model, []]);
    }
    expect(tables.analyticsEvent.map((row) => row.id)).toEqual(['an-o']);
    expect(tables.marketingLead.map((row) => row.id)).toEqual(['lead-o']);
    // avatar anonimizado e pedido de exclusão na HeyGen
    expect(rowById(tables.userAvatar, A1)).toMatchObject({
      name: ERASED_AVATAR_NAME,
      status: 'DELETING',
      sourceVideoKey: '',
      sourceVideoUrl: '',
      heygenGroupId: null,
      heygenLookId: null,
      previewImageUrl: null,
      defaultVoiceId: null,
      isDeleted: true,
    });
    expect(ctx.heygen.deleteAvatarGroupStrict).toHaveBeenCalledWith(
      'hg-group-1',
    );
    // registros que ficam sem o e-mail
    expect(rowById(tables.emailBroadcastRecipient, 'br-1')).toMatchObject({
      email: erasedEmailFor(U),
      name: null,
      plan: 'pro',
    });
    expect(rowById(tables.emailBroadcastRecipient, 'br-o')).toMatchObject({
      email: 'outra@exemplo.com',
      name: 'Outra',
    });
    expect(rowById(tables.pendingFreeGenerationGrant, 'grant-1')).toMatchObject(
      { email: erasedEmailFor(U), externalEventId: 'sale-1' },
    );
    expect(rowById(tables.pendingFreeGenerationGrant, 'grant-2')).toMatchObject(
      { email: erasedEmailFor(U), externalEventId: 'sale-2' },
    );
    expect(rowById(tables.pendingFreeGenerationGrant, 'grant-o')).toMatchObject(
      { email: 'outra@exemplo.com' },
    );
    // campanha de cobrança: fechada, sem cartão; a assinatura com falha sem campanha ganha uma já encerrada
    expect(rowById(tables.paymentRecoveryCampaign, 'prc-1')).toMatchObject({
      cardBrand: null,
      cardLast4: null,
      declineCode: null,
      abandonedAt: expect.any(Date),
    });
    expect(
      tables.paymentRecoveryCampaign.find(
        (row) => row.subscriptionId === 'sub-stripe-pastdue',
      ),
    ).toMatchObject({ userId: U, abandonedAt: expect.any(Date) });
    // afiliado: sem PIX e desativado; o código fica (comissões e indicações)
    expect(rowById(tables.affiliate, 'aff-1')).toMatchObject({
      name: ERASED_AFFILIATE_NAME,
      pixKey: null,
      pixKeyType: null,
      isActive: false,
      code: 'MARIA10',
    });

    expect(report.deleted).toMatchObject({
      notifications: 2,
      communityPosts: 1,
      communityLikes: 1,
      follows: 2,
      folders: 1,
      workspaces: 1,
      brands: 1,
      videoProjects: 1,
      feedback: 1,
      voiceProfiles: 1,
      influencers: 1,
      freeGenerationBalances: 1,
      weeklyClaims: 1,
      emailSequenceLogs: 1,
      analyticsEvents: 1,
      marketingLeads: 1,
    });
    expect(report.scrubbed).toEqual({
      userAvatars: 1,
      recoveryCampaigns: 2,
      broadcastRecipients: 1,
      freeGenerationGrants: 2,
      affiliate: 1,
    });
    expect(report.providers).toEqual({
      heygenAvatarGroups: { requested: 1, failed: 0, failedIds: [] },
    });
    expect(report.anonymized).toBe(true);
    expect(report.legalHold).toEqual({
      active: false,
      kinds: [],
      reasons: [],
      reportIds: [],
      generationIds: [],
      communityPostIds: [],
      avatarIds: [],
      voiceProfileIds: [],
      minorBlockedEvents: 0,
      minorBlockedAttempts: 0,
      providerMinorBlockedEvents: 0,
      reviewConfirmedEvents: 0,
      communityPostsUnpublished: 0,
      generationsExpiryCleared: 0,
    });
    expect(report.generationsKeptAsEvidence).toBe(0);
    // a 2ª etapa (linhas cujas pastas o bucket confirmou) rodou e gravou
    expect(report.storage).toEqual({
      configured: true,
      completed: true,
      prefixesTotal: ALL_PREFIXES.length,
      prefixesDone: ALL_PREFIXES.length,
      finalized: true,
    });
    expect(report.nextSteps).toContainEqual(
      expect.stringContaining('até 1 minuto'),
    );
  });

  describe('assinaturas', () => {
    it('desliga a renovação em cada gateway; Perfect Pay fica como ação manual', async () => {
      const ctx = setup();
      const report = await ctx.service.erase(U, CONFIRM);

      expect(ctx.stripe.cancelSubscription.mock.calls).toEqual([
        ['sub_1'],
        ['sub_2'],
      ]);
      expect(ctx.cakto.cancelSubscription).toHaveBeenCalledWith('cakto-sub-1');
      expect(ctx.asaas.cancelAuthorization).toHaveBeenCalledWith('auth_1');

      expect(outcome(report, 'sub-stripe')).toMatchObject({
        gateway: 'stripe',
        status: 'ACTIVE',
        result: 'cancelled',
        changed: true,
      });
      expect(outcome(report, 'sub-stripe-pastdue')).toMatchObject({
        gateway: 'stripe',
        status: 'PAST_DUE',
        result: 'cancelled',
        changed: true,
        detail: expect.stringContaining('fatura em atraso'),
      });
      expect(outcome(report, 'sub-stripe')!.detail).not.toContain(
        'fatura em atraso',
      );
      expect(outcome(report, 'sub-cakto')).toMatchObject({
        gateway: 'cakto',
        result: 'cancelled',
        changed: true,
      });
      expect(outcome(report, 'sub-asaas')).toMatchObject({
        gateway: 'asaas',
        result: 'cancelled',
        changed: true,
      });
      expect(outcome(report, 'sub-free')).toMatchObject({
        gateway: 'none',
        result: 'cancelled',
        changed: true,
      });
      expect(outcome(report, 'sub-old')).toMatchObject({
        result: 'not_active',
        changed: false,
      });
      expect(outcome(report, 'sub-pp')).toMatchObject({
        gateway: 'perfectpay',
        result: 'manual_action_required',
        detail: expect.stringContaining('área do comprador da Perfect Pay'),
      });
      expect(outcome(report, 'sub-pp')!.detail).toContain('PPSUB1');

      // banco: mesmas regras do SubscriptionsService.cancel e do webhook do PIX Automático
      const subs = ctx.tables.subscription;
      expect(rowById(subs, 'sub-stripe')).toMatchObject({
        status: 'ACTIVE',
        cancelAtPeriodEnd: true,
        scheduledPlanId: null,
      });
      expect(rowById(subs, 'sub-pp')).toMatchObject({
        status: 'ACTIVE',
        cancelAtPeriodEnd: true,
      });
      expect(rowById(subs, 'sub-cakto')).toMatchObject({
        cancelAtPeriodEnd: true,
      });
      expect(rowById(subs, 'sub-asaas')).toMatchObject({
        status: 'CANCELED',
        asaasAuthorizationStatus: 'CANCELED',
        cancelAtPeriodEnd: false,
      });
      expect(rowById(subs, 'sub-free')).toMatchObject({
        cancelAtPeriodEnd: true,
      });
      expect(rowById(subs, 'sub-old')).toMatchObject({
        status: 'CANCELED',
        cancelAtPeriodEnd: false,
      });
      expect(report.nextSteps).toContainEqual(
        expect.stringContaining('sub-pp (perfectpay)'),
      );
    });

    it('um gateway com erro vira "error" e o resto da exclusão segue; a 2ª rodada tenta de novo só ele', async () => {
      const ctx = setup();
      ctx.stripe.cancelSubscription.mockImplementation(
        async (externalId: string) => {
          if (externalId === 'sub_1') throw new Error('Stripe fora do ar');
        },
      );

      const report = await ctx.service.erase(U, CONFIRM);

      expect(outcome(report, 'sub-stripe')).toMatchObject({
        result: 'error',
        changed: false,
        detail: expect.stringContaining('Stripe fora do ar'),
      });
      expect(rowById(ctx.tables.subscription, 'sub-stripe')).toMatchObject({
        cancelAtPeriodEnd: false,
      });
      expect(outcome(report, 'sub-stripe-pastdue')).toMatchObject({
        result: 'cancelled',
      });
      expect(outcome(report, 'sub-asaas')).toMatchObject({
        result: 'cancelled',
      });
      expect(outcome(report, 'sub-cakto')).toMatchObject({
        result: 'cancelled',
      });
      expect(outcome(report, 'sub-pp')).toMatchObject({
        result: 'manual_action_required',
      });
      expect(rowById(ctx.tables.user, U)).toMatchObject({
        email: erasedEmailFor(U),
        isActive: false,
      });
      expect(report.filesDeleted).toBe(12);
      expect(report.nextSteps).toContainEqual(
        expect.stringContaining('sub-stripe (stripe)'),
      );

      ctx.stripe.cancelSubscription.mockImplementation(async () => undefined);
      const again = await ctx.service.erase(U, CONFIRM);
      expect(ctx.stripe.cancelSubscription).toHaveBeenCalledTimes(3);
      expect(ctx.stripe.cancelSubscription).toHaveBeenLastCalledWith('sub_1');
      expect(outcome(again, 'sub-stripe')).toMatchObject({
        result: 'cancelled',
        changed: true,
      });
    });

    it('Stripe sem a assinatura (já cancelada lá) conta como cancelada', async () => {
      const ctx = setup();
      ctx.stripe.cancelSubscription.mockImplementation(
        async (externalId: string) => {
          if (externalId === 'sub_1')
            throw Object.assign(new Error('No such subscription: sub_1'), {
              code: 'resource_missing',
            });
        },
      );
      const report = await ctx.service.erase(U, CONFIRM);
      expect(outcome(report, 'sub-stripe')).toMatchObject({
        result: 'cancelled',
        changed: true,
        detail: expect.stringContaining('já não tem'),
      });
      expect(rowById(ctx.tables.subscription, 'sub-stripe')).toMatchObject({
        cancelAtPeriodEnd: true,
      });
    });

    it('Cakto sem credencial: ação manual e a renovação fica para a próxima rodada', async () => {
      const ctx = setup();
      ctx.cakto.isConfigured.mockReturnValue(false);
      const report = await ctx.service.erase(U, CONFIRM);
      expect(ctx.cakto.cancelSubscription).not.toHaveBeenCalled();
      expect(outcome(report, 'sub-cakto')).toMatchObject({
        result: 'manual_action_required',
        detail: expect.stringContaining('CAKTO_CLIENT_ID'),
      });
      expect(rowById(ctx.tables.subscription, 'sub-cakto')).toMatchObject({
        cancelAtPeriodEnd: false,
      });
    });

    it('Cakto com a API recusando: "error" e nada marcado aqui (a renovação pode continuar)', async () => {
      const ctx = setup();
      ctx.cakto.cancelSubscription.mockRejectedValueOnce(
        new Error('Cakto cancel falhou: HTTP 500 erro interno'),
      );
      const report = await ctx.service.erase(U, CONFIRM);
      expect(outcome(report, 'sub-cakto')).toMatchObject({
        result: 'error',
        changed: false,
        detail: expect.stringContaining('HTTP 500'),
      });
      expect(rowById(ctx.tables.subscription, 'sub-cakto')).toMatchObject({
        cancelAtPeriodEnd: false,
      });
      expect(report.nextSteps).toContainEqual(
        expect.stringContaining('sub-cakto (cakto)'),
      );
    });

    it('Cakto já marcada aqui (o cancelamento do painel marca mesmo com a API falhando): chama a API e relata o resultado real', async () => {
      const ctx = setup({
        seed: (seed) => {
          rowById(seed.subscription, 'sub-cakto')!.cancelAtPeriodEnd = true;
        },
      });
      ctx.cakto.cancelSubscription.mockRejectedValueOnce(
        new Error('Cakto cancel falhou: HTTP 502'),
      );

      const failed = await ctx.service.erase(U, CONFIRM);
      expect(ctx.cakto.cancelSubscription).toHaveBeenCalledWith('cakto-sub-1');
      expect(outcome(failed, 'sub-cakto')).toMatchObject({
        result: 'error',
        detail: expect.stringContaining('HTTP 502'),
      });

      const confirmed = await ctx.service.erase(U, CONFIRM);
      expect(ctx.cakto.cancelSubscription).toHaveBeenCalledTimes(2);
      expect(outcome(confirmed, 'sub-cakto')).toMatchObject({
        result: 'cancelled',
        changed: false,
        detail: expect.stringContaining('confirmado na API da Cakto'),
      });
    });

    it('Cakto sem credencial com a renovação já marcada aqui: segue como ação manual (o campo local não prova nada)', async () => {
      const ctx = setup({
        seed: (seed) => {
          rowById(seed.subscription, 'sub-cakto')!.cancelAtPeriodEnd = true;
        },
      });
      ctx.cakto.isConfigured.mockReturnValue(false);
      const report = await ctx.service.erase(U, CONFIRM);
      expect(outcome(report, 'sub-cakto')).toMatchObject({
        result: 'manual_action_required',
        detail: expect.stringContaining('não garante o cancelamento na Cakto'),
      });
    });

    it('PIX Automático com autorização já expirada: não chama o Asaas, encerra aqui e guarda o status que tinha', async () => {
      const ctx = setup({
        seed: (seed) => {
          rowById(seed.subscription, 'sub-asaas')!.asaasAuthorizationStatus =
            'EXPIRED';
        },
      });
      const report = await ctx.service.erase(U, CONFIRM);
      expect(ctx.asaas.cancelAuthorization).not.toHaveBeenCalled();
      expect(outcome(report, 'sub-asaas')).toMatchObject({
        result: 'cancelled',
        changed: true,
      });
      expect(rowById(ctx.tables.subscription, 'sub-asaas')).toMatchObject({
        status: 'CANCELED',
        asaasAuthorizationStatus: 'EXPIRED',
      });
    });

    it('Asaas recusando o cancelamento: "error" e a assinatura continua como estava para a próxima rodada', async () => {
      const ctx = setup();
      ctx.asaas.cancelAuthorization.mockRejectedValueOnce(
        new Error('Asaas 400: authorization not found'),
      );
      const report = await ctx.service.erase(U, CONFIRM);
      expect(outcome(report, 'sub-asaas')).toMatchObject({
        result: 'error',
        changed: false,
        detail: expect.stringContaining('Asaas 400'),
      });
      expect(rowById(ctx.tables.subscription, 'sub-asaas')).toMatchObject({
        status: 'ACTIVE',
        asaasAuthorizationStatus: 'ACTIVE',
      });
      expect(outcome(report, 'sub-stripe')).toMatchObject({
        result: 'cancelled',
      });
    });
  });

  describe('rodar de novo', () => {
    it('a 2ª rodada não acha mais nada, não chama gateway e não muda nenhuma linha', async () => {
      const ctx = setup();
      const original = clone({
        payment: ctx.tables.payment,
        creditTransaction: ctx.tables.creditTransaction,
      });
      await ctx.service.erase(U, CONFIRM);
      // a geração que estava rodando terminou sem arquivo novo
      rowById(ctx.tables.generation, G2)!.status = 'COMPLETED';
      const afterFirst = clone(ctx.tables);

      const second = await ctx.service.erase(U, CONFIRM);

      expect(second).toMatchObject({
        anonymized: true,
        alreadyErased: true,
        sessionsRevoked: 0,
        tokensDeleted: 0,
        filesDeleted: 0,
        filesFailed: 0,
        generationsScrubbed: 0,
        generationsInFlight: 0,
      });
      expect(Object.values(second.deleted).every((count) => count === 0)).toBe(
        true,
      );
      expect(Object.values(second.scrubbed).every((count) => count === 0)).toBe(
        true,
      );
      expect(second.subscriptions.every((item) => !item.changed)).toBe(true);
      // Perfect Pay segue pendente até a cliente cancelar lá (é o único aviso)
      expect(outcome(second, 'sub-pp')).toMatchObject({
        result: 'manual_action_required',
      });
      expect(second.nextSteps).toEqual([
        expect.stringContaining('Perfect Pay'),
        expect.stringContaining('até 1 minuto'),
      ]);
      expect(ctx.stripe.cancelSubscription).toHaveBeenCalledTimes(2);
      // a Cakto é conferida na API toda rodada (o campo local não prova o cancelamento lá), sem mudar o banco
      expect(ctx.cakto.cancelSubscription).toHaveBeenCalledTimes(2);
      expect(outcome(second, 'sub-cakto')).toMatchObject({
        result: 'cancelled',
        changed: false,
        detail: expect.stringContaining('confirmado na API da Cakto'),
      });
      expect(ctx.asaas.cancelAuthorization).toHaveBeenCalledTimes(1);
      expect(ctx.heygen.deleteAvatarGroupStrict).toHaveBeenCalledTimes(1);
      expect(ctx.tables).toEqual(afterFirst);
      expect(ctx.tables.payment).toEqual(original.payment);
      expect(ctx.tables.creditTransaction).toEqual(original.creditTransaction);
    });

    it('geração que terminou depois da 1ª rodada: a 2ª apaga o arquivo e a saída que ela gravou', async () => {
      const ctx = setup();
      await ctx.service.erase(U, CONFIRM);
      Object.assign(rowById(ctx.tables.generation, G2)!, {
        status: 'COMPLETED',
        parameters: { provider: 'kie' },
      });
      ctx.tables.generationOutput.push({
        id: 'out-late',
        generationId: G2,
        url: `${PUBLIC}/generations/${G2}/u/output_0.png`,
      });
      ctx.bucket.set(`generations/${G2}/`, 1);

      const second = await ctx.service.erase(U, CONFIRM);

      expect(second).toMatchObject({
        generationsScrubbed: 1,
        filesDeleted: 1,
        generationsInFlight: 0,
      });
      expect(second.deleted.generationOutputs).toBe(1);
      expect(ctx.tables.generationOutput.map((row) => row.id)).toEqual([
        'out-o',
      ]);
      expect(rowById(ctx.tables.generation, G2)).toMatchObject({
        parameters: { provider: 'kie' },
        isDeleted: true,
      });
    });
  });

  describe('recusas', () => {
    it('conta de admin: 403 e nada muda', async () => {
      const ctx = setup({ seed: (seed) => (seed.user[0].role = 'ADMIN') });
      const before = clone(ctx.tables);
      await expect(ctx.service.erase(U, CONFIRM)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(ctx.tables).toEqual(before);
      expect(ctx.uploads.deleteByPrefixStrict).not.toHaveBeenCalled();
      expect(ctx.stripe.cancelSubscription).not.toHaveBeenCalled();
      expect(ctx.heygen.deleteAvatarGroupStrict).not.toHaveBeenCalled();
    });

    it('sem confirm: true: 400 e nada muda', async () => {
      const ctx = setup();
      const before = clone(ctx.tables);
      await expect(
        ctx.service.erase(U, { confirm: false }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(ctx.service.erase(U, {} as never)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        ctx.service.erase(U, { confirm: 'true' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(ctx.tables).toEqual(before);
      expect(ctx.uploads.deleteByPrefixStrict).not.toHaveBeenCalled();
    });

    it('usuário inexistente: 404', async () => {
      const ctx = setup();
      await expect(
        ctx.service.erase(cid('naoexiste'), CONFIRM),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('duas exclusões da mesma conta ao mesmo tempo: a 2ª é 409', async () => {
      const ctx = setup();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      ctx.uploads.deleteByPrefixStrict.mockImplementation(async () => {
        await gate;
        return 0;
      });
      const first = ctx.service.erase(U, CONFIRM);
      await expect(ctx.service.erase(U, CONFIRM)).rejects.toBeInstanceOf(
        ConflictException,
      );
      release();
      await expect(first).resolves.toMatchObject({ userId: U });
      await expect(ctx.service.erase(U, CONFIRM)).resolves.toMatchObject({
        alreadyErased: true,
      });
    });
  });

  describe('guarda legal', () => {
    const minorReport = (extra: Row = {}): Row => ({
      id: 'rep-minor',
      category: 'MINOR',
      status: 'OPEN',
      target: `https://www.theaimodelab.com/comunidade/${P1}`,
      description: 'Parece uma menor de idade.',
      isDepictedPerson: false,
      urgent: true,
      createdAt: CREATED,
      ...extra,
    });
    const minorBlocked = (id: string, daysAgo: number): Row => ({
      id,
      userId: U,
      kind: 'MINOR_BLOCKED',
      route: '/api/v1/generations/text-to-image',
      match: 'idade',
      createdAt: new Date(Date.now() - daysAgo * 86_400_000),
    });
    const threeMinorBlocks = (): Row[] => [
      minorBlocked('mb-1', 1),
      minorBlocked('mb-2', 10),
      minorBlocked('mb-3', 89),
    ];
    const OVERRIDE = {
      ...CONFIRM,
      reason: 'falso positivo do filtro: anime adulto, conferido pela equipe',
      ignoreSafetyEvents: true,
    };
    /**
     * Com a guarda, só a conta (isActive), os tokens, as assinaturas, a campanha de cobrança e o status dos posts
     * publicados ou pendentes da conta (saem do ar) mudam.
     */
    const UNTOUCHED = [
      'generation',
      'generationOutput',
      'generationInputImage',
      'communityPostLike',
      'userFollow',
      'notification',
      'folder',
      'generationFolder',
      'workspace',
      'brand',
      'videoProject',
      'videoProjectClip',
      'feedback',
      'voiceProfile',
      'influencers',
      'userAvatar',
      'unlimitedUsage',
      'userFreeGeneration',
      'weeklyClaim',
      'emailSequenceLog',
      'analyticsEvent',
      'marketingLead',
      'emailBroadcastRecipient',
      'pendingFreeGenerationGrant',
      'affiliate',
      'payment',
      'creditTransaction',
      'affiliateEarning',
      'contentReport',
      'contentSafetyEvent',
    ];

    it('denúncia de menor citando um post: só bloqueia (acesso, sessões, renovação) e tira os posts do ar; nada é anonimizado, limpo ou apagado', async () => {
      const ctx = setup({
        seed: (seed) => {
          seed.contentReport.push(minorReport());
          seed.communityPost.push(
            {
              id: P3,
              userId: U,
              generationId: null,
              kind: 'image',
              mediaUrl: 'x',
              prompt: 'esperando aprovação',
              status: 'PENDING',
              likesCount: 0,
              rejectionReason: null,
            },
            {
              id: P4,
              userId: U,
              generationId: null,
              kind: 'image',
              mediaUrl: 'x',
              prompt: 'recusado antes',
              status: 'REJECTED',
              likesCount: 0,
              rejectionReason: 'spam',
            },
          );
        },
      });
      const before = clone(ctx.tables);

      const report = await ctx.service.erase(U, CONFIRM);

      expect(report).toMatchObject({
        anonymized: false,
        alreadyErased: false,
        sessionsRevoked: 2,
        tokensDeleted: 6,
        filesDeleted: 0,
        filesFailed: 0,
        generationsScrubbed: 0,
      });
      expect(report.legalHold).toEqual({
        active: true,
        kinds: ['report'],
        reasons: [expect.stringContaining('rep-minor')],
        reportIds: ['rep-minor'],
        // o post citado leva a geração dele, e a geração leva o avatar e a voz usados
        generationIds: [G1],
        communityPostIds: [P1],
        avatarIds: [A1],
        voiceProfileIds: [V1],
        minorBlockedEvents: 0,
        minorBlockedAttempts: 0,
        providerMinorBlockedEvents: 0,
        reviewConfirmedEvents: 0,
        communityPostsUnpublished: 2,
        // nenhuma geração da semente tinha prazo de expiração
        generationsExpiryCleared: 0,
      });
      expect(report.legalHold.reasons[0]).toContain('menor de idade');
      // publicado e pendente saem do ar (a linha fica como evidência); o já recusado e o de outra conta não mudam
      expect(ctx.tables.communityPost).toEqual(
        before.communityPost.map((post) =>
          post.userId === U && ['APPROVED', 'PENDING'].includes(post.status)
            ? { ...post, status: 'REJECTED', rejectionReason: 'legal_hold' }
            : post,
        ),
      );
      expect(rowById(ctx.tables.communityPost, P4)).toMatchObject({
        status: 'REJECTED',
        rejectionReason: 'spam',
      });
      expect(ctx.delegates.communityPost.deleteMany).not.toHaveBeenCalled();
      // a pessoa continua identificável: a evidência fica ligada a quem a criou
      expect(rowById(ctx.tables.user, U)).toEqual({
        ...before.user[0],
        isActive: false,
        marketingOptOut: true,
      });
      for (const model of UNTOUCHED) {
        expect([model, ctx.tables[model]]).toEqual([model, before[model]]);
        for (const write of [
          'update',
          'updateMany',
          'deleteMany',
          'createMany',
        ] as const) {
          // a única escrita em generation é tirar o prazo de expiração (conferida abaixo)
          if (model === 'generation' && write === 'updateMany') continue;
          expect(
            ctx.delegates[model]?.[write] ?? jest.fn(),
          ).not.toHaveBeenCalled();
        }
      }
      // dentro da transação da guarda e de novo logo depois do commit (geração concluída no meio)
      expect(ctx.delegates.generation.updateMany.mock.calls).toEqual([
        [
          {
            where: { userId: U, expiresAt: { not: null } },
            data: { expiresAt: null },
          },
        ],
        [
          {
            where: { userId: U, expiresAt: { not: null } },
            data: { expiresAt: null },
          },
        ],
      ]);
      expect(ctx.tables.refreshToken.map((row) => row.id)).toEqual(['rt-o']);
      expect(ctx.tables.passwordResetToken).toEqual([]);
      expect(ctx.uploads.deleteByPrefixStrict).not.toHaveBeenCalled();
      expect(ctx.heygen.deleteAvatarGroupStrict).not.toHaveBeenCalled();
      // sem 2ª etapa na guarda: nada foi apagado
      expect(report.storage).toMatchObject({
        prefixesTotal: 0,
        completed: true,
        finalized: false,
      });
      expect(report.storage.finalizeError).toBeUndefined();
      expect(report.providers.heygenAvatarGroups).toEqual({
        requested: 0,
        failed: 0,
        failedIds: [],
      });
      // a renovação é desligada mesmo assim
      expect(ctx.stripe.cancelSubscription).toHaveBeenCalledTimes(2);
      expect(outcome(report, 'sub-stripe')).toMatchObject({
        result: 'cancelled',
      });
      expect(rowById(ctx.tables.subscription, 'sub-stripe')).toMatchObject({
        cancelAtPeriodEnd: true,
      });
      // e-mail de cobrança parado, cartão guardado (nada é limpo)
      expect(
        rowById(ctx.tables.paymentRecoveryCampaign, 'prc-1'),
      ).toMatchObject({ abandonedAt: expect.any(Date), cardLast4: '4242' });
      expect(report.kept).toMatchObject({ generations: 3, payments: 2 });
      expect(report.nextSteps).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Acesso bloqueado e sessões encerradas'),
          expect.stringContaining('LGPD, art. 16, I, e art. 7º, VI'),
          expect.stringContaining('Avise o titular'),
          expect.stringContaining(
            '2 posts da comunidade desta conta saíram do ar',
          ),
          expect.stringContaining(
            'Quando o caso for encerrado e a evidência entregue às autoridades, marque cada denúncia',
          ),
          expect.stringContaining(
            '"evidência liberada" no admin (Denúncias) e rode a exclusão de novo',
          ),
          expect.stringContaining('sub-pp (perfectpay)'),
          expect.stringContaining('até 1 minuto'),
        ]),
      );

      // rodar de novo com a guarda: continua só bloqueada; os posts já estão fora do ar
      const again = await ctx.service.erase(U, CONFIRM);
      expect(again.anonymized).toBe(false);
      expect(again.legalHold.communityPostsUnpublished).toBe(0);
      expect(again.nextSteps).not.toContainEqual(
        expect.stringContaining('saíram do ar'),
      );
      expect(rowById(ctx.tables.communityPost, P1)).toMatchObject({
        status: 'REJECTED',
        rejectionReason: 'legal_hold',
      });
    });

    it('denúncia confirmada (ACTIONED) segura; quando o caso fecha (descartada), a rodada seguinte apaga tudo', async () => {
      const ctx = setup({
        seed: (seed) =>
          seed.contentReport.push(
            minorReport({
              status: 'ACTIONED',
              target: G3,
              description: 'Confirmada pela equipe.',
            }),
          ),
      });

      const held = await ctx.service.erase(U, CONFIRM);
      expect(held.anonymized).toBe(false);
      expect(held.legalHold).toMatchObject({
        active: true,
        reportIds: ['rep-minor'],
        generationIds: [G3],
        communityPostIds: [],
      });
      expect(held.legalHold.reasons[0]).toContain('confirmada');
      expect(rowById(ctx.tables.generation, G3)).toMatchObject({
        errorMessage: 'Your prompt "Maria nua" violates policy',
        isDeleted: false,
      });

      rowById(ctx.tables.contentReport, 'rep-minor')!.status = 'DISMISSED';
      const erased = await ctx.service.erase(U, CONFIRM);
      expect(erased).toMatchObject({ anonymized: true, alreadyErased: false });
      expect(erased.legalHold.active).toBe(false);
      expect(rowById(ctx.tables.user, U)).toMatchObject({
        email: erasedEmailFor(U),
        name: ERASED_USER_NAME,
      });
      expect(rowById(ctx.tables.generation, G3)).toMatchObject({
        errorMessage: null,
        isDeleted: true,
      });
      expect(ctx.tables.communityPost.map((row) => row.id)).toEqual([P2]);
    });

    it('denúncia confirmada só libera com "evidência liberada"; a marca numa denúncia ainda em análise não libera', async () => {
      const ctx = setup({
        seed: (seed) =>
          seed.contentReport.push(
            minorReport({
              status: 'ACTIONED',
              target: G3,
              description: 'Confirmada pela equipe.',
            }),
          ),
      });
      const report = rowById(ctx.tables.contentReport, 'rep-minor')!;

      // reaberta (em análise) com a marca: o caso não fechou, a guarda fica e o motivo explica
      report.status = 'IN_REVIEW';
      report.evidenceReleasedAt = new Date('2026-10-16T10:00:00.000Z');
      report.evidenceReleasedBy = 'admin@theaimodelab.com';
      const stillHeld = await ctx.service.erase(U, CONFIRM);
      expect(stillHeld.anonymized).toBe(false);
      expect(stillHeld.legalHold.reportIds).toEqual(['rep-minor']);
      expect(stillHeld.legalHold.reasons[0]).toContain(
        'marcada como evidência liberada, mas a denúncia ainda não foi encerrada',
      );

      // confirmada e com a evidência liberada: a guarda sai e a exclusão apaga tudo
      report.status = 'ACTIONED';
      const erased = await ctx.service.erase(U, CONFIRM);
      expect(erased.anonymized).toBe(true);
      expect(erased.legalHold).toMatchObject({ active: false, reportIds: [] });
      expect(rowById(ctx.tables.user, U)).toMatchObject({
        email: erasedEmailFor(U),
      });
      expect(rowById(ctx.tables.generation, G3)).toMatchObject({
        errorMessage: null,
        isDeleted: true,
      });
      // a denúncia fica (registro de segurança), com a marca de quem liberou
      expect(rowById(ctx.tables.contentReport, 'rep-minor')).toMatchObject({
        status: 'ACTIONED',
        evidenceReleasedBy: 'admin@theaimodelab.com',
      });
    });

    it('denúncia feita pela própria conta (logada ou com o e-mail dela) não segura: a vítima consegue apagar os dados', async () => {
      const victimReport = (extra: Row): Row => ({
        id: 'rep-victim',
        category: 'NON_CONSENSUAL',
        status: 'OPEN',
        // a vítima cita o próprio perfil e o próprio e-mail para contato
        target: `https://www.theaimodelab.com/community/users/${U}`,
        description:
          'Criaram uma imagem íntima minha. Meu contato: maria@exemplo.com',
        isDepictedPerson: true,
        urgent: true,
        ...extra,
      });

      for (const filedBy of [
        { reporterUserId: U, reporterEmail: null },
        { reporterUserId: null, reporterEmail: '  MARIA@Exemplo.COM ' },
      ]) {
        const ctx = setup({
          seed: (seed) => seed.contentReport.push(victimReport(filedBy)),
        });
        const report = await ctx.service.erase(U, CONFIRM);
        expect([filedBy, report.anonymized]).toEqual([filedBy, true]);
        expect(report.legalHold).toMatchObject({
          active: false,
          reportIds: [],
        });
        // a denúncia em si fica guardada
        expect(rowById(ctx.tables.contentReport, 'rep-victim')).toBeDefined();
      }

      // a mesma denúncia vinda de outra pessoa segura a conta
      const other = setup({
        seed: (seed) =>
          seed.contentReport.push(
            victimReport({
              reporterUserId: O,
              reporterEmail: 'outra@exemplo.com',
            }),
          ),
      });
      const held = await other.service.erase(U, CONFIRM);
      expect(held.anonymized).toBe(false);
      expect(held.legalHold.reportIds).toEqual(['rep-victim']);
    });

    it('quais denúncias seguram: imagem íntima, uso de imagem pela própria pessoa, texto que cita menor, perfil e e-mail citados', async () => {
      const ctx = setup({
        seed: (seed) =>
          seed.contentReport.push(
            {
              id: 'rep-nc',
              category: 'NON_CONSENSUAL',
              status: 'IN_REVIEW',
              target: G2,
              description: 'Foto íntima minha publicada sem consentimento.',
              isDepictedPerson: true,
              urgent: true,
            },
            {
              id: 'rep-imp-self',
              category: 'IMPERSONATION',
              status: 'OPEN',
              target: `https://www.theaimodelab.com/community/users/${U}`,
              description: 'Esse perfil usa o meu rosto.',
              isDepictedPerson: true,
              urgent: true,
            },
            {
              id: 'rep-text',
              category: 'OTHER',
              status: 'OPEN',
              target: 'Conta MARIA@exemplo.com',
              description: 'Mostra uma garota de 15 anos.',
              isDepictedPerson: false,
              urgent: false,
            },
            {
              id: 'rep-imp-other',
              category: 'IMPERSONATION',
              status: 'OPEN',
              target: G1,
              description: 'Parece uma atriz famosa.',
              isDepictedPerson: false,
              urgent: false,
            },
            {
              id: 'rep-copy',
              category: 'COPYRIGHT',
              status: 'OPEN',
              target: G1,
              description: 'Usou a minha arte.',
              isDepictedPerson: false,
              urgent: false,
            },
            {
              id: 'rep-dismissed',
              category: 'MINOR',
              status: 'DISMISSED',
              target: G3,
              description: 'Descartada pela equipe.',
              urgent: true,
            },
            {
              id: 'rep-other-account',
              category: 'MINOR',
              status: 'OPEN',
              target: GO,
              description: 'Conteúdo de outra conta.',
              urgent: true,
            },
          ),
      });

      const report = await ctx.service.erase(U, CONFIRM);

      expect(report.anonymized).toBe(false);
      expect([...report.legalHold.reportIds].sort()).toEqual([
        'rep-imp-self',
        'rep-nc',
        'rep-text',
      ]);
      expect(report.legalHold.generationIds).toEqual([G2]);
      expect(report.legalHold.reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining('o perfil'),
          expect.stringContaining('o e-mail'),
          expect.stringContaining('o texto cita menor de idade'),
          expect.stringContaining('imagem íntima sem consentimento'),
        ]),
      );
      expect(rowById(ctx.tables.user, U)).toMatchObject({
        email: 'Maria@Exemplo.com',
        isActive: false,
      });
    });

    it('3+ bloqueios por menor nos últimos 90 dias seguram a conta; 2, antigos ou de outra conta, não', async () => {
      const held = setup({
        seed: (seed) => seed.contentSafetyEvent.push(...threeMinorBlocks()),
      });
      const report = await held.service.erase(U, CONFIRM);
      expect(report.anonymized).toBe(false);
      expect(report.legalHold).toMatchObject({
        active: true,
        kinds: ['safety_events'],
        reportIds: [],
        generationIds: [],
        minorBlockedEvents: 3,
        reasons: [
          expect.stringContaining('3 pedidos desta conta foram bloqueados'),
        ],
      });
      expect(report.nextSteps).toContainEqual(
        expect.stringContaining('ignoreSafetyEvents: true'),
      );
      expect(rowById(held.tables.user, U)).toMatchObject({
        email: 'Maria@Exemplo.com',
        isActive: false,
      });
      expect(held.uploads.deleteByPrefixStrict).not.toHaveBeenCalled();

      const below = setup({
        seed: (seed) =>
          seed.contentSafetyEvent.push(
            minorBlocked('mb-1', 1),
            minorBlocked('mb-2', 2),
            minorBlocked('mb-old', 120),
            { ...minorBlocked('mb-other', 1), userId: O },
            { ...minorBlocked('mb-consent', 1), kind: 'CONSENT_MISSING' },
          ),
      });
      const erased = await below.service.erase(U, CONFIRM);
      expect(erased.anonymized).toBe(true);
      expect(erased.legalHold).toMatchObject({
        active: false,
        minorBlockedEvents: 2,
      });
    });

    it('ignoreSafetyEvents com motivo libera só os bloqueios: a conta é apagada e o relatório registra', async () => {
      const ctx = setup({
        seed: (seed) => seed.contentSafetyEvent.push(...threeMinorBlocks()),
      });
      const report = await ctx.service.erase(U, OVERRIDE);
      expect(report.anonymized).toBe(true);
      expect(report.legalHold).toMatchObject({
        active: false,
        kinds: [],
        reasons: [],
        minorBlockedEvents: 3,
      });
      expect(report.nextSteps).toContainEqual(
        expect.stringContaining('ignorados a pedido do admin'),
      );
      expect(rowById(ctx.tables.user, U)).toMatchObject({
        email: erasedEmailFor(U),
      });
      // os registros de segurança ficam
      expect(ctx.tables.contentSafetyEvent).toHaveLength(4);
    });

    it('ignoreSafetyEvents nunca libera denúncia', async () => {
      const ctx = setup({
        seed: (seed) => {
          seed.contentReport.push(minorReport());
          seed.contentSafetyEvent.push(...threeMinorBlocks());
        },
      });
      const report = await ctx.service.erase(U, OVERRIDE);
      expect(report.anonymized).toBe(false);
      expect(report.legalHold).toMatchObject({
        active: true,
        kinds: ['report'],
        minorBlockedEvents: 3,
      });
      expect(report.nextSteps).toContainEqual(
        expect.stringContaining('vale só para os bloqueios'),
      );
      expect(rowById(ctx.tables.user, U)).toMatchObject({
        email: 'Maria@Exemplo.com',
      });
    });

    it('ignoreSafetyEvents sem motivo de 10+ caracteres: 400 e nada muda', async () => {
      const ctx = setup({
        seed: (seed) => seed.contentSafetyEvent.push(...threeMinorBlocks()),
      });
      const before = clone(ctx.tables);
      for (const reason of [undefined, null, '', 'curto', '   engano   ']) {
        await expect(
          ctx.service.erase(U, {
            confirm: true,
            reason,
            ignoreSafetyEvents: true,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      await expect(
        ctx.service.erase(U, {
          confirm: true,
          reason: 'motivo longo o bastante',
          ignoreSafetyEvents: 'sim',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(ctx.tables).toEqual(before);
      expect(ctx.stripe.cancelSubscription).not.toHaveBeenCalled();
    });

    it('a guarda tira o prazo de expiração das gerações da conta na mesma transação (o cron da galeria não apaga evidência)', async () => {
      const past = new Date(Date.now() - 86_400_000);
      const ctx = setup({
        seed: (seed) => {
          seed.contentReport.push(minorReport());
          Object.assign(rowById(seed.generation, G1)!, { expiresAt: past });
          Object.assign(rowById(seed.generation, G3)!, {
            expiresAt: inOneDay(),
          });
          Object.assign(rowById(seed.generation, GO)!, { expiresAt: past });
        },
      });

      const report = await ctx.service.erase(U, CONFIRM);

      expect(report.anonymized).toBe(false);
      expect(report.legalHold.generationsExpiryCleared).toBe(2);
      expect(rowById(ctx.tables.generation, G1)!.expiresAt).toBeNull();
      expect(rowById(ctx.tables.generation, G3)!.expiresAt).toBeNull();
      // geração de outra conta não muda
      expect(rowById(ctx.tables.generation, GO)!.expiresAt).toEqual(past);
      expect(report.nextSteps).toContainEqual(
        expect.stringContaining('o prazo foi retirado'),
      );
      // o resto da geração fica como estava (evidência)
      expect(rowById(ctx.tables.generation, G1)).toMatchObject({
        prompt: 'Oi, eu sou a Maria',
        isDeleted: false,
      });

      const again = await ctx.service.erase(U, CONFIRM);
      expect(again.legalHold.generationsExpiryCleared).toBe(0);
    });

    it('recusa do provedor por menor na imagem enviada (de qualquer data) segura a conta; ignoreSafetyEvents não libera', async () => {
      const providerBlock = (): Row => ({
        id: 'mb-provider',
        userId: U,
        kind: 'MINOR_BLOCKED',
        route: 'provider:veo3-fast',
        match: 'provider',
        generationId: G3,
        createdAt: new Date(Date.now() - 400 * 86_400_000),
      });
      for (const options of [CONFIRM, OVERRIDE]) {
        const ctx = setup({
          seed: (seed) => seed.contentSafetyEvent.push(providerBlock()),
        });

        const report = await ctx.service.erase(U, options);

        expect(report.anonymized).toBe(false);
        expect(report.legalHold).toMatchObject({
          active: true,
          kinds: ['provider_minor'],
          providerMinorBlockedEvents: 1,
          // fora da janela de 90 dias: não conta como bloqueio recente
          minorBlockedEvents: 0,
          reasons: [expect.stringContaining('recusado pelo provedor de IA')],
        });
        expect(report.nextSteps).toContainEqual(
          expect.stringContaining('não sai com ignoreSafetyEvents'),
        );
        // nada apagado: a imagem de entrada (evidência) fica, a conta continua identificável
        expect(ctx.tables.generationInputImage.map((row) => row.id)).toEqual([
          'in-1',
        ]);
        expect(rowById(ctx.tables.user, U)).toMatchObject({
          email: 'Maria@Exemplo.com',
          isActive: false,
        });
        expect(ctx.uploads.deleteByPrefixStrict).not.toHaveBeenCalled();
        if (options === OVERRIDE) {
          expect(report.nextSteps).toContainEqual(
            expect.stringContaining(
              'ignoreSafetyEvents vale só para os bloqueios',
            ),
          );
        }
      }
    });

    it('geração com bloqueio por menor ligado a ela nunca perde texto, entradas, saídas ou pastas (mesmo sem guarda da conta)', async () => {
      const ctx = setup({
        seed: (seed) =>
          // evento sem conta (userId null) ligado à geração G3: não segura a conta, mas a geração é evidência
          seed.contentSafetyEvent.push({
            id: 'mb-gen',
            userId: null,
            kind: 'MINOR_BLOCKED',
            route: 'provider:seedream',
            match: 'provider',
            generationId: G3,
            createdAt: CREATED,
          }),
      });
      const g3Before = clone(rowById(ctx.tables.generation, G3));

      const report = await ctx.service.erase(U, CONFIRM);

      expect(report.anonymized).toBe(true);
      expect(report.legalHold.active).toBe(false);
      expect(report.generationsKeptAsEvidence).toBe(1);
      expect(report.generationsScrubbed).toBe(2);
      expect(rowById(ctx.tables.generation, G3)).toEqual(g3Before);
      expect(ctx.tables.generationInputImage.map((row) => row.id)).toEqual([
        'in-1',
      ]);
      const requested = ctx.uploads.deleteByPrefixStrict.mock.calls.map(
        ([prefix]) => prefix,
      );
      expect(requested.some((prefix) => prefix.includes(G3))).toBe(false);
      expect(ctx.bucket.get(`generations/${G3}/`)).toBe(1);
      expect(report.nextSteps).toContainEqual(
        expect.stringContaining('intactas como evidência'),
      );
      // o resto sai normalmente
      expect(ctx.tables.generationOutput.map((row) => row.id)).toEqual([
        'out-o',
      ]);

      // 2ª rodada: continua intacta
      const again = await ctx.service.erase(U, CONFIRM);
      expect(again.generationsKeptAsEvidence).toBe(1);
      expect(rowById(ctx.tables.generation, G3)).toEqual(g3Before);
      expect(ctx.tables.generationInputImage.map((row) => row.id)).toEqual([
        'in-1',
      ]);
    });

    describe('recusa do provedor: só com mídia da conta é provider_minor', () => {
      const providerBlock = (extra: Row = {}): Row => ({
        id: 'mb-provider',
        userId: U,
        kind: 'MINOR_BLOCKED',
        route: 'provider:nano-banana',
        match: 'provider',
        excerpt: 'pedido de texto',
        generationId: G2,
        createdAt: new Date(Date.now() - 60_000),
        ...extra,
      });

      it('pedido só com texto: 1 recusa não segura a conta; a geração fica como evidência', async () => {
        const ctx = setup({
          seed: (seed) => seed.contentSafetyEvent.push(providerBlock()),
        });

        const report = await ctx.service.erase(U, CONFIRM);

        expect(report.anonymized).toBe(true);
        expect(report.legalHold).toMatchObject({
          active: false,
          kinds: [],
          minorBlockedEvents: 1,
          minorBlockedAttempts: 1,
          providerMinorBlockedEvents: 0,
        });
        // o texto do pedido continua sendo evidência da geração (a regra de minorBlockedGenerationIds não mudou)
        expect(report.generationsKeptAsEvidence).toBe(1);
        expect(rowById(ctx.tables.generation, G2)).toMatchObject({
          prompt: 'Retrato da Maria na praia',
        });
      });

      it('pedido só com texto conta junto com o filtro de texto: 3 tentativas seguram como safety_events (override vale) e o motivo não fala em foto', async () => {
        const seedBlocks = (seed: Seed) =>
          seed.contentSafetyEvent.push(
            providerBlock(),
            { ...minorBlocked('mb-text-1', 5), excerpt: 'outro pedido' },
            { ...minorBlocked('mb-text-2', 20), excerpt: 'mais um pedido' },
          );
        const held = setup({ seed: seedBlocks });
        const report = await held.service.erase(U, CONFIRM);
        expect(report.anonymized).toBe(false);
        expect(report.legalHold).toMatchObject({
          active: true,
          kinds: ['safety_events'],
          minorBlockedEvents: 3,
          minorBlockedAttempts: 3,
          providerMinorBlockedEvents: 0,
        });
        for (const reason of report.legalHold.reasons) {
          expect(reason).not.toMatch(/foto|imagem|vídeo/i);
        }

        const overridden = setup({ seed: seedBlocks });
        const erased = await overridden.service.erase(U, OVERRIDE);
        expect(erased.anonymized).toBe(true);
        expect(erased.legalHold).toMatchObject({ active: false, kinds: [] });
      });

      it.each([
        [
          'atestado de consentimento ligado à geração',
          (seed: Seed) => {
            seed.contentSafetyEvent.push({
              id: 'cse-g2',
              userId: U,
              kind: 'CONSENT_ATTESTED',
              route: '/api/v1/generations/image',
              generationId: G2,
            });
          },
        ],
        [
          'vídeo de referência marcado nos parâmetros (hasVideoInput)',
          (seed: Seed) => {
            rowById(seed.generation, G2)!.parameters = {
              provider: 'kie',
              hasVideoInput: true,
            };
          },
        ],
        [
          'imagem de entrada gravada',
          (seed: Seed) => {
            seed.generationInputImage.push({
              id: 'in-g2',
              generationId: G2,
              url: `${PUBLIC}/inputs/${G2}/u/input.png`,
              role: 'REFERENCE',
            });
          },
        ],
      ])(
        'com mídia da conta (%s): 1 recusa segura como provider_minor, sem override',
        async (_label, addMedia) => {
          for (const options of [CONFIRM, OVERRIDE]) {
            const ctx = setup({
              seed: (seed) => {
                seed.contentSafetyEvent.push(providerBlock());
                addMedia(seed);
              },
            });
            const report = await ctx.service.erase(U, options);
            expect(report.anonymized).toBe(false);
            expect(report.legalHold).toMatchObject({
              active: true,
              kinds: ['provider_minor'],
              providerMinorBlockedEvents: 1,
              minorBlockedEvents: 0,
              reasons: [
                expect.stringContaining('com foto ou vídeo enviado pela conta'),
              ],
            });
            expect(report.nextSteps).toContainEqual(
              expect.stringContaining(
                '/api/v1/admin/content-safety/events/:id/release',
              ),
            );
          }
        },
      );
    });

    it('bloqueio liberado pelo jurídico não conta para a guarda nem segura a geração', async () => {
      const released = {
        releasedAt: new Date(Date.now() - 3_600_000),
        releasedBy: 'admin-1',
        releaseNote: 'falso positivo do provedor, conferido',
      };
      const ctx = setup({
        seed: (seed) =>
          seed.contentSafetyEvent.push(
            {
              id: 'mb-provider-released',
              userId: U,
              kind: 'MINOR_BLOCKED',
              route: 'provider:seedream',
              match: 'provider',
              generationId: G3,
              createdAt: CREATED,
              ...released,
            },
            ...threeMinorBlocks().map((row, index) =>
              index === 0 ? { ...row, ...released } : row,
            ),
          ),
      });

      const report = await ctx.service.erase(U, CONFIRM);

      expect(report.anonymized).toBe(true);
      expect(report.legalHold).toMatchObject({
        active: false,
        kinds: [],
        minorBlockedEvents: 2,
        minorBlockedAttempts: 2,
        providerMinorBlockedEvents: 0,
      });
      // a geração do bloqueio liberado volta à regra comum: a entrada sai
      expect(report.generationsKeptAsEvidence).toBe(0);
      expect(ctx.tables.generationInputImage).toEqual([]);
      // os registros de segurança ficam, com a liberação
      expect(
        ctx.tables.contentSafetyEvent.filter((row) => row.releasedAt),
      ).toHaveLength(2);
    });

    it('cliques em paralelo e reenvio na hora são uma tentativa; 3 tentativas distintas seguram', async () => {
      const at = (minutesAgo: number) =>
        new Date(Date.now() - minutesAgo * 60_000);
      const block = (
        id: string,
        minutesAgo: number,
        excerpt: string | null,
      ): Row => ({
        id,
        userId: U,
        kind: 'MINOR_BLOCKED',
        route: '/api/v1/generations/text-to-image',
        match: 'idade',
        excerpt,
        createdAt: at(minutesAgo),
      });
      const burst = [
        // 4 gerações em paralelo do mesmo clique e o mesmo pedido reenviado 5 min depois
        block('mb-a1', 600, 'menina de 15 anos'),
        block('mb-a2', 600, 'menina de 15 anos'),
        block('mb-a3', 600, 'menina de 15 anos'),
        block('mb-a4', 595, 'Menina  de 15 anos'),
        // outro clique, sem trecho, em 1 minuto
        block('mb-b1', 300, null),
        block('mb-b2', 299, null),
      ];
      const twoAttempts = setup({
        seed: (seed) => seed.contentSafetyEvent.push(...burst),
      });
      const erased = await twoAttempts.service.erase(U, CONFIRM);
      expect(erased.anonymized).toBe(true);
      expect(erased.legalHold).toMatchObject({
        active: false,
        minorBlockedEvents: 6,
        minorBlockedAttempts: 2,
      });

      const threeAttempts = setup({
        seed: (seed) =>
          seed.contentSafetyEvent.push(
            ...burst,
            block('mb-c1', 10, 'adolescente 15'),
          ),
      });
      const held = await threeAttempts.service.erase(U, CONFIRM);
      expect(held.anonymized).toBe(false);
      expect(held.legalHold).toMatchObject({
        active: true,
        kinds: ['safety_events'],
        minorBlockedEvents: 7,
        minorBlockedAttempts: 3,
        reasons: [
          expect.stringContaining(
            '7 pedidos desta conta foram bloqueados em 3 tentativas distintas',
          ),
        ],
      });
    });

    it('geração concluída no meio da guarda (gravou o prazo) perde o prazo logo depois do commit', async () => {
      const ctx = setup({
        seed: (seed) => seed.contentReport.push(minorReport()),
      });
      const generation = ctx.prisma.generation;
      const original = generation.updateMany.getMockImplementation()!;
      generation.updateMany.mockImplementationOnce(async (args: Row) => {
        const result = await original(args);
        // o processador leu a conta ainda ativa e gravou o prazo depois da limpeza de dentro da transação
        rowById(ctx.tables.generation, G2)!.expiresAt = inOneDay();
        return result;
      });

      const report = await ctx.service.erase(U, CONFIRM);

      expect(report.anonymized).toBe(false);
      expect(rowById(ctx.tables.generation, G2)!.expiresAt).toBeNull();
      expect(report.legalHold.generationsExpiryCleared).toBe(1);
    });

    it('a conferência do prazo depois do commit falhando não derruba a guarda (vira log)', async () => {
      const ctx = setup({
        seed: (seed) => seed.contentReport.push(minorReport()),
      });
      const generation = ctx.prisma.generation;
      const original = generation.updateMany.getMockImplementation()!;
      generation.updateMany
        .mockImplementationOnce(original)
        .mockImplementationOnce(async () => {
          throw new Error('conexão caiu');
        });
      const errorLog = jest.spyOn(Logger.prototype, 'error');

      const report = await ctx.service.erase(U, CONFIRM);

      expect(report.anonymized).toBe(false);
      expect(report.legalHold.active).toBe(true);
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining(
          'falha ao conferir o prazo das gerações depois do commit',
        ),
      );
    });

    it('denúncia da própria conta citando conteúdo dela segura a conta', async () => {
      const ctx = setup({
        seed: (seed) =>
          seed.contentReport.push({
            id: 'rep-self-content',
            category: 'NON_CONSENSUAL',
            status: 'OPEN',
            target: G1,
            description: 'Esse vídeo foi feito com o meu rosto sem eu deixar.',
            isDepictedPerson: true,
            urgent: true,
            reporterUserId: U,
            reporterEmail: 'maria@exemplo.com',
            createdAt: CREATED,
          }),
      });
      const report = await ctx.service.erase(U, CONFIRM);
      expect(report.anonymized).toBe(false);
      expect(report.legalHold).toMatchObject({
        kinds: ['report'],
        reportIds: ['rep-self-content'],
        generationIds: [G1],
      });
      expect(report.legalHold.reasons[0]).toContain('feita pela própria conta');
    });

    it('denúncias em duas passadas: a tabela inteira fora da transação; dentro, só as candidatas e as novas, com o status de agora', async () => {
      const ctx = setup({
        seed: (seed) =>
          seed.contentReport.push({
            id: 'rep-copy-old',
            category: 'COPYRIGHT',
            status: 'OPEN',
            target: 'https://x.com/arte',
            description: 'Nada desta conta.',
            createdAt: CREATED,
          }),
      });
      const reports = ctx.prisma.contentReport;
      const findMany = reports.findMany.getMockImplementation()!;
      // denúncia nova chega entre a 1ª passada e a transação
      reports.findMany.mockImplementationOnce(async (args: Row) => {
        const page = await findMany(args);
        ctx.tables.contentReport.push(
          minorReport({
            id: 'rep-late',
            target: G2,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        );
        return page;
      });

      const report = await ctx.service.erase(U, CONFIRM);

      expect(report.anonymized).toBe(false);
      expect(report.legalHold.reportIds).toEqual(['rep-late']);
      // só a 1ª passada varre a tabela; dentro da transação a busca é por id ou por data
      const fullScans = reports.findMany.mock.calls.filter(
        ([args]: [Row]) => !args.where?.id?.in && !args.where?.OR,
      );
      expect(fullScans).toHaveLength(1);

      // candidata descartada entre as passadas: a 2ª lê o status de agora e não segura
      const dismissed = setup({
        seed: (seed) => seed.contentReport.push(minorReport()),
      });
      const dismissedReports = dismissed.prisma.contentReport;
      const scan = dismissedReports.findMany.getMockImplementation()!;
      dismissedReports.findMany.mockImplementationOnce(async (args: Row) => {
        const page = await scan(args);
        rowById(dismissed.tables.contentReport, 'rep-minor')!.status =
          'DISMISSED';
        return page;
      });
      expect((await dismissed.service.erase(U, CONFIRM)).anonymized).toBe(true);
    });
  });

  describe('cache de sessão', () => {
    it('invalida a conta no cache do JwtStrategy logo depois de gravar (com e sem guarda); recusa não invalida', async () => {
      for (const withHold of [false, true]) {
        const ctx = setup({
          seed: (seed) => {
            if (withHold)
              seed.contentReport.push({
                id: 'rep-minor',
                category: 'MINOR',
                status: 'OPEN',
                target: G1,
                description: 'Parece uma menor de idade.',
                urgent: true,
                createdAt: CREATED,
              });
          },
        });
        const inactiveWhenInvalidated: boolean[] = [];
        const invalidate = jest
          .spyOn(activeUserCache, 'invalidate')
          .mockImplementation((userId: string) => {
            inactiveWhenInvalidated.push(
              rowById(ctx.tables.user, userId)?.isActive === false,
            );
          });

        const report = await ctx.service.erase(U, CONFIRM);

        expect(report.anonymized).toBe(!withHold);
        expect(invalidate.mock.calls).toEqual([[U]]);
        // chamada depois de a conta estar gravada como inativa
        expect(inactiveWhenInvalidated).toEqual([true]);
        invalidate.mockRestore();
      }

      const admin = setup({ seed: (seed) => (seed.user[0].role = 'ADMIN') });
      const invalidate = jest
        .spyOn(activeUserCache, 'invalidate')
        .mockImplementation(() => undefined);
      await expect(admin.service.erase(U, CONFIRM)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(invalidate).not.toHaveBeenCalled();
    });
  });

  describe('HeyGen', () => {
    it('falha na HeyGen: o grupo fica gravado, vai para failedIds e nextSteps; a 2ª rodada tenta de novo e só então solta', async () => {
      const ctx = setup();
      ctx.heygen.deleteAvatarGroupStrict.mockRejectedValueOnce(
        new Error('HeyGen recusou apagar o avatar hg-group-1: HTTP 500'),
      );

      const first = await ctx.service.erase(U, CONFIRM);
      expect(first.providers.heygenAvatarGroups).toEqual({
        requested: 0,
        failed: 1,
        failedIds: ['hg-group-1'],
      });
      expect(first.nextSteps).toContainEqual(
        expect.stringContaining('grupos hg-group-1'),
      );
      // o resto do avatar sai; o vínculo com a HeyGen fica até ela confirmar
      expect(rowById(ctx.tables.userAvatar, A1)).toMatchObject({
        name: ERASED_AVATAR_NAME,
        heygenGroupId: 'hg-group-1',
        heygenLookId: 'hg-look-1',
        previewImageUrl: null,
        defaultVoiceId: null,
        isDeleted: true,
      });

      const second = await ctx.service.erase(U, CONFIRM);
      expect(ctx.heygen.deleteAvatarGroupStrict).toHaveBeenCalledTimes(2);
      expect(ctx.heygen.deleteAvatarGroupStrict).toHaveBeenLastCalledWith(
        'hg-group-1',
      );
      expect(second.providers.heygenAvatarGroups).toEqual({
        requested: 1,
        failed: 0,
        failedIds: [],
      });
      expect(second.scrubbed.userAvatars).toBe(0);
      expect(rowById(ctx.tables.userAvatar, A1)).toMatchObject({
        heygenGroupId: null,
        heygenLookId: null,
      });

      const third = await ctx.service.erase(U, CONFIRM);
      expect(ctx.heygen.deleteAvatarGroupStrict).toHaveBeenCalledTimes(2);
      expect(third.providers.heygenAvatarGroups.requested).toBe(0);
    });

    it('avatar que já não existe na HeyGen (404) conta como apagado e o vínculo sai', async () => {
      const ctx = setup();
      ctx.heygen.deleteAvatarGroupStrict.mockResolvedValueOnce('not_found');
      const report = await ctx.service.erase(U, CONFIRM);
      expect(report.providers.heygenAvatarGroups).toEqual({
        requested: 1,
        failed: 0,
        failedIds: [],
      });
      expect(rowById(ctx.tables.userAvatar, A1)).toMatchObject({
        heygenGroupId: null,
      });
    });
  });

  describe('arquivos', () => {
    it('pasta que falha no bucket não para as outras, guarda a pista e a 2ª rodada tenta de novo e só então apaga a linha', async () => {
      const ctx = setup();
      const failing = new Set([
        `voices/${U}/`,
        `workspaces/${W1}/`,
        `avatar_source/${SOURCE_UUID}/`,
        `avatar_audio/${AUDIO_UUID}/`,
        `generations/${G1}/`,
        `video-editor/${RENDER_UUID}/`,
      ]);
      const deleteFromBucket = async (prefix: string): Promise<number> => {
        const count = ctx.bucket.get(prefix) ?? 0;
        ctx.bucket.set(prefix, 0);
        return count;
      };
      ctx.uploads.deleteByPrefixStrict.mockImplementation(
        async (prefix: string) => {
          if (failing.has(prefix)) throw new Error('S3 503');
          return deleteFromBucket(prefix);
        },
      );

      const first = await ctx.service.erase(U, CONFIRM);

      expect(first).toMatchObject({ filesDeleted: 4, filesFailed: 6 });
      expect([...first.failedPrefixes].sort()).toEqual([...failing].sort());
      expect(first.storage).toMatchObject({
        completed: true,
        prefixesDone: ALL_PREFIXES.length,
      });
      expect(first.nextSteps).toContainEqual(
        expect.stringContaining('failedPrefixes'),
      );
      // as linhas que são a única pista das pastas ficam, sem conteúdo
      expect(rowById(ctx.tables.workspace, W1)).toMatchObject({
        name: ERASED_WORKSPACE_NAME,
        nodes: [],
        edges: [],
      });
      expect(rowById(ctx.tables.videoProject, VP1)).toMatchObject({
        name: ERASED_VIDEO_PROJECT_NAME,
        outputUrl: expect.stringContaining(RENDER_UUID),
      });
      expect(ctx.tables.videoProjectClip).toEqual([]);
      expect(rowById(ctx.tables.voiceProfile, V1)).toMatchObject({
        name: ERASED_VOICE_NAME,
        sampleUrl: '',
        isDeleted: true,
      });
      expect(rowById(ctx.tables.userAvatar, A1)).toMatchObject({
        sourceVideoKey: `avatar_source/${SOURCE_UUID}/selfie.mp4`,
        sourceVideoUrl: '',
      });
      expect(rowById(ctx.tables.generation, G1)!.parameters).toEqual({
        audioDurationSeconds: 12,
        customAudioKey: `avatar_audio/${AUDIO_UUID}/minha-voz.mp3`,
        fallbackFrom: 'veo3-fast',
        provider: 'kie',
        unlimited: true,
      });
      expect(
        ctx.tables.generationOutput.filter((row) => row.generationId === G1),
      ).toHaveLength(2);
      // G3: as pastas saíram, então a imagem de entrada também
      expect(ctx.tables.generationInputImage).toEqual([]);
      expect(first.deleted).toMatchObject({
        workspaces: 0,
        videoProjects: 0,
        voiceProfiles: 0,
        generationOutputs: 0,
        generationInputImages: 1,
      });

      // 2ª rodada com o bucket de volta: tenta as mesmas pastas e só então apaga as linhas
      ctx.uploads.deleteByPrefixStrict.mockClear();
      ctx.uploads.deleteByPrefixStrict.mockImplementation(deleteFromBucket);
      const second = await ctx.service.erase(U, CONFIRM);
      const retried = ctx.uploads.deleteByPrefixStrict.mock.calls.map(
        ([prefix]) => prefix,
      );
      for (const prefix of failing) expect(retried).toContain(prefix);
      expect(second).toMatchObject({
        filesDeleted: 8,
        filesFailed: 0,
        failedPrefixes: [],
      });
      expect(second.deleted).toMatchObject({
        workspaces: 1,
        videoProjects: 1,
        voiceProfiles: 1,
        generationOutputs: 2,
      });
      expect(ctx.tables.workspace).toEqual([]);
      expect(ctx.tables.videoProject).toEqual([]);
      expect(ctx.tables.voiceProfile).toEqual([]);
      expect(rowById(ctx.tables.userAvatar, A1)).toMatchObject({
        sourceVideoKey: '',
      });
      expect(rowById(ctx.tables.generation, G1)!.parameters).toEqual({
        audioDurationSeconds: 12,
        fallbackFrom: 'veo3-fast',
        provider: 'kie',
        unlimited: true,
      });
      expect(ctx.tables.generationOutput.map((row) => row.id)).toEqual([
        'out-o',
      ]);

      // 3ª rodada: nada pendente
      const third = await ctx.service.erase(U, CONFIRM);
      expect(third).toMatchObject({
        filesDeleted: 0,
        filesFailed: 0,
        generationsScrubbed: 0,
      });
      expect(Object.values(third.deleted).every((count) => count === 0)).toBe(
        true,
      );
    });

    it('limpeza final do banco falhando: os arquivos saem, as pistas ficam e o relatório pede outra rodada', async () => {
      const ctx = setup();
      const realTransaction = ctx.prisma.$transaction as (
        callback: (tx: unknown) => Promise<unknown>,
      ) => Promise<unknown>;
      let calls = 0;
      const prismaWithFailingFinalize = new Proxy(ctx.prisma, {
        get(target, prop, receiver) {
          if (prop !== '$transaction')
            return Reflect.get(target, prop, receiver);
          return async (callback: (tx: unknown) => Promise<unknown>) => {
            calls++;
            if (calls === 2) throw new Error('conexão caiu');
            return realTransaction(callback);
          };
        },
      });
      const service = new AccountErasureService(
        prismaWithFailingFinalize as never,
        ctx.uploads as never,
        ctx.stripe as never,
        ctx.cakto as never,
        ctx.asaas as never,
        ctx.heygen as never,
        {
          get: (key: string) =>
            ({ S3_ENDPOINT: 'https://s3.example', S3_PUBLIC_URL: PUBLIC })[key],
        } as never,
      );

      const report = await service.erase(U, CONFIRM);
      expect(report.filesDeleted).toBe(12);
      // o bucket terminou, mas a 2ª etapa não: o relatório não pode parecer sucesso
      expect(report.storage).toMatchObject({
        completed: true,
        finalized: false,
        finalizeError: 'conexão caiu',
      });
      expect(report.nextSteps).toContainEqual(
        expect.stringContaining('limpeza final do banco'),
      );
      expect(rowById(ctx.tables.workspace, W1)).toMatchObject({
        name: ERASED_WORKSPACE_NAME,
      });
      expect(report.deleted.workspaces).toBe(0);

      const again = await service.erase(U, CONFIRM);
      expect(again.deleted.workspaces).toBe(1);
      expect(again.storage).toMatchObject({ finalized: true });
      expect(again.storage.finalizeError).toBeUndefined();
      expect(ctx.tables.workspace).toEqual([]);
    });

    it('limpeza longa: responde no teto de tempo, continua em segundo plano e segura a conta até terminar', async () => {
      const ctx = setup({ env: { ACCOUNT_ERASURE_SYNC_BUDGET_MS: '30' } });
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      ctx.uploads.deleteByPrefixStrict.mockImplementation(
        async (prefix: string) => {
          if (prefix === `voices/${U}/`) await gate;
          return 1;
        },
      );

      const report = await ctx.service.erase(U, CONFIRM);
      expect(report.storage.completed).toBe(false);
      expect(report.storage.finalized).toBe(false);
      expect(report.storage.prefixesDone).toBe(ALL_PREFIXES.length - 1);
      expect(report.nextSteps).toContainEqual(
        expect.stringContaining('segundo plano'),
      );
      await expect(ctx.service.erase(U, CONFIRM)).rejects.toBeInstanceOf(
        ConflictException,
      );

      release();
      await ctx.service.drainBackground();
      await expect(ctx.service.erase(U, CONFIRM)).resolves.toMatchObject({
        storage: { completed: true, finalized: true },
      });
    });

    it('bucket que recusa um objeto (Errors[] do DeleteObjects): a pasta falha, conta só o que saiu e a 2ª rodada termina', async () => {
      const ctx = setup();
      const partial = `generations/${G1}/`;
      const deleteFromBucket = async (prefix: string): Promise<number> => {
        const count = ctx.bucket.get(prefix) ?? 0;
        ctx.bucket.set(prefix, 0);
        return count;
      };
      ctx.uploads.deleteByPrefixStrict.mockImplementation(
        async (prefix: string) => {
          if (prefix !== partial) return deleteFromBucket(prefix);
          // 2 objetos na pasta: 1 sai, o outro o bucket recusa
          ctx.bucket.set(prefix, 1);
          throw new StorageDeleteError(
            `O bucket recusou 1 objeto(s) da pasta "${prefix}"`,
            prefix,
            1,
            [`${prefix}u/output_0.mp4`],
          );
        },
      );

      const first = await ctx.service.erase(U, CONFIRM);
      expect(first).toMatchObject({
        filesDeleted: 11,
        filesFailed: 1,
        failedPrefixes: [partial],
      });
      // a 2ª etapa rodou para o resto; a geração com a pasta pendente guarda as saídas (a pista)
      expect(first.storage).toMatchObject({ completed: true, finalized: true });
      expect(
        ctx.tables.generationOutput.filter((row) => row.generationId === G1),
      ).toHaveLength(2);
      expect(ctx.tables.workspace).toEqual([]);
      expect(first.nextSteps).toContainEqual(
        expect.stringContaining('failedPrefixes'),
      );

      ctx.uploads.deleteByPrefixStrict.mockImplementation(deleteFromBucket);
      const second = await ctx.service.erase(U, CONFIRM);
      expect(second).toMatchObject({
        filesDeleted: 1,
        filesFailed: 0,
        failedPrefixes: [],
      });
      expect(second.deleted.generationOutputs).toBe(2);
      expect(ctx.tables.generationOutput.map((row) => row.id)).toEqual([
        'out-o',
      ]);
    });

    it('sem S3 configurado: não chama o bucket, não diz que terminou e avisa que os arquivos não foram tocados', async () => {
      const ctx = setup({ env: { S3_ENDPOINT: undefined } });
      const report = await ctx.service.erase(U, CONFIRM);
      expect(ctx.uploads.deleteByPrefixStrict).not.toHaveBeenCalled();
      expect(report.storage).toEqual({
        configured: false,
        completed: false,
        prefixesTotal: 0,
        prefixesDone: 0,
        finalized: false,
      });
      expect(report.nextSteps).toContainEqual(
        expect.stringContaining('S3_ENDPOINT'),
      );
      expect(report.nextSteps).toContainEqual(
        expect.stringContaining('NÃO foram tocados'),
      );
      expect(ctx.heygen.deleteAvatarGroupStrict).toHaveBeenCalledWith(
        'hg-group-1',
      );
      // sem bucket, as linhas que apontam para as pastas ficam (sem conteúdo) para a próxima rodada
      expect(rowById(ctx.tables.workspace, W1)).toMatchObject({
        name: ERASED_WORKSPACE_NAME,
      });
      expect(report.deleted.workspaces).toBe(0);
    });
  });
});

describe('funções da exclusão', () => {
  const storage = { publicUrlBase: PUBLIC, bucket: 'ai-generations' };

  it('sanitizeGenerationParameters: fica só o técnico', () => {
    expect(
      sanitizeGenerationParameters({
        unlimited: true,
        seed: 42,
        provider: 'kie',
        mimeType: 'image/png',
        script: 'texto livre da pessoa',
        engine: 'avatar iv',
        model: 'https://evil.example/model',
        backgroundImageUrl: 'https://x/y.png',
        nested: { a: 1 },
        list: [1],
        infinite: Infinity,
      }),
    ).toEqual({
      mimeType: 'image/png',
      provider: 'kie',
      seed: 42,
      unlimited: true,
    });
    expect(sanitizeGenerationParameters({})).toBeNull();
    expect(sanitizeGenerationParameters({ script: 'só texto' })).toBeNull();
    expect(sanitizeGenerationParameters(null)).toBeNull();
    expect(sanitizeGenerationParameters('texto')).toBeNull();
    expect(sanitizeGenerationParameters([1, 2])).toBeNull();
  });

  it('generationStoragePrefixes: 5 pastas por geração; id estranho não vira pasta', () => {
    expect(generationStoragePrefixes(G1)).toEqual([
      `generations/${G1}/`,
      `outputs/${G1}/`,
      `thumbnails/${G1}/`,
      `inputs/${G1}/`,
      `samples/${G1}/`,
    ]);
    expect(generationStoragePrefixes('')).toEqual([]);
    expect(generationStoragePrefixes('../../etc')).toEqual([]);
    expect(generationStoragePrefixes('a/b')).toEqual([]);
  });

  it('uploadFolderFromKey: só a pasta do upload, do propósito certo', () => {
    expect(
      uploadFolderFromKey(
        `avatar_source/${SOURCE_UUID}/selfie.mp4`,
        'avatar_source',
      ),
    ).toBe(`avatar_source/${SOURCE_UUID}/`);
    expect(
      uploadFolderFromKey(
        `avatar_source/${SOURCE_UUID}/selfie.mp4`,
        'avatar_audio',
      ),
    ).toBeNull();
    expect(
      uploadFolderFromKey(`avatar_source/${SOURCE_UUID}/`, 'avatar_source'),
    ).toBeNull();
    expect(
      uploadFolderFromKey(
        'avatar_source/../generations/x.mp4',
        'avatar_source',
      ),
    ).toBeNull();
    expect(
      uploadFolderFromKey('avatar_source/nao-e-uuid/x.mp4', 'avatar_source'),
    ).toBeNull();
    expect(uploadFolderFromKey(undefined, 'avatar_source')).toBeNull();
    expect(uploadFolderFromKey(42, 'avatar_audio')).toBeNull();
  });

  it('storageKeyFromUrl e videoRenderFolder: URL pública ou /<bucket>/<chave>; só o render do próprio projeto', () => {
    const key = `video-editor/${RENDER_UUID}/render-${VP1}.mp4`;
    expect(storageKeyFromUrl(`${PUBLIC}/${key}?v=1`, storage)).toBe(key);
    expect(
      storageKeyFromUrl(
        `https://abc.supabase.co/storage/v1/s3/ai-generations/${key}?X-Amz-Signature=x`,
        storage,
      ),
    ).toBe(key);
    expect(
      storageKeyFromUrl('https://outro-cdn.example/arquivo.mp4', storage),
    ).toBeNull();
    expect(storageKeyFromUrl('não é url', storage)).toBeNull();
    expect(storageKeyFromUrl(null, storage)).toBeNull();
    expect(videoRenderFolder(VP1, `${PUBLIC}/${key}`, storage)).toBe(
      `video-editor/${RENDER_UUID}/`,
    );
    expect(
      videoRenderFolder(cid('outroprojeto'), `${PUBLIC}/${key}`, storage),
    ).toBeNull();
    expect(
      videoRenderFolder(
        VP1,
        `${PUBLIC}/video-editor/nao-uuid/render-${VP1}.mp4`,
        storage,
      ),
    ).toBeNull();
    expect(videoRenderFolder(VP1, null, storage)).toBeNull();
  });

  it('mentionsEmail: e-mail inteiro, sem pegar pedaço de outro e-mail', () => {
    expect(
      mentionsEmail('Conta Maria@Exemplo.com, por favor', 'maria@exemplo.com'),
    ).toBe(true);
    expect(mentionsEmail('fim: maria@exemplo.com.', 'maria@exemplo.com')).toBe(
      true,
    );
    expect(mentionsEmail('ana.maria@exemplo.com', 'maria@exemplo.com')).toBe(
      false,
    );
    expect(mentionsEmail('maria@exemplo.com.br', 'maria@exemplo.com')).toBe(
      false,
    );
    expect(mentionsEmail('maria@exemplo.company', 'maria@exemplo.com')).toBe(
      false,
    );
    expect(mentionsEmail('x', null)).toBe(false);
  });

  it('computeLegalHold: post citado leva a geração, o avatar e a voz; 3 bloqueios seguram, salvo override', () => {
    const account = {
      userId: U,
      email: 'maria@exemplo.com',
      generations: [
        { id: G1, userAvatarId: A1, voiceProfileId: V1 },
        { id: G2, userAvatarId: null, voiceProfileId: null },
      ],
      posts: [{ id: P1, generationId: G1 }],
      avatarIds: [A1],
      voiceProfileIds: [V1],
    };
    const report = {
      id: 'r1',
      category: 'MINOR' as const,
      status: 'OPEN' as const,
      target: P1.toUpperCase(),
      description: 'Denúncia.',
    };
    expect(
      computeLegalHold({
        reports: [report],
        account,
        minorBlockedEvents: 0,
        ignoreSafetyEvents: false,
      }),
    ).toMatchObject({
      active: true,
      kinds: ['report'],
      reportIds: ['r1'],
      generationIds: [G1],
      communityPostIds: [P1],
      avatarIds: [A1],
      voiceProfileIds: [V1],
    });
    expect(
      computeLegalHold({
        reports: [],
        account,
        minorBlockedEvents: 3,
        ignoreSafetyEvents: false,
      }),
    ).toMatchObject({ active: true, kinds: ['safety_events'] });
    expect(
      computeLegalHold({
        reports: [],
        account,
        minorBlockedEvents: 3,
        ignoreSafetyEvents: true,
      }),
    ).toMatchObject({
      active: false,
      kinds: [],
      reasons: [],
      minorBlockedEvents: 3,
    });
    expect(
      computeLegalHold({
        reports: [{ ...report, target: GO }],
        account,
        minorBlockedEvents: 2,
        ignoreSafetyEvents: false,
      }).active,
    ).toBe(false);
  });

  it('countMinorAttempts: mesmo trecho em até 10 min e sem trecho em até 2 min são uma tentativa (regra do cockpit)', () => {
    const minute = 60_000;
    const t0 = Date.parse('2026-10-16T12:00:00.000Z');
    const at = (minutes: number) => t0 + minutes * minute;
    // 4 gerações em paralelo do mesmo clique
    expect(
      countMinorAttempts(
        [0, 0, 0, 0].map((m) => ({ at: at(m), excerpt: 'menina de 15' })),
      ),
    ).toBe(1);
    // o mesmo texto reenviado em até 10 min (contados do 1º bloqueio), com espaço e maiúscula diferentes
    expect(
      countMinorAttempts([
        { at: at(0), excerpt: 'menina de 15' },
        { at: at(9), excerpt: '  Menina   DE 15 ' },
      ]),
    ).toBe(1);
    expect(
      countMinorAttempts([
        { at: at(0), excerpt: 'menina de 15' },
        { at: at(11), excerpt: 'menina de 15' },
      ]),
    ).toBe(2);
    // texto diferente segundos depois é outra tentativa (reescrever o pedido é tentar de novo)
    expect(
      countMinorAttempts([
        { at: at(0), excerpt: '15 anos' },
        { at: at(0.1), excerpt: 'quinze anos' },
      ]),
    ).toBe(2);
    // sem trecho: só junta em até 2 min
    expect(
      countMinorAttempts([
        { at: at(0), excerpt: null },
        { at: at(1.5), excerpt: undefined },
        { at: at(2), excerpt: '' },
      ]),
    ).toBe(1);
    expect(
      countMinorAttempts([
        { at: at(0), excerpt: null },
        { at: at(3), excerpt: null },
      ]),
    ).toBe(2);
    // com trecho logo depois de um sem trecho (o mesmo clique) entra na tentativa aberta
    expect(
      countMinorAttempts([
        { at: at(0), excerpt: null },
        { at: at(1), excerpt: 'menina de 15' },
        { at: at(1.5), excerpt: 'menina de 15' },
      ]),
    ).toBe(1);
    // fora de ordem e data inválida
    expect(
      countMinorAttempts([
        { at: at(30), excerpt: 'b' },
        { at: Number.NaN, excerpt: 'x' },
        { at: at(0), excerpt: 'a' },
      ]),
    ).toBe(2);
    expect(countMinorAttempts([])).toBe(0);
  });

  it('parametersShowUserMedia: só flag ou chave de mídia de entrada com valor', () => {
    expect(
      parametersShowUserMedia({ provider: 'kie', hasVideoInput: true }),
    ).toBe(true);
    expect(parametersShowUserMedia({ imageUrls: ['https://cdn/x.png'] })).toBe(
      true,
    );
    expect(
      parametersShowUserMedia({ sourceImageUrl: 'inputs/abc/x.png' }),
    ).toBe(true);
    for (const value of [
      null,
      undefined,
      'texto',
      [],
      {},
      { hasVideoInput: false },
      { hasVideoInput: 'true' },
      { imageUrls: [] },
      { imageUrls: ['  '] },
      { prompt: 'menina com foto', originalPrompt: 'foto' },
      { sampleUrl: 'https://cdn/voz.mp3' },
    ]) {
      expect([value, parametersShowUserMedia(value)]).toEqual([value, false]);
    }
  });

  it('tallyMinorBlocks: provedor com mídia vira provider (qualquer data); o resto conta como texto, 90 dias, por tentativa', () => {
    const now = new Date('2026-10-16T12:00:00.000Z');
    const daysAgo = (days: number) =>
      new Date(now.getTime() - days * 86_400_000);
    const tally = tallyMinorBlocks(
      [
        // com mídia, antiga: provider
        {
          route: 'provider:veo3',
          excerpt: 'x',
          createdAt: daysAgo(400),
          generationId: 'g-media',
        },
        // sem mídia, recente: texto
        {
          route: 'provider:nano',
          excerpt: 'pedido a',
          createdAt: daysAgo(1),
          generationId: 'g-texto',
        },
        // sem geração para conferir: texto
        {
          route: 'provider:nano',
          excerpt: 'pedido b',
          createdAt: daysAgo(2),
          generationId: null,
        },
        // filtro de texto, mesmo clique do anterior não (dias de distância): outra tentativa
        {
          route: '/api/v1/generations/image',
          excerpt: 'pedido c',
          createdAt: daysAgo(3),
          generationId: null,
        },
        // provedor sem mídia, antigo: fora da janela
        {
          route: 'provider:nano',
          excerpt: 'pedido d',
          createdAt: daysAgo(100),
          generationId: 'g-velha',
        },
        // filtro de texto antigo: fora da janela
        {
          route: '/api/v1/generations/image',
          excerpt: 'pedido e',
          createdAt: daysAgo(91),
          generationId: null,
        },
      ],
      new Set(['g-media']),
      now,
    );
    expect(tally).toEqual({ recent: 3, recentAttempts: 3, provider: 1, reviewConfirmed: 0 });
  });

  it('computeLegalHold: o limite é de tentativas distintas; o motivo só fala em foto quando havia mídia', () => {
    const account = {
      userId: U,
      email: 'maria@exemplo.com',
      generations: [],
      posts: [],
      avatarIds: [],
      voiceProfileIds: [],
    };
    const repeated = computeLegalHold({
      reports: [],
      account,
      minorBlockedEvents: 8,
      minorBlockedAttempts: 2,
      ignoreSafetyEvents: false,
    });
    expect(repeated).toMatchObject({
      active: false,
      minorBlockedEvents: 8,
      minorBlockedAttempts: 2,
    });

    const textOnly = computeLegalHold({
      reports: [],
      account,
      minorBlockedEvents: 5,
      minorBlockedAttempts: 3,
      ignoreSafetyEvents: false,
    });
    expect(textOnly).toMatchObject({ active: true, kinds: ['safety_events'] });
    expect(textOnly.reasons).toEqual([
      expect.stringContaining(
        '5 pedidos desta conta foram bloqueados em 3 tentativas distintas',
      ),
    ]);
    expect(textOnly.reasons[0]).not.toMatch(/foto|imagem|vídeo/i);

    const withMedia = computeLegalHold({
      reports: [],
      account,
      minorBlockedEvents: 0,
      providerMinorBlockedEvents: 1,
      ignoreSafetyEvents: false,
    });
    expect(withMedia.reasons).toEqual([
      expect.stringContaining('com foto ou vídeo enviado pela conta'),
    ]);
    // sem o número de tentativas (chamada antiga), cada bloqueio vale uma; tentativas nunca passam dos bloqueios
    expect(
      computeLegalHold({
        reports: [],
        account,
        minorBlockedEvents: 3,
        ignoreSafetyEvents: false,
      }).minorBlockedAttempts,
    ).toBe(3);
    expect(
      computeLegalHold({
        reports: [],
        account,
        minorBlockedEvents: 2,
        minorBlockedAttempts: 9,
        ignoreSafetyEvents: false,
      }),
    ).toMatchObject({ active: false, minorBlockedAttempts: 2 });
  });

  it('reportFiledByAccount: conta logada ou o e-mail dela (sem diferença de maiúsculas e espaços)', () => {
    const account = { userId: U, email: 'Maria@Exemplo.com' };
    expect(reportFiledByAccount({ reporterUserId: U }, account)).toBe(true);
    expect(
      reportFiledByAccount({ reporterEmail: ' maria@exemplo.COM ' }, account),
    ).toBe(true);
    expect(
      reportFiledByAccount(
        { reporterUserId: O, reporterEmail: 'outra@exemplo.com' },
        account,
      ),
    ).toBe(false);
    expect(reportFiledByAccount({ reporterEmail: '' }, account)).toBe(false);
    expect(reportFiledByAccount({}, account)).toBe(false);
    // conta já anonimizada (sem e-mail): só a conta logada conta
    expect(
      reportFiledByAccount(
        { reporterEmail: 'maria@exemplo.com' },
        { userId: U, email: null },
      ),
    ).toBe(false);
    // e-mail parecido não é o mesmo
    expect(
      reportFiledByAccount({ reporterEmail: 'maria@exemplo.com.br' }, account),
    ).toBe(false);
  });

  it('computeLegalHold: denúncia da própria conta só não segura quando cita apenas o perfil ou o e-mail dela', () => {
    const account = {
      userId: U,
      email: 'maria@exemplo.com',
      generations: [{ id: G1, userAvatarId: A1, voiceProfileId: null }],
      posts: [{ id: P1, generationId: G1 }],
      avatarIds: [A1],
      voiceProfileIds: [V1],
    };
    const identityOnly = {
      id: 'r1',
      category: 'MINOR' as const,
      status: 'OPEN' as const,
      target: `https://www.theaimodelab.com/community/users/${U}`,
      description: 'Meu contato: maria@exemplo.com',
    };
    const hold = (extra: Record<string, unknown>) =>
      computeLegalHold({
        reports: [{ ...identityOnly, ...extra }],
        account,
        minorBlockedEvents: 0,
        ignoreSafetyEvents: false,
      });
    // só perfil e e-mail: a vítima pedindo ajuda não trava a exclusão
    expect(hold({ reporterUserId: U }).active).toBe(false);
    expect(hold({ reporterEmail: 'MARIA@exemplo.com' }).active).toBe(false);
    // a mesma denúncia vinda de outra pessoa segura
    expect(hold({ reporterUserId: O }).active).toBe(true);
    expect(hold({}).communityPostsUnpublished).toBe(0);

    // citando conteúdo da própria conta (geração, post, avatar ou voz), segura mesmo vindo dela
    for (const target of [G1, P1, A1, V1]) {
      const held = hold({ reporterUserId: U, target });
      expect([target, held.active, held.kinds]).toEqual([
        target,
        true,
        ['report'],
      ]);
      expect(held.reasons[0]).toContain('feita pela própria conta');
    }
    expect(
      hold({ reporterEmail: 'maria@exemplo.com', target: G1 }).generationIds,
    ).toEqual([G1]);
  });

  it('computeLegalHold: recusa do provedor por menor na imagem segura com 1, sem override', () => {
    const account = {
      userId: U,
      email: 'maria@exemplo.com',
      generations: [],
      posts: [],
      avatarIds: [],
      voiceProfileIds: [],
    };
    for (const ignoreSafetyEvents of [false, true]) {
      const hold = computeLegalHold({
        reports: [],
        account,
        minorBlockedEvents: 1,
        providerMinorBlockedEvents: 1,
        ignoreSafetyEvents,
      });
      expect(hold).toMatchObject({
        active: true,
        kinds: ['provider_minor'],
        providerMinorBlockedEvents: 1,
      });
      expect(hold.reasons).toEqual([
        expect.stringContaining('recusado pelo provedor de IA'),
      ]);
    }
    // 3 bloqueios de texto + 1 do provedor: com override, só o do provedor segura
    expect(
      computeLegalHold({
        reports: [],
        account,
        minorBlockedEvents: 3,
        providerMinorBlockedEvents: 1,
        ignoreSafetyEvents: true,
      }).kinds,
    ).toEqual(['provider_minor']);
    expect(
      computeLegalHold({
        reports: [],
        account,
        minorBlockedEvents: 3,
        providerMinorBlockedEvents: 2,
        ignoreSafetyEvents: false,
      }).kinds,
    ).toEqual(['provider_minor', 'safety_events']);
    expect(
      computeLegalHold({
        reports: [],
        account,
        minorBlockedEvents: 0,
        ignoreSafetyEvents: false,
      }),
    ).toMatchObject({ active: false, providerMinorBlockedEvents: 0 });
  });

  it('legalHoldDeletionConflict: 409 ACCOUNT_LEGAL_HOLD em português, apontando para "Excluir dados (LGPD)"', () => {
    const conflict = legalHoldDeletionConflict({
      ...computeLegalHold({
        reports: [],
        account: {
          userId: U,
          email: null,
          generations: [],
          posts: [],
          avatarIds: [],
          voiceProfileIds: [],
        },
        minorBlockedEvents: 0,
        providerMinorBlockedEvents: 1,
        ignoreSafetyEvents: false,
      }),
    });
    expect(conflict.getStatus()).toBe(409);
    expect(conflict.getResponse()).toMatchObject({
      code: ACCOUNT_LEGAL_HOLD_CODE,
      message: expect.stringContaining('Excluir dados (LGPD)'),
      reasons: [expect.stringContaining('provedor de IA')],
    });
    expect((conflict.getResponse() as { message: string }).message).toContain(
      'guarda legal',
    );
  });

  it('reportCaseOpen: só descartada ou confirmada com a evidência liberada fecham o caso', () => {
    const released = new Date('2026-10-16T10:00:00.000Z');
    expect(reportCaseOpen({ status: 'OPEN' })).toBe(true);
    expect(
      reportCaseOpen({ status: 'IN_REVIEW', evidenceReleasedAt: released }),
    ).toBe(true);
    expect(
      reportCaseOpen({ status: 'ACTIONED', evidenceReleasedAt: null }),
    ).toBe(true);
    expect(
      reportCaseOpen({ status: 'ACTIONED', evidenceReleasedAt: released }),
    ).toBe(false);
    expect(reportCaseOpen({ status: 'DISMISSED' })).toBe(false);
  });

  it('generationsCitedByReports: geração, post, avatar ou voz citados; perfil ou e-mail levam todas as da dona', () => {
    const OTHER_GEN = cid('genoutra');
    const candidates = [
      {
        id: G1,
        userId: U,
        email: 'maria@exemplo.com',
        userAvatarId: A1,
        voiceProfileId: null,
      },
      {
        id: G2,
        userId: U,
        email: 'maria@exemplo.com',
        userAvatarId: null,
        voiceProfileId: V1,
      },
      {
        id: G3,
        userId: U,
        email: 'maria@exemplo.com',
        userAvatarId: null,
        voiceProfileId: null,
      },
      {
        id: OTHER_GEN,
        userId: O,
        email: 'outra@exemplo.com',
        userAvatarId: null,
        voiceProfileId: null,
      },
    ];
    const posts = [{ id: P1, generationId: G3 }];
    const cited = (target: string) =>
      [
        ...generationsCitedByReports(
          [{ target, description: 'x' }],
          candidates,
          posts,
        ),
      ].sort();

    expect(cited(G1)).toEqual([G1]);
    expect(cited(P1)).toEqual([G3]);
    expect(cited(A1)).toEqual([G1]);
    expect(cited(V1)).toEqual([G2]);
    expect(cited(`https://www.theaimodelab.com/community/users/${U}`)).toEqual(
      [G1, G2, G3].sort(),
    );
    expect(cited('Conta da MARIA@exemplo.com')).toEqual([G1, G2, G3].sort());
    expect(cited(OTHER_GEN)).toEqual([OTHER_GEN]);
    expect(cited('https://x.com/nada')).toEqual([]);
    expect(generationsCitedByReports([], candidates, posts).size).toBe(0);
  });

  it('citedIds: acha ids em link e texto; não pega pedaço de palavra maior', () => {
    expect(
      citedIds(`veja https://site.com/p/${P1}?x=1 e a geração ${G1}.`),
    ).toEqual([P1, G1]);
    expect(citedIds(`x${G1}`)).toEqual([]);
    expect(citedIds(null)).toEqual([]);
  });

  it('reportHoldsEvidence: menor, crime e imagem íntima seguram (confirmada também); descartada e direito autoral não', () => {
    const base = {
      id: 'r',
      target: 'https://site.com/x',
      description: 'Conteúdo denunciado pela equipe.',
    };
    expect(
      reportHoldsEvidence({ ...base, category: 'MINOR', status: 'OPEN' }),
    ).toBe(true);
    expect(
      reportHoldsEvidence({ ...base, category: 'ILLEGAL', status: 'ACTIONED' }),
    ).toBe(true);
    expect(
      reportHoldsEvidence({ ...base, category: 'MINOR', status: 'DISMISSED' }),
    ).toBe(false);
    expect(
      reportHoldsEvidence({
        ...base,
        category: 'NON_CONSENSUAL',
        status: 'OPEN',
      }),
    ).toBe(true);
    expect(
      reportHoldsEvidence({ ...base, category: 'MINOR', status: 'ACTIONED' }),
    ).toBe(true);
    // uso de imagem só segura quando quem denuncia é a pessoa retratada
    expect(
      reportHoldsEvidence({
        ...base,
        category: 'IMPERSONATION',
        status: 'OPEN',
        isDepictedPerson: true,
      }),
    ).toBe(true);
    expect(
      reportHoldsEvidence({
        ...base,
        category: 'IMPERSONATION',
        status: 'OPEN',
        isDepictedPerson: false,
      }),
    ).toBe(false);
    expect(
      reportHoldsEvidence({ ...base, category: 'COPYRIGHT', status: 'OPEN' }),
    ).toBe(false);
    // marcada urgente pela API (texto que cita menor), qualquer categoria
    expect(
      reportHoldsEvidence({
        ...base,
        category: 'COPYRIGHT',
        status: 'OPEN',
        urgent: true,
      }),
    ).toBe(true);
    expect(
      reportHoldsEvidence({
        ...base,
        category: 'NON_CONSENSUAL',
        status: 'DISMISSED',
        urgent: true,
      }),
    ).toBe(false);
    expect(
      reportHoldsEvidence({
        ...base,
        category: 'OTHER',
        status: 'IN_REVIEW',
        description: 'Mostra uma garota de 15 anos.',
      }),
    ).toBe(true);
    // evidência liberada: só a confirmada (caso encerrado) deixa de segurar
    const released = new Date('2026-10-16T10:00:00.000Z');
    expect(
      reportHoldsEvidence({
        ...base,
        category: 'MINOR',
        status: 'ACTIONED',
        urgent: true,
        evidenceReleasedAt: released,
      }),
    ).toBe(false);
    expect(
      reportHoldsEvidence({
        ...base,
        category: 'MINOR',
        status: 'ACTIONED',
        evidenceReleasedAt: '2026-10-16T10:00:00.000Z',
      }),
    ).toBe(false);
    expect(
      reportHoldsEvidence({
        ...base,
        category: 'MINOR',
        status: 'ACTIONED',
        evidenceReleasedAt: null,
      }),
    ).toBe(true);
    for (const status of ['OPEN', 'IN_REVIEW'] as const) {
      expect(
        reportHoldsEvidence({
          ...base,
          category: 'MINOR',
          status,
          evidenceReleasedAt: released,
        }),
      ).toBe(true);
    }
  });
});
