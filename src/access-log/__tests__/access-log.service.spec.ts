import { Logger } from '@nestjs/common';
import {
  AccessLogService,
  MAX_IN_FLIGHT_WRITES,
  MAX_USER_AGENT_LENGTH,
  cleanHeaderText,
  toAccessLogRow,
  type AccessLogEntry,
} from '../access-log.service';

/** Gravação do registro de acesso: fora do caminho da resposta, validada, sem nunca lançar. Banco simulado. */

const USER_ID = 'cmusr0000000000000000001a';
const AT = new Date('2026-10-22T15:04:05.123Z');

function entry(overrides: Partial<AccessLogEntry> = {}): AccessLogEntry {
  return {
    userId: USER_ID,
    route: 'POST /api/v1/auth/login',
    generationId: null,
    ip: '203.0.113.7',
    port: 51234,
    userAgent: 'Mozilla/5.0 (teste)',
    at: AT,
    ...overrides,
  };
}

function setup() {
  const prisma = {
    accessLog: {
      create: jest.fn(async () => ({ id: 'x' })),
      createMany: jest.fn(async (args: { data: unknown[] }) => ({
        count: args.data.length,
      })),
    },
  };
  const service = new AccessLogService(prisma as never);
  return { prisma, service };
}

describe('toAccessLogRow', () => {
  it('linha completa, com o horário do pedido (UTC no banco)', () => {
    expect(toAccessLogRow(entry())).toEqual({
      userId: USER_ID,
      route: 'POST /api/v1/auth/login',
      generationId: null,
      ip: '203.0.113.7',
      port: 51234,
      userAgent: 'Mozilla/5.0 (teste)',
      createdAt: AT,
    });
  });

  it('valida tudo de novo: IP, porta, ids, user agent e rota', () => {
    const row = toAccessLogRow(
      entry({
        userId: 'não é id',
        generationId: '../../etc',
        ip: '::ffff:203.0.113.7',
        port: 70000,
        userAgent: `UA\r\nX-Injetado: 1\u0000${'a'.repeat(1000)}`,
        route: '',
        at: new Date('data inválida'),
      }),
    );
    expect(row.userId).toBeNull();
    expect(row.generationId).toBeNull();
    expect(row.ip).toBe('203.0.113.7');
    expect(row.port).toBeNull();
    expect(row.userAgent).toHaveLength(MAX_USER_AGENT_LENGTH);
    expect(row.userAgent).not.toMatch(/[\r\n\u0000]/);
    expect(row.route).toBe('desconhecida');
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(Number.isFinite((row.createdAt as Date).getTime())).toBe(true);
  });

  it('IP que não é IP vira null', () => {
    expect(toAccessLogRow(entry({ ip: 'unknown' })).ip).toBeNull();
  });
});

describe('cleanHeaderText', () => {
  it('vazio ou só controle vira null', () => {
    expect(cleanHeaderText('', 10)).toBeNull();
    expect(cleanHeaderText('\u0000\u0007', 10)).toBeNull();
    expect(cleanHeaderText(undefined, 10)).toBeNull();
  });
});

describe('AccessLogService', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('um acesso: create, sem esperar a gravação', async () => {
    const { prisma, service } = setup();
    expect(service.record(entry())).toBeUndefined();
    await service.flush();
    expect(prisma.accessLog.create).toHaveBeenCalledWith({
      data: toAccessLogRow(entry()),
    });
    expect(prisma.accessLog.createMany).not.toHaveBeenCalled();
  });

  it('vários acessos (agente com várias gerações): createMany numa ida só', async () => {
    const { prisma, service } = setup();
    service.record([
      entry({ generationId: 'cmgen0000000000000000001a' }),
      entry({ generationId: 'cmgen0000000000000000002b' }),
    ]);
    await service.flush();
    expect(prisma.accessLog.createMany).toHaveBeenCalledTimes(1);
    expect(
      (
        prisma.accessLog.createMany.mock.calls[0] as unknown as [
          { data: unknown[] },
        ]
      )[0].data,
    ).toHaveLength(2);
  });

  it('lista vazia: nada a fazer', async () => {
    const { prisma, service } = setup();
    service.record([]);
    await service.flush();
    expect(prisma.accessLog.create).not.toHaveBeenCalled();
  });

  it('banco fora: não lança e o aviso tem só o código do erro (nunca IP nem user agent)', async () => {
    const { prisma, service } = setup();
    prisma.accessLog.create.mockRejectedValueOnce(
      Object.assign(
        new Error('Invalid invocation: ip "203.0.113.7" user agent Mozilla'),
        { code: 'P1001' },
      ),
    );
    expect(() => service.record(entry())).not.toThrow();
    await service.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toMatch(/P1001/);
    expect(message).not.toMatch(/203\.0\.113\.7|Mozilla/);
  });

  it('avisos de falha: no máximo um por minuto', async () => {
    const { prisma, service } = setup();
    prisma.accessLog.create.mockRejectedValue(
      Object.assign(new Error('x'), { code: 'P1001' }),
    );
    for (let index = 0; index < 5; index++) service.record(entry());
    await service.flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('enxurrada: acima do teto de gravações em andamento, descarta com aviso em vez de empilhar', async () => {
    const { prisma, service } = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    prisma.accessLog.create.mockImplementation(async () => {
      await gate;
      return { id: 'x' };
    });
    for (let index = 0; index < MAX_IN_FLIGHT_WRITES + 3; index++)
      service.record(entry());
    expect(prisma.accessLog.create).toHaveBeenCalledTimes(MAX_IN_FLIGHT_WRITES);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/descartado\(s\) por excesso/),
    );
    release();
    await service.flush();
    service.record(entry());
    expect(prisma.accessLog.create).toHaveBeenCalledTimes(
      MAX_IN_FLIGHT_WRITES + 1,
    );
    await service.flush();
  });

  it('desligamento: espera a gravação em andamento (com teto de tempo)', async () => {
    const { prisma, service } = setup();
    let done = false;
    prisma.accessLog.create.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      done = true;
      return { id: 'x' };
    });
    service.record(entry());
    await service.beforeApplicationShutdown();
    expect(done).toBe(true);
  });

  it('gravação que não termina não segura o desligamento além do teto', async () => {
    const { prisma, service } = setup();
    prisma.accessLog.create.mockImplementation(
      () => new Promise(() => undefined),
    );
    service.record(entry());
    const started = Date.now();
    await service.flush(30);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
