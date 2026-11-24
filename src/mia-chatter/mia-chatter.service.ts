import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type MiaChatterAccount, type MiaChatterFan } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { mailLocaleFor, type MailLocale } from '../email/brand-email';
import {
  buildSystemPrompt,
  buildUserPrompt,
  classifyFanMessage,
  decideReply,
  detectLocale,
  fallbackReply,
  lastTopicFrom,
  sanitizeReply,
  TIER_PRICE_USD,
  type ChatterLocale,
  type ChatterStep,
  type Decision,
} from './chatter-script';
import { costFromTokens, costMonthOf, fitsCap, OpenRouterChatterClient, spentThisMonth, worstCaseCallUsd, type ChatterTextClient } from './chatter-llm';
import { buildAuthorizeUrl, FanvueApiError, FanvueClient, type FanvueChat, type FetchLike } from './fanvue.client';
import { missingForConnect, readMiaChatterConfig, type MiaChatterConfig } from './mia-chatter.config';
import { EMPTY_STATS, mergeSettings, parseSettings, parseStats, type MiaChatterSettings, type MiaChatterStats } from './mia-chatter.settings';
import { createPkcePair, decryptToken, encryptToken, parseTokenKey, randomState } from './token-cipher';

/** Os testes trocam a rede por um fetch falso e o modelo de texto por um cliente falso por estes tokens. */
export const MIA_CHATTER_FETCH = Symbol('MIA_CHATTER_FETCH');
export const MIA_CHATTER_TEXT_CLIENT = Symbol('MIA_CHATTER_TEXT_CLIENT');

export const MIA_CHATTER_WHALE_NOTIFICATION = 'mia-chatter-whale';
/** OAuth iniciado e não concluído vence em 15 min (o state deixa de valer). */
const OAUTH_TTL_MS = 15 * 60 * 1000;
/** Mensagem do fã mais velha que isso não ganha resposta (na 1ª leitura da conta, conversa antiga fica quieta). */
const MAX_REPLY_AGE_MS = 48 * 60 * 60 * 1000;
const MAX_COUNTED_IDS = 200;
/** renova o token 2 min antes de vencer */
const TOKEN_SKEW_MS = 2 * 60 * 1000;

export type PerfectpaySaleKind = 'paid' | 'refund' | 'chargeback' | 'canceled' | 'superseded' | 'ignore';

export interface MiaChatterStatus {
  enabled: true;
  /** faltam credenciais da Fanvue no servidor: a tela mostra "em breve" sem botão de conectar */
  connectReady: boolean;
  status: string;
  active: boolean;
  paid: boolean;
  paidUntil: string | null;
  handle: string | null;
  settings: MiaChatterSettings;
  stats: MiaChatterStats;
  llm: { month: string; spentUsd: number; capUsd: number };
  whaleUsd: number;
  topFans: { handle: string | null; spentUsd: number; purchases: number; whale: boolean }[];
  lastError: string | null;
}

export interface SettingsPatch {
  active?: boolean;
  personaName?: string | null;
  personaBio?: string | null;
  locale?: string;
  aiLabelConfirmed?: boolean;
  tierMedia?: Record<string, string[]>;
}

/** Texto do sino quando um fã passa do valor de baleia, na língua da cliente. */
export function whaleAlertText(locale: MailLocale, fan: string, spentUsd: number, whaleUsd: number): string {
  const amount = spentUsd.toFixed(2).replace(/\.00$/, '');
  if (locale === 'pt') {
    return `Baleia na Fanvue: ${fan} já gastou US$ ${amount} com você (passou de US$ ${whaleUsd}). A Mia parou de responder ele: agora é você, atenção pessoal e pedido sob medida.`;
  }
  if (locale === 'es') {
    return `Ballena en Fanvue: ${fan} ya gastó US$ ${amount} contigo (pasó de US$ ${whaleUsd}). Mia dejó de responderle: ahora te toca a ti, atención personal y pedido a medida.`;
  }
  return `Whale on Fanvue: ${fan} has spent US$ ${amount} with you (over US$ ${whaleUsd}). Mia stopped replying to him: he's yours now, personal attention and custom requests.`;
}

/** Conta paga: assinatura em dia ou e-mail de cortesia (teste do dono, MIA_CHATTER_COMP_EMAILS). */
export function isPaid(paidUntil: Date | null | undefined, now: Date, comp = false): boolean {
  return comp || (!!paidUntil && paidUntil.getTime() > now.getTime());
}

/** Próxima data paga: soma os dias a partir do que ainda resta (renovar antes do fim não perde dias). */
export function extendPaidUntil(current: Date | null | undefined, now: Date, days: number): Date {
  const base = current && current.getTime() > now.getTime() ? current : now;
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

@Injectable()
export class MiaChatterService {
  private readonly logger = new Logger(MiaChatterService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly notifications: NotificationsService,
    @Optional() @Inject(MIA_CHATTER_FETCH) private readonly fetchImpl?: FetchLike,
    @Optional() @Inject(MIA_CHATTER_TEXT_CLIENT) private readonly textClient?: ChatterTextClient,
  ) {}

  config(): MiaChatterConfig {
    return readMiaChatterConfig((key) => this.configService.get<string>(key));
  }

  enabled(): boolean {
    return this.config().enabled;
  }

  /** Flag desligada: as rotas somem (404), como se o recurso não existisse. */
  assertEnabled(): MiaChatterConfig {
    const config = this.config();
    if (!config.enabled) throw new NotFoundException();
    return config;
  }

  private compEmails(): Set<string> {
    const raw = this.configService.get<string>('MIA_CHATTER_COMP_EMAILS') ?? '';
    return new Set(raw.split(',').map((email) => email.trim().toLowerCase()).filter(Boolean));
  }

  private fanvue(config: MiaChatterConfig): FanvueClient {
    return new FanvueClient(config.fanvue, this.fetchImpl);
  }

  private text(config: MiaChatterConfig): ChatterTextClient | null {
    if (!config.llm.apiKey) return null;
    return this.textClient ?? new OpenRouterChatterClient(config.llm.apiKey, this.fetchImpl);
  }

  private async isComp(userId: string): Promise<boolean> {
    const comp = this.compEmails();
    if (!comp.size) return false;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    return !!user && comp.has(user.email.toLowerCase());
  }

  // ─── Tela ────────────────────────────────────────────────────────────────

  async status(userId: string, now = new Date()): Promise<MiaChatterStatus> {
    const config = this.assertEnabled();
    const account = await this.prisma.miaChatterAccount.findUnique({ where: { userId } });
    const fans = account
      ? await this.prisma.miaChatterFan.findMany({
          where: { accountId: account.id, spentUsd: { gt: 0 } },
          orderBy: { spentUsd: 'desc' },
          take: 5,
          select: { handle: true, spentUsd: true, purchases: true },
        })
      : [];
    const comp = await this.isComp(userId);
    return {
      enabled: true,
      connectReady: missingForConnect(config).length === 0,
      status: account?.status ?? 'disconnected',
      active: account?.active ?? false,
      paid: isPaid(account?.paidUntil, now, comp),
      paidUntil: account?.paidUntil?.toISOString() ?? null,
      handle: account?.fanvueHandle ?? null,
      settings: parseSettings(account?.settings),
      stats: account ? parseStats(account.stats) : { ...EMPTY_STATS },
      llm: {
        month: costMonthOf(now),
        spentUsd: Math.round(spentThisMonth(account?.llmMonth, Number(account?.llmCostUsd ?? 0), now) * 100) / 100,
        capUsd: config.llm.capUsdPerMonth,
      },
      whaleUsd: config.whaleUsd,
      topFans: fans.map((fan) => ({
        handle: fan.handle,
        spentUsd: Number(fan.spentUsd),
        purchases: fan.purchases,
        whale: Number(fan.spentUsd) >= config.whaleUsd,
      })),
      lastError: account?.lastError ?? null,
    };
  }

  /** Começa o OAuth: guarda state + verificador PKCE (cifrado) e devolve a URL de autorização da Fanvue. */
  async startConnect(userId: string, now = new Date()): Promise<{ url: string }> {
    const config = this.assertEnabled();
    const missing = missingForConnect(config);
    const key = parseTokenKey(config.tokenKey);
    if (missing.length || !key) throw new BadRequestException('Fanvue connection is not configured yet');
    const state = randomState();
    const { verifier, challenge } = createPkcePair();
    const oauth = { oauthState: state, oauthVerifierEnc: encryptToken(verifier, key), oauthStartedAt: now };
    await this.prisma.miaChatterAccount.upsert({
      where: { userId },
      create: { userId, status: 'pending', ...oauth },
      update: oauth,
    });
    return { url: buildAuthorizeUrl(config.fanvue, { state, codeChallenge: challenge }) };
  }

  private returnUrl(config: MiaChatterConfig, result: 'connected' | 'error'): string {
    const url = new URL(config.returnUrl);
    url.searchParams.set('miaChatter', result);
    return url.toString();
  }

  /** Volta do OAuth (rota pública): troca o código, guarda os tokens cifrados e devolve para onde a cliente vai. */
  async handleCallback(params: { state?: string; code?: string; error?: string }, now = new Date()): Promise<string> {
    const config = this.assertEnabled();
    const key = parseTokenKey(config.tokenKey);
    const state = (params.state ?? '').trim();
    if (!state || !key) return this.returnUrl(config, 'error');
    const account = await this.prisma.miaChatterAccount.findUnique({ where: { oauthState: state } });
    if (!account) return this.returnUrl(config, 'error');
    const clearOauth = { oauthState: null, oauthVerifierEnc: null, oauthStartedAt: null };
    const expired = !account.oauthStartedAt || now.getTime() - account.oauthStartedAt.getTime() > OAUTH_TTL_MS;
    const verifier = decryptToken(account.oauthVerifierEnc, key);
    if (params.error || !params.code || expired || !verifier) {
      await this.prisma.miaChatterAccount.update({
        where: { id: account.id },
        data: { ...clearOauth, status: account.accessTokenEnc ? account.status : 'disconnected', lastError: params.error ? `oauth: ${params.error}`.slice(0, 200) : 'oauth: expired' },
      });
      return this.returnUrl(config, 'error');
    }
    try {
      const client = this.fanvue(config);
      const tokens = await client.exchangeCode(params.code, verifier);
      const creator = await client.getCreator(tokens.accessToken);
      await this.prisma.miaChatterAccount.update({
        where: { id: account.id },
        data: {
          ...clearOauth,
          status: 'connected',
          fanvueCreatorUuid: creator.uuid,
          fanvueHandle: creator.handle ?? creator.displayName,
          accessTokenEnc: encryptToken(tokens.accessToken, key),
          refreshTokenEnc: tokens.refreshToken ? encryptToken(tokens.refreshToken, key) : account.refreshTokenEnc,
          tokenExpiresAt: tokens.expiresAt,
          scopes: tokens.scope,
          lastError: null,
        },
      });
      return this.returnUrl(config, 'connected');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[MIA_CHATTER] OAuth falhou (conta ${account.id}): ${reason.slice(0, 160)}`);
      await this.prisma.miaChatterAccount.update({ where: { id: account.id }, data: { ...clearOauth, status: 'error', lastError: `oauth: ${reason}`.slice(0, 200) } });
      return this.returnUrl(config, 'error');
    }
  }

  async updateSettings(userId: string, patch: SettingsPatch, now = new Date()): Promise<MiaChatterStatus> {
    this.assertEnabled();
    const account = await this.prisma.miaChatterAccount.findUnique({ where: { userId } });
    const settings = mergeSettings(parseSettings(account?.settings), patch);
    if (patch.active === true) {
      if (!account || account.status !== 'connected') throw new BadRequestException('Connect your Fanvue account first');
      // rótulo de IA obrigatório: a Fanvue exige o perfil marcado como IA; sem a confirmação a Mia não liga
      if (!settings.aiLabelConfirmed) throw new BadRequestException('Confirm your Fanvue profile is labeled as AI');
      if (!isPaid(account.paidUntil, now, await this.isComp(userId))) throw new BadRequestException('Mia Chatter subscription is not active');
    }
    const data = {
      settings: settings as unknown as Prisma.InputJsonValue,
      ...(patch.active !== undefined && { active: patch.active }),
      // tirou a confirmação do rótulo de IA: a Mia para na hora
      ...(!settings.aiLabelConfirmed && { active: false }),
    };
    await this.prisma.miaChatterAccount.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    return this.status(userId, now);
  }

  async disconnect(userId: string): Promise<MiaChatterStatus> {
    this.assertEnabled();
    await this.prisma.miaChatterAccount.updateMany({
      where: { userId },
      data: {
        status: 'disconnected',
        active: false,
        accessTokenEnc: null,
        refreshTokenEnc: null,
        tokenExpiresAt: null,
        oauthState: null,
        oauthVerifierEnc: null,
        oauthStartedAt: null,
      },
    });
    return this.status(userId);
  }

  // ─── Assinatura US$ 39/mês (webhook da Perfect Pay) ─────────────────────

  /**
   * Chamado pelo webhook da Perfect Pay antes de qualquer outra regra. Devolve null quando a venda não é do Mia
   * Chatter (flag off, sem código configurado ou código diferente): o webhook segue exatamente como antes.
   */
  async applyPerfectpaySale(input: { kind: PerfectpaySaleKind; email: string | null; planCandidates: string[]; saleCode: string | null }, now = new Date()): Promise<{ processed: boolean; reason: string } | null> {
    const config = this.config();
    if (!config.enabled || !config.ppPlanCodes.length) return null;
    const codes = new Set(config.ppPlanCodes);
    if (!input.planCandidates.some((code) => codes.has(String(code).trim().toUpperCase()))) return null;
    if (input.kind === 'superseded' || input.kind === 'ignore') return { processed: false, reason: `mia-chatter: ignored (${input.kind})` };
    if (!input.email) return { processed: false, reason: 'mia-chatter: sem email' };
    const user = await this.prisma.user.findUnique({ where: { email: input.email.trim().toLowerCase() }, select: { id: true } });
    if (!user) return { processed: false, reason: `mia-chatter: no account for email ${input.email}` };
    const account = await this.prisma.miaChatterAccount.findUnique({ where: { userId: user.id } });

    if (input.kind === 'paid') {
      if (input.saleCode && account?.lastSaleCode === input.saleCode) return { processed: true, reason: 'mia-chatter: duplicate sale' };
      const paidUntil = extendPaidUntil(account?.paidUntil, now, config.paidDays);
      await this.prisma.miaChatterAccount.upsert({
        where: { userId: user.id },
        create: { userId: user.id, paidUntil, lastSaleCode: input.saleCode },
        update: { paidUntil, lastSaleCode: input.saleCode },
      });
      return { processed: true, reason: `mia-chatter: paid until ${paidUntil.toISOString()}` };
    }
    if (!account) return { processed: false, reason: 'mia-chatter: no chatter account' };
    if (input.kind === 'refund' || input.kind === 'chargeback') {
      await this.prisma.miaChatterAccount.update({ where: { id: account.id }, data: { paidUntil: now, active: false } });
      return { processed: true, reason: `mia-chatter: ${input.kind}, access ended` };
    }
    // cancelamento: o acesso vai até o fim do período já pago
    return { processed: true, reason: 'mia-chatter: canceled, access until end of period' };
  }

  // ─── Cron: lê as conversas e responde ───────────────────────────────────

  async runOnce(now = new Date()): Promise<{ accounts: number; replies: number }> {
    const config = this.config();
    if (!config.enabled || this.running) return { accounts: 0, replies: 0 };
    this.running = true;
    try {
      const comp = this.compEmails();
      const accounts = await this.prisma.miaChatterAccount.findMany({
        where: {
          status: 'connected',
          active: true,
          OR: [{ paidUntil: { gt: now } }, ...(comp.size ? [{ user: { email: { in: [...comp] } } }] : [])],
        },
        take: 200,
      });
      let replies = 0;
      for (const account of accounts) {
        try {
          replies += await this.processAccount(account, config, now);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.logger.warn(`[MIA_CHATTER] conta ${account.id}: ${reason.slice(0, 160)}`);
          await this.prisma.miaChatterAccount
            .update({ where: { id: account.id }, data: { lastError: reason.slice(0, 200), lastPolledAt: now } })
            .catch(() => undefined);
        }
      }
      return { accounts: accounts.length, replies };
    } finally {
      this.running = false;
    }
  }

  /** Token válido da conta (renova quando está para vencer). Null = conta precisa reconectar. */
  private async accessToken(account: MiaChatterAccount, config: MiaChatterConfig, key: Buffer, now: Date): Promise<string | null> {
    const access = decryptToken(account.accessTokenEnc, key);
    if (access && account.tokenExpiresAt && account.tokenExpiresAt.getTime() - TOKEN_SKEW_MS > now.getTime()) return access;
    const refresh = decryptToken(account.refreshTokenEnc, key);
    if (!refresh) {
      await this.prisma.miaChatterAccount.update({ where: { id: account.id }, data: { status: 'error', active: false, lastError: 'reconnect: token expired' } });
      return null;
    }
    try {
      const tokens = await this.fanvue(config).refresh(refresh);
      await this.prisma.miaChatterAccount.update({
        where: { id: account.id },
        data: {
          accessTokenEnc: encryptToken(tokens.accessToken, key),
          refreshTokenEnc: tokens.refreshToken ? encryptToken(tokens.refreshToken, key) : account.refreshTokenEnc,
          tokenExpiresAt: tokens.expiresAt,
        },
      });
      return tokens.accessToken;
    } catch (error) {
      if (error instanceof FanvueApiError && (error.status === 400 || error.status === 401)) {
        await this.prisma.miaChatterAccount.update({ where: { id: account.id }, data: { status: 'error', active: false, lastError: `reconnect: ${error.message}`.slice(0, 200) } });
        return null;
      }
      throw error;
    }
  }

  /** Uma rodada numa conta: lê as conversas com novidade, soma compras, avisa baleia e responde. Devolve quantas respostas saíram. */
  async processAccount(account: MiaChatterAccount, config: MiaChatterConfig, now: Date): Promise<number> {
    const key = parseTokenKey(config.tokenKey);
    if (!key) return 0;
    const settings = parseSettings(account.settings);
    if (!settings.aiLabelConfirmed) return 0;
    const token = await this.accessToken(account, config, key, now);
    if (!token) return 0;

    const client = this.fanvue(config);
    const stats = parseStats(account.stats);
    const month = costMonthOf(now);
    let llmSpent = spentThisMonth(account.llmMonth, Number(account.llmCostUsd), now);
    let replies = 0;

    try {
      const chats = (await client.listChats(token)).sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0));
      const known = await this.prisma.miaChatterFan.findMany({ where: { accountId: account.id, fanUuid: { in: chats.map((chat) => chat.fanUuid) } } });
      const fans = new Map(known.map((fan) => [fan.fanUuid, fan]));

      for (const chat of chats) {
        if (replies >= config.maxRepliesPerRun) break;
        const fan = fans.get(chat.fanUuid) ?? null;
        if (fan?.stopped) continue;
        // nada novo desde a última leitura
        if (fan && chat.unread === 0 && chat.lastMessageAt && fan.lastInboundAt && chat.lastMessageAt.getTime() <= fan.lastInboundAt.getTime()) continue;

        const result = await this.handleChat({ account, config, settings, stats, client, token, chat, fan, now, llmSpent });
        llmSpent = result.llmSpent;
        if (result.replied) replies += 1;
      }
    } finally {
      await this.prisma.miaChatterAccount.update({
        where: { id: account.id },
        data: {
          stats: stats as unknown as Prisma.InputJsonValue,
          llmMonth: month,
          llmCostUsd: new Prisma.Decimal(llmSpent.toFixed(4)),
          lastPolledAt: now,
          lastError: null,
        },
      });
    }
    return replies;
  }

  private async handleChat(ctx: {
    account: MiaChatterAccount;
    config: MiaChatterConfig;
    settings: MiaChatterSettings;
    stats: MiaChatterStats;
    client: FanvueClient;
    token: string;
    chat: FanvueChat;
    fan: MiaChatterFan | null;
    now: Date;
    llmSpent: number;
  }): Promise<{ replied: boolean; llmSpent: number }> {
    const { account, config, settings, stats, client, token, chat, now } = ctx;
    let llmSpent = ctx.llmSpent;
    const messages = await client.listMessages(token, chat.fanUuid);

    const fan =
      ctx.fan ??
      (await this.prisma.miaChatterFan.create({
        data: { accountId: account.id, fanUuid: chat.fanUuid, handle: chat.displayName ?? chat.handle },
      }));
    if (!ctx.fan) stats.conversations += 1;

    // compras: mensagens pagas da criadora que o fã desbloqueou e ainda não somamos
    const counted = new Set(Array.isArray(fan.countedPurchaseIds) ? (fan.countedPurchaseIds as string[]) : []);
    const fresh = messages.filter((message) => !message.fromFan && message.purchased && message.priceUsd && !counted.has(message.uuid));
    const addedUsd = fresh.reduce((sum, message) => sum + (message.priceUsd ?? 0), 0);
    fresh.forEach((message) => counted.add(message.uuid));
    const purchases = fan.purchases + fresh.length;
    const spentUsd = Math.max(Number(fan.spentUsd) + addedUsd, chat.spentUsd ?? 0);
    stats.sales += fresh.length;
    stats.revenueUsd = Math.round((stats.revenueUsd + addedUsd) * 100) / 100;

    const fanUpdate: Prisma.MiaChatterFanUpdateInput = {
      handle: chat.displayName ?? chat.handle ?? fan.handle,
      purchases,
      spentUsd: new Prisma.Decimal(spentUsd.toFixed(2)),
      countedPurchaseIds: [...counted].slice(-MAX_COUNTED_IDS),
    };

    // baleia: avisa a cliente uma vez (a Mia passa a conversa para ela)
    if (spentUsd >= config.whaleUsd && !fan.whaleAlertedAt) {
      fanUpdate.whaleAlertedAt = now;
      stats.whales += 1;
      await this.alertWhale(account.userId, chat.displayName ?? chat.handle ?? 'fan', spentUsd, config.whaleUsd);
    }

    const fanMessages = messages.filter((message) => message.fromFan);
    const latestFan = fanMessages[fanMessages.length - 1];
    const lastMessage = messages[messages.length - 1];
    const needsReply =
      !!latestFan &&
      lastMessage?.uuid === latestFan.uuid &&
      latestFan.uuid !== fan.lastInboundUuid &&
      (!latestFan.sentAt || now.getTime() - latestFan.sentAt.getTime() <= MAX_REPLY_AGE_MS);

    if (!needsReply) {
      if (latestFan) {
        fanUpdate.lastInboundUuid = latestFan.uuid;
        fanUpdate.lastInboundAt = latestFan.sentAt ?? now;
      }
      await this.prisma.miaChatterFan.update({ where: { id: fan.id }, data: fanUpdate });
      return { replied: false, llmSpent };
    }

    fanUpdate.lastInboundUuid = latestFan.uuid;
    fanUpdate.lastInboundAt = latestFan.sentAt ?? now;
    const decision = decideReply({
      fan: {
        step: fan.step as ChatterStep,
        purchases,
        spentUsd,
        lastOfferAt: fan.lastOfferAt,
        lastInboundAt: fan.lastInboundAt,
        declinedAt: fan.declinedAt,
        stopped: fan.stopped,
      },
      newPurchases: fresh.length,
      signal: classifyFanMessage(latestFan.text),
      fanMessageCount: fanMessages.length,
      previousInboundAt: fan.lastInboundAt,
      now,
      whaleUsd: config.whaleUsd,
    });

    if (decision.action !== 'reply') {
      await this.prisma.miaChatterFan.update({ where: { id: fan.id }, data: fanUpdate });
      return { replied: false, llmSpent };
    }

    const locale: ChatterLocale = settings.locale === 'auto' ? detectLocale(fanMessages.map((message) => message.text).join(' '), 'en') : settings.locale;
    const previousFan = fanMessages[fanMessages.length - 2];
    const vars = {
      fanName: (chat.displayName ?? chat.handle ?? '').split(' ')[0],
      modelName: settings.personaName ?? account.fanvueHandle ?? 'Mia',
      lastTopic: decision.intent === 'comeback' ? lastTopicFrom(previousFan?.text) : null,
    };

    const written = await this.writeReply({ config, decision, locale, settings, vars, history: messages, llmSpent });
    llmSpent = written.llmSpent;
    if (written.fromKit) stats.kitReplies += 1;

    const media = decision.offer ? settings.tierMedia[decision.offer] : [];
    await client.sendMessage(token, chat.fanUuid, {
      text: written.text,
      mediaUuids: media,
      priceUsd: decision.offer ? TIER_PRICE_USD[decision.offer] : null,
    });
    stats.replies += 1;
    if (decision.offer) stats.offers += 1;

    fanUpdate.step = decision.step;
    fanUpdate.lastReplyAt = now;
    if (decision.offer) fanUpdate.lastOfferAt = now;
    if (decision.intent === 'no') fanUpdate.declinedAt = now;
    if (decision.stop) fanUpdate.stopped = true;
    await this.prisma.miaChatterFan.update({ where: { id: fan.id }, data: fanUpdate });
    return { replied: true, llmSpent };
  }

  /**
   * Texto da resposta: o modelo do OpenRouter quando o pior caso da chamada cabe no teto do mês e a resposta passa
   * nas travas; senão o texto pronto do kit (custo zero).
   */
  private async writeReply(params: {
    config: MiaChatterConfig;
    decision: Extract<Decision, { action: 'reply' }>;
    locale: ChatterLocale;
    settings: MiaChatterSettings;
    vars: { fanName: string; modelName: string; lastTopic: string | null };
    history: { fromFan: boolean; text: string }[];
    llmSpent: number;
  }): Promise<{ text: string; fromKit: boolean; llmSpent: number }> {
    const { config, decision, locale, settings, vars } = params;
    let llmSpent = params.llmSpent;
    const kit = () => fallbackReply(locale, decision, vars, Math.floor(Math.random() * 1000));
    // "para" e "você é real?" têm resposta fixa: não gasta modelo
    if (decision.intent === 'stopAck' || decision.intent === 'askReal') return { text: kit(), fromKit: false, llmSpent };
    const client = this.text(config);
    if (!client) return { text: kit(), fromKit: true, llmSpent };

    const system = buildSystemPrompt(locale, { name: vars.modelName, bio: settings.personaBio });
    const user = buildUserPrompt(decision, vars, params.history);
    const pricing = { priceInPerMTok: config.llm.priceInPerMTok, priceOutPerMTok: config.llm.priceOutPerMTok };
    for (const model of config.llm.models) {
      const worst = worstCaseCallUsd(system, user, config.llm.maxTokens, pricing);
      if (!fitsCap(llmSpent, worst, config.llm.capUsdPerMonth)) break;
      try {
        const result = await client.complete({ model, system, user, maxTokens: config.llm.maxTokens, timeoutMs: config.llm.timeoutMs });
        llmSpent += result.costUsd ?? costFromTokens(result.promptTokens, result.completionTokens, pricing);
        const clean = sanitizeReply(result.text, decision);
        if (clean) return { text: clean, fromKit: false, llmSpent };
        this.logger.warn(`[MIA_CHATTER] resposta fora das travas (${model}); tentando o próximo`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`[MIA_CHATTER] modelo indisponível (${model}): ${reason.slice(0, 160)}`);
      }
    }
    return { text: kit(), fromKit: true, llmSpent };
  }

  private async alertWhale(userId: string, fanName: string, spentUsd: number, whaleUsd: number): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { locale: true, country: true } });
      const locale = mailLocaleFor({ locale: user?.locale ?? null, country: user?.country ?? null });
      await this.notifications.create(userId, MIA_CHATTER_WHALE_NOTIFICATION, {
        reason: whaleAlertText(locale, fanName, spentUsd, whaleUsd),
        fan: fanName,
        spentUsd: Math.round(spentUsd * 100) / 100,
      });
    } catch (error) {
      // o aviso nunca derruba a rodada: a conversa segue marcada como baleia (a Mia já parou com ele)
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[MIA_CHATTER] aviso de baleia falhou (${userId}): ${reason.slice(0, 160)}`);
    }
  }
}
