import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MiaChatterService, MIA_CHATTER_WHALE_NOTIFICATION, extendPaidUntil, whaleAlertText } from '../mia-chatter.service';
import { MiaChatterCron } from '../mia-chatter.cron';
import { readMiaChatterConfig } from '../mia-chatter.config';
import { decryptToken, encryptToken, parseTokenKey } from '../token-cipher';
import type { ChatterTextClient } from '../chatter-llm';

const KEY_HEX = 'a'.repeat(64);
const KEY = parseTokenKey(KEY_HEX)!;
const NOW = new Date('2026-11-24T15:00:00Z');

const ENV_ON: Record<string, string> = {
  MIA_CHATTER_ENABLED: 'on',
  FANVUE_CLIENT_ID: 'client-id',
  FANVUE_CLIENT_SECRET: 'client-secret',
  FANVUE_REDIRECT_URI: 'https://api.example.com/api/v1/mia-chatter/oauth/callback',
  MIA_CHATTER_TOKEN_KEY: KEY_HEX,
  MIA_CHATTER_RETURN_URL: 'https://www.example.com/x',
  OPENROUTER_API_KEY: 'or-key',
  MIA_CHATTER_PP_PLAN_CODES: 'ppmiachat',
};

/** Prisma de mentira em memória, só com o que o serviço usa. */
function fakePrisma() {
  const accounts: any[] = [];
  const fans: any[] = [];
  const users = [{ id: 'u1', email: 'cliente@example.com', locale: 'pt-BR', country: 'BR' }];
  let seq = 0;
  const matches = (row: any, where: any) => Object.entries(where).every(([key, value]) => row[key] === value);
  const prisma = {
    accounts,
    fans,
    user: {
      findUnique: jest.fn(async ({ where }: any) => users.find((user) => matches(user, where)) ?? null),
    },
    miaChatterAccount: {
      findUnique: jest.fn(async ({ where }: any) => accounts.find((row) => matches(row, where)) ?? null),
      findMany: jest.fn(async () => accounts.filter((row) => row.status === 'connected' && row.active)),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const row = accounts.find((item) => matches(item, where));
        if (row) return Object.assign(row, update);
        const created = { id: `acc${++seq}`, status: 'disconnected', active: false, llmCostUsd: new Prisma.Decimal(0), settings: null, stats: null, ...create };
        accounts.push(created);
        return created;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(accounts.find((row) => matches(row, where)), data)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        accounts.filter((row) => matches(row, where)).forEach((row) => Object.assign(row, data));
        return { count: 1 };
      }),
    },
    miaChatterFan: {
      findMany: jest.fn(async ({ where }: any) => fans.filter((fan) => fan.accountId === where.accountId)),
      create: jest.fn(async ({ data }: any) => {
        const fan = {
          id: `fan${++seq}`,
          step: 'welcome',
          spentUsd: new Prisma.Decimal(0),
          purchases: 0,
          countedPurchaseIds: null,
          lastInboundUuid: null,
          lastInboundAt: null,
          lastOfferAt: null,
          declinedAt: null,
          stopped: false,
          whaleAlertedAt: null,
          ...data,
        };
        fans.push(fan);
        return fan;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(fans.find((fan) => fan.id === where.id), data)),
    },
  };
  return prisma;
}

/** Fanvue de mentira: responde token, perfil, conversas e mensagens; guarda o que a Mia enviou. */
function fakeFanvue(messages: any[]) {
  const sent: any[] = [];
  const calls: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.includes('/oauth2/token')) return json({ access_token: 'ACCESS-PLAIN', refresh_token: 'REFRESH-PLAIN', expires_in: 3600, scope: 'read:chat write:chat' });
    if (url.endsWith('/users/me')) return json({ uuid: 'creator-1', handle: 'miadoll' });
    if (url.includes('/chats?')) {
      return json({ data: [{ user: { uuid: 'fan-1', displayName: 'Leo Smith' }, unreadMessagesCount: 1, lastMessage: { sentAt: messages[messages.length - 1]?.sentAt } }] });
    }
    if (url.includes('/messages?')) return json({ data: messages });
    if (url.endsWith('/chats/fan-1/message')) {
      sent.push(JSON.parse(String(init?.body)));
      return json({ messageUuid: `out-${sent.length}` });
    }
    return json({ message: 'not found' }, 404);
  });
  return { fetchImpl, sent, calls };
}

function makeService(env: Record<string, string | undefined>, options: { messages?: any[]; text?: ChatterTextClient } = {}) {
  const prisma = fakePrisma();
  const fanvue = fakeFanvue(options.messages ?? []);
  const notifications = { create: jest.fn(async () => undefined) };
  const config = { get: (key: string) => env[key] };
  const service = new MiaChatterService(prisma as any, config as any, notifications as any, fanvue.fetchImpl as any, options.text);
  return { service, prisma, fanvue, notifications };
}

function connectedAccount(prisma: ReturnType<typeof fakePrisma>, overrides: Record<string, unknown> = {}) {
  const account = {
    id: 'acc-1',
    userId: 'u1',
    status: 'connected',
    active: true,
    fanvueCreatorUuid: 'creator-1',
    fanvueHandle: 'miadoll',
    accessTokenEnc: encryptToken('ACCESS-PLAIN', KEY),
    refreshTokenEnc: encryptToken('REFRESH-PLAIN', KEY),
    tokenExpiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
    paidUntil: new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000),
    settings: { aiLabelConfirmed: true, personaName: 'Mia', tierMedia: { teaser: ['media-teaser-01'], spicy: [], whale: [] } },
    stats: null,
    llmMonth: null,
    llmCostUsd: new Prisma.Decimal(0),
    lastSaleCode: null,
    ...overrides,
  };
  prisma.accounts.push(account);
  return account;
}

const fanMessage = (uuid: string, text: string, minutesAgo: number) => ({
  uuid,
  text,
  sentAt: new Date(NOW.getTime() - minutesAgo * 60 * 1000).toISOString(),
  sender: { uuid: 'fan-1' },
});

describe('Mia Chatter · flag desligada = igual a hoje', () => {
  const env = { ...ENV_ON, MIA_CHATTER_ENABLED: undefined };

  it('o padrão é desligado', () => {
    expect(readMiaChatterConfig(() => undefined).enabled).toBe(false);
    expect(readMiaChatterConfig((key) => (key === 'MIA_CHATTER_ENABLED' ? 'off' : undefined)).enabled).toBe(false);
  });

  it('rotas somem (404)', async () => {
    const { service } = makeService(env);
    await expect(service.status('u1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.startConnect('u1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.updateSettings('u1', { active: true })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.disconnect('u1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('o cron não toca no banco nem na rede', async () => {
    const { service, prisma, fanvue } = makeService(env);
    await new MiaChatterCron(service).tick();
    expect(await service.runOnce(NOW)).toEqual({ accounts: 0, replies: 0 });
    expect(prisma.miaChatterAccount.findMany).not.toHaveBeenCalled();
    expect(fanvue.fetchImpl).not.toHaveBeenCalled();
  });

  it('o webhook da Perfect Pay segue como antes (null), mesmo com o código configurado', async () => {
    const { service, prisma } = makeService(env);
    expect(await service.applyPerfectpaySale({ kind: 'paid', email: 'cliente@example.com', planCandidates: ['PPMIACHAT'], saleCode: 'S1' })).toBeNull();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('Mia Chatter · OAuth da Fanvue', () => {
  it('começa com state + PKCE S256 e guarda o verificador cifrado', async () => {
    const { service, prisma } = makeService(ENV_ON);
    const { url } = await service.startConnect('u1', NOW);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('client_id')).toBe('client-id');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('scope')).toContain('read:chat');
    expect(parsed.searchParams.get('scope')).toContain('write:chat');
    const account = prisma.accounts[0];
    expect(account.oauthState).toBe(parsed.searchParams.get('state'));
    expect(account.oauthVerifierEnc).toMatch(/^v1:/);
  });

  it('sem credenciais da Fanvue no servidor, não começa', async () => {
    const { service } = makeService({ ...ENV_ON, FANVUE_CLIENT_SECRET: '' });
    await expect(service.startConnect('u1', NOW)).rejects.toBeInstanceOf(BadRequestException);
    expect((await service.status('u1', NOW)).connectReady).toBe(false);
  });

  it('volta do OAuth: troca o código, guarda os tokens só cifrados e devolve à aba PPV', async () => {
    const { service, prisma } = makeService(ENV_ON);
    const { url } = await service.startConnect('u1', NOW);
    const state = new URL(url).searchParams.get('state')!;
    const target = await service.handleCallback({ state, code: 'CODE' }, new Date(NOW.getTime() + 60_000));
    expect(target).toBe('https://www.example.com/x?miaChatter=connected');
    const account = prisma.accounts[0];
    expect(account.status).toBe('connected');
    expect(account.fanvueHandle).toBe('miadoll');
    expect(account.accessTokenEnc).not.toContain('ACCESS-PLAIN');
    expect(decryptToken(account.accessTokenEnc, KEY)).toBe('ACCESS-PLAIN');
    expect(account.oauthState).toBeNull();
  });

  it('state vencido (15 min) ou desconhecido = erro, sem trocar código', async () => {
    const { service, fanvue } = makeService(ENV_ON);
    const { url } = await service.startConnect('u1', NOW);
    const state = new URL(url).searchParams.get('state')!;
    expect(await service.handleCallback({ state: 'nope', code: 'CODE' }, NOW)).toContain('miaChatter=error');
    expect(await service.handleCallback({ state, code: 'CODE' }, new Date(NOW.getTime() + 16 * 60_000))).toContain('miaChatter=error');
    expect(fanvue.calls.some((call) => call.includes('/oauth2/token'))).toBe(false);
  });

  it('a cifra recusa texto adulterado ou chave errada', () => {
    const sealed = encryptToken('segredo', KEY);
    expect(decryptToken(sealed, KEY)).toBe('segredo');
    expect(decryptToken(`${sealed.slice(0, -2)}xx`, KEY)).toBeNull();
    expect(decryptToken(sealed, parseTokenKey('b'.repeat(64))!)).toBeNull();
    expect(parseTokenKey('curta')).toBeNull();
  });
});

describe('Mia Chatter · rótulo de IA e assinatura', () => {
  it('não liga sem a confirmação do rótulo de IA', async () => {
    const { service, prisma } = makeService(ENV_ON);
    connectedAccount(prisma, { active: false, settings: { aiLabelConfirmed: false } });
    await expect(service.updateSettings('u1', { active: true }, NOW)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('não liga sem assinatura em dia', async () => {
    const { service, prisma } = makeService(ENV_ON);
    connectedAccount(prisma, { active: false, paidUntil: null });
    await expect(service.updateSettings('u1', { active: true }, NOW)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('tirar a confirmação do rótulo pausa a Mia na hora', async () => {
    const { service, prisma } = makeService(ENV_ON);
    connectedAccount(prisma);
    const status = await service.updateSettings('u1', { aiLabelConfirmed: false }, NOW);
    expect(status.active).toBe(false);
  });

  it('conta sem rótulo confirmado não responde ninguém', async () => {
    const { service, prisma, fanvue } = makeService(ENV_ON, { messages: [fanMessage('m1', 'hey', 5)] });
    const account = connectedAccount(prisma, { settings: { aiLabelConfirmed: false } });
    expect(await service.processAccount(account as any, service.config(), NOW)).toBe(0);
    expect(fanvue.fetchImpl).not.toHaveBeenCalled();
  });

  it('Perfect Pay: venda aprovada do código do Mia Chatter estende o acesso; repetida não soma 2×', async () => {
    const { service, prisma } = makeService(ENV_ON);
    const first = await service.applyPerfectpaySale({ kind: 'paid', email: 'cliente@example.com', planCandidates: ['PPMIACHAT'], saleCode: 'S1' }, NOW);
    expect(first?.processed).toBe(true);
    const paidUntil = prisma.accounts[0].paidUntil as Date;
    expect(paidUntil.getTime()).toBe(extendPaidUntil(null, NOW, 31).getTime());
    const again = await service.applyPerfectpaySale({ kind: 'paid', email: 'cliente@example.com', planCandidates: ['PPMIACHAT'], saleCode: 'S1' }, NOW);
    expect(again?.reason).toContain('duplicate');
    expect((prisma.accounts[0].paidUntil as Date).getTime()).toBe(paidUntil.getTime());
  });

  it('Perfect Pay: outro código (plano da plataforma) não é do Mia Chatter (null)', async () => {
    const { service } = makeService(ENV_ON);
    expect(await service.applyPerfectpaySale({ kind: 'paid', email: 'cliente@example.com', planCandidates: ['PPU38CQDTOD'], saleCode: 'S2' }, NOW)).toBeNull();
  });

  it('Perfect Pay: reembolso/chargeback encerra o acesso e pausa a Mia', async () => {
    const { service, prisma } = makeService(ENV_ON);
    connectedAccount(prisma);
    await service.applyPerfectpaySale({ kind: 'chargeback', email: 'cliente@example.com', planCandidates: ['PPMIACHAT'], saleCode: 'S3' }, NOW);
    expect(prisma.accounts[0].active).toBe(false);
    expect((prisma.accounts[0].paidUntil as Date).getTime()).toBe(NOW.getTime());
  });
});

describe('Mia Chatter · rodada do chat', () => {
  const grok: ChatterTextClient = {
    complete: jest.fn(async () => ({ text: 'Made this set just for you, Leo. US$ 9 🔥', costUsd: 0.002, promptTokens: 300, completionTokens: 40 })),
  };

  beforeEach(() => (grok.complete as jest.Mock).mockClear());

  it('2 mensagens do fã: oferece a isca com a mídia travada a US$ 9 (900 centavos) e soma o custo do modelo', async () => {
    const messages = [fanMessage('m1', 'hey beautiful', 10), fanMessage('m2', 'what are you up to', 2)];
    const { service, prisma, fanvue } = makeService(ENV_ON, { messages, text: grok });
    const account = connectedAccount(prisma);
    expect(await service.processAccount(account as any, service.config(), NOW)).toBe(1);
    expect(fanvue.sent).toHaveLength(1);
    expect(fanvue.sent[0]).toEqual({ text: 'Made this set just for you, Leo. US$ 9 🔥', mediaUuids: ['media-teaser-01'], price: 900 });
    expect((grok.complete as jest.Mock).mock.calls[0][0].model).toBe('x-ai/grok-4.3');
    const fan = prisma.fans[0];
    expect(fan.step).toBe('teaserOffer');
    expect(fan.lastOfferAt).toEqual(NOW);
    expect(Number(account.llmCostUsd)).toBeCloseTo(0.002, 4);
    expect(account.llmMonth).toBe('2026-11');
  });

  it('teto do mês esgotado: não chama o modelo, responde com o texto do kit (custo zero)', async () => {
    const messages = [fanMessage('m1', 'hey', 10), fanMessage('m2', 'you there?', 2)];
    const { service, prisma, fanvue } = makeService(ENV_ON, { messages, text: grok });
    const account = connectedAccount(prisma, { llmMonth: '2026-11', llmCostUsd: new Prisma.Decimal('15.5000') });
    expect(await service.processAccount(account as any, service.config(), NOW)).toBe(1);
    expect(grok.complete).not.toHaveBeenCalled();
    expect(fanvue.sent[0].text).toContain('US$ 9');
    expect((account.stats as any).kitReplies).toBe(1);
  });

  it('texto do modelo fora das travas (preço inventado): sai o texto do kit', async () => {
    const liar: ChatterTextClient = { complete: jest.fn(async () => ({ text: 'Only $3 for you!', costUsd: 0.001, promptTokens: 1, completionTokens: 1 })) };
    const messages = [fanMessage('m1', 'hey', 10), fanMessage('m2', 'show me', 2)];
    const { service, prisma, fanvue } = makeService(ENV_ON, { messages, text: liar });
    const account = connectedAccount(prisma);
    await service.processAccount(account as any, service.config(), NOW);
    expect(fanvue.sent[0].text).not.toContain('$3');
    expect(fanvue.sent[0].text).toContain('US$ 9');
  });

  it('fã passou de US$ 200: avisa a cliente uma vez e a Mia não responde mais ele', async () => {
    const paid = (uuid: string, cents: number) => ({ uuid, text: '', sentAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(), sender: { uuid: 'creator-1' }, price: cents, purchasedAt: '2026-11-24T14:10:00Z' });
    const messages = [paid('p1', 3900), paid('p2', 3900), paid('p3', 3900), paid('p4', 3900), paid('p5', 3900), paid('p6', 1900), fanMessage('m9', 'more please', 1)];
    const { service, prisma, fanvue, notifications } = makeService(ENV_ON, { messages, text: grok });
    const account = connectedAccount(prisma);
    expect(await service.processAccount(account as any, service.config(), NOW)).toBe(0);
    expect(fanvue.sent).toHaveLength(0);
    expect(notifications.create).toHaveBeenCalledTimes(1);
    const [userId, type, data] = (notifications.create as jest.Mock).mock.calls[0];
    expect(userId).toBe('u1');
    expect(type).toBe(MIA_CHATTER_WHALE_NOTIFICATION);
    expect(data.spentUsd).toBe(214);
    expect(data.reason).toContain('US$ 214');
    expect(Number(prisma.fans[0].spentUsd)).toBe(214);
    expect(prisma.fans[0].purchases).toBe(6);

    // 2ª rodada: as compras já foram somadas e o aviso não repete
    (notifications.create as jest.Mock).mockClear();
    await service.processAccount(account as any, service.config(), NOW);
    expect(notifications.create).not.toHaveBeenCalled();
    expect(Number(prisma.fans[0].spentUsd)).toBe(214);
  });

  it('o aviso de baleia sai na língua da cliente', () => {
    expect(whaleAlertText('pt', 'Leo', 214, 200)).toContain('Baleia na Fanvue');
    expect(whaleAlertText('es', 'Leo', 214, 200)).toContain('Ballena en Fanvue');
    expect(whaleAlertText('en', 'Leo', 214, 200)).toContain('Whale on Fanvue');
  });

  it('a mesma mensagem do fã não ganha 2 respostas', async () => {
    const messages = [fanMessage('m1', 'hey', 3)];
    const { service, prisma, fanvue } = makeService(ENV_ON, { messages, text: grok });
    const account = connectedAccount(prisma);
    await service.processAccount(account as any, service.config(), NOW);
    await service.processAccount(account as any, service.config(), NOW);
    expect(fanvue.sent).toHaveLength(1);
  });
});
