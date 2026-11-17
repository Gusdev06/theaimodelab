import {
  PREPAID_EXPIRED_TYPE,
  PREPAID_NOTICE_SEQUENCE,
  PREPAID_EXPIRING_TYPE,
  PrepaidExpiryNoticesService,
  expiringMilestone,
  prepaidNoticeKey,
  prepaidNoticeText,
  prepaidPlanDisplayName,
} from '../prepaid-expiry-notices.service';

const HOUR = 60 * 60 * 1000;
const now = new Date('2026-12-15T12:00:00Z');

describe('Avisos do pré-pago · funções puras', () => {
  it('marcos: D-3 até 72 h, D-1 até 24 h, fora da janela = null', () => {
    expect(expiringMilestone(new Date(now.getTime() + 73 * HOUR), now)).toBeNull();
    expect(expiringMilestone(new Date(now.getTime() + 72 * HOUR), now)).toBe('D-3');
    expect(expiringMilestone(new Date(now.getTime() + 25 * HOUR), now)).toBe('D-3');
    expect(expiringMilestone(new Date(now.getTime() + 24 * HOUR), now)).toBe('D-1');
    expect(expiringMilestone(new Date(now.getTime() + HOUR), now)).toBe('D-1');
    expect(expiringMilestone(now, now)).toBeNull();
  });

  it('nome do plano sem o sufixo de 30 dias', () => {
    expect(prepaidPlanDisplayName('Pro')).toBe('Pro');
    expect(prepaidPlanDisplayName('Pro 30d')).toBe('Pro');
    expect(prepaidPlanDisplayName('Advanced (30 dias)')).toBe('Advanced');
    expect(prepaidPlanDisplayName('Studio - 30 days')).toBe('Studio');
  });

  it('texto na língua da cliente, com o caminho de renovação', () => {
    expect(prepaidNoticeText('pt', 'Pro', 3)).toBe(
      'Seu plano Pro (acesso de 30 dias) vence em 3 dias. Renove em theaimodelab.com/pricing e continue criando sem pausa.',
    );
    expect(prepaidNoticeText('pt', 'Pro', 1)).toContain('vence em 1 dia.');
    expect(prepaidNoticeText('es', 'Advanced', 2)).toContain('Tu plan Advanced (acceso de 30 días) vence en 2 días.');
    expect(prepaidNoticeText('en', 'Studio', 1)).toContain('Your Studio plan (30-day access) expires in 1 day.');
    expect(prepaidNoticeText('pt', 'Pro', null)).toContain('venceu. Renove em theaimodelab.com/pricing');
    expect(prepaidNoticeText('es', 'Pro', null)).toContain('venció. Renueva en theaimodelab.com/pricing');
    expect(prepaidNoticeText('en', 'Pro', null)).toContain('has expired. Renew at theaimodelab.com/pricing');
  });

  it('chave = assinatura:fim ISO:marco', () => {
    expect(prepaidNoticeKey('sub-1', new Date('2026-12-17T12:00:00Z'), 'D-1')).toBe('sub-1:2026-12-17T12:00:00.000Z:D-1');
  });
});

describe('PrepaidExpiryNoticesService', () => {
  const ORIGINAL = process.env.PREPAID_NOTICES;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PREPAID_NOTICES;
    else process.env.PREPAID_NOTICES = ORIGINAL;
  });

  const sub = (overrides: Record<string, unknown>) => ({
    id: 'sub-1',
    userId: 'user-1',
    status: 'ACTIVE',
    currentPeriodEnd: new Date(now.getTime() + 60 * HOUR),
    updatedAt: new Date('2026-11-17T12:00:00Z'),
    plan: { slug: 'pro-30d', name: 'Pro' },
    user: { locale: 'es-ES', country: null },
    ...overrides,
  });

  function make(opts: {
    expiring?: unknown[];
    ended?: unknown[];
    existingKeys?: string[];
    otherActive?: boolean;
    notifyFails?: boolean;
  }) {
    const findMany = jest.fn(async (args: any) =>
      args.where.status === 'ACTIVE' ? opts.expiring ?? [] : opts.ended ?? [],
    );
    const prisma = {
      subscription: {
        findMany,
        findFirst: jest.fn(async () => (opts.otherActive ? { id: 'sub-2' } : null)),
      },
      emailSequenceLog: {
        // Chave já reservada = violação do único (P2002), como o Postgres faria.
        create: jest.fn(async (args: any) => {
          if ((opts.existingKeys ?? []).some((k) => args.data.emailKey === `${PREPAID_NOTICE_SEQUENCE}:${k}`)) {
            throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
          }
          return { id: 'claim-1' };
        }),
        delete: jest.fn(async () => ({})),
      },
    };
    const notifications = {
      create: jest.fn(async () => {
        if (opts.notifyFails) throw new Error('db down');
        return { id: 'n-new' };
      }),
    };
    const cronLogger = { wrap: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => fn()) };
    const service = new PrepaidExpiryNoticesService(prisma as any, notifications as any, cronLogger as any);
    return { service, prisma, notifications, findMany };
  }

  it('consulta só planos -30d: ACTIVE vencendo em até 72 h e vencidos nas últimas 48 h', async () => {
    const { service, findMany } = make({});
    await service.run(now);
    const [[expiringArgs], [endedArgs]] = findMany.mock.calls as any[][];
    expect(expiringArgs.where).toMatchObject({ status: 'ACTIVE', plan: { slug: { endsWith: '-30d' } } });
    expect(expiringArgs.where.currentPeriodEnd.gt).toEqual(now);
    expect(expiringArgs.where.currentPeriodEnd.lte).toEqual(new Date(now.getTime() + 72 * HOUR));
    expect(endedArgs.where.status).toEqual({ in: ['ACTIVE', 'CANCELED'] });
    expect(endedArgs.where.currentPeriodEnd.lte).toEqual(now);
  });

  it('D-3 em espanhol, com chave e link da língua', async () => {
    const { service, notifications } = make({ expiring: [sub({})] });

    const result = await service.run(now);

    expect(result.created).toBe(1);
    const end = new Date(now.getTime() + 60 * HOUR);
    expect(notifications.create).toHaveBeenCalledWith('user-1', PREPAID_EXPIRING_TYPE, {
      key: `sub-1:${end.toISOString()}:D-3`,
      reason: 'Tu plan Pro (acceso de 30 días) vence en 3 días. Renueva en theaimodelab.com/pricing y sigue creando sin pausa.',
      milestone: 'D-3',
      subscriptionId: 'sub-1',
      planSlug: 'pro-30d',
      currentPeriodEnd: end.toISOString(),
      url: 'https://www.theaimodelab.com/es/pricing',
    });
  });

  it('D-1 com "1 dia" e locale padrão pt-BR', async () => {
    const end = new Date(now.getTime() + 20 * HOUR);
    const { service, notifications } = make({
      expiring: [sub({ currentPeriodEnd: end, user: { locale: 'pt-BR', country: null } })],
    });
    await service.run(now);
    const [, type, data] = (notifications.create.mock.calls as any[][])[0];
    expect(type).toBe(PREPAID_EXPIRING_TYPE);
    expect(data.milestone).toBe('D-1');
    expect(data.reason).toContain('vence em 1 dia.');
  });

  it('não repete o mesmo marco (reserva em email_sequence_logs, que o Limpar do sino não apaga)', async () => {
    const end = new Date(now.getTime() + 60 * HOUR);
    const { service, notifications } = make({
      expiring: [sub({ currentPeriodEnd: end })],
      existingKeys: [`sub-1:${end.toISOString()}:D-3`],
    });
    const result = await service.run(now);
    expect(result.created).toBe(0);
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('reserva por conta + chave; se a notificação falha, libera a reserva', async () => {
    const end = new Date(now.getTime() + 60 * HOUR);
    const ok = make({ expiring: [sub({ currentPeriodEnd: end })] });
    await ok.service.run(now);
    expect(ok.prisma.emailSequenceLog.create).toHaveBeenCalledWith({
      data: { userId: 'user-1', sequence: 'prepaid_notice', emailKey: `prepaid_notice:sub-1:${end.toISOString()}:D-3` },
      select: { id: true },
    });
    expect(ok.prisma.emailSequenceLog.delete).not.toHaveBeenCalled();

    const failing = make({ expiring: [sub({ currentPeriodEnd: end })], notifyFails: true });
    const result = await failing.service.run(now);
    expect(result.created).toBe(0);
    expect(failing.prisma.emailSequenceLog.delete).toHaveBeenCalledWith({ where: { id: 'claim-1' } });
  });

  it('D0: vencido pelo cron recebe prepaid-expired (inglês)', async () => {
    const end = new Date(now.getTime() - 2 * HOUR);
    const { service, notifications } = make({
      ended: [sub({ status: 'CANCELED', currentPeriodEnd: end, updatedAt: new Date(end.getTime() + HOUR), user: { locale: 'en-US', country: null } })],
    });
    await service.run(now);
    const [userId, type, data] = (notifications.create.mock.calls as any[][])[0];
    expect(userId).toBe('user-1');
    expect(type).toBe(PREPAID_EXPIRED_TYPE);
    expect(data.key).toBe(`sub-1:${end.toISOString()}:D0`);
    expect(data.reason).toBe('Your Pro plan (30-day access) has expired. Renew at theaimodelab.com/pricing: your models are waiting for you.');
  });

  it('D0 não vai para estorno nem para quem já tem outra assinatura ativa', async () => {
    const end = new Date(now.getTime() - 2 * HOUR);
    const refunded = sub({ status: 'CANCELED', currentPeriodEnd: end, updatedAt: new Date(end.getTime() - 5 * 24 * HOUR) });
    const a = make({ ended: [refunded] });
    await a.service.run(now);
    expect(a.notifications.create).not.toHaveBeenCalled();

    const expired = sub({ status: 'CANCELED', currentPeriodEnd: end, updatedAt: new Date(end.getTime() + HOUR) });
    const b = make({ ended: [expired], otherActive: true });
    await b.service.run(now);
    expect(b.notifications.create).not.toHaveBeenCalled();
  });

  it('PREPAID_NOTICES=off: o cron não roda', async () => {
    process.env.PREPAID_NOTICES = 'off';
    const { service, findMany, notifications } = make({ expiring: [sub({})] });
    await service.handleNotices();
    expect(findMany).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });
});
