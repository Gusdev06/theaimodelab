import { WorkerHost } from '@nestjs/bullmq';
import { InflightRunsService } from '../inflight-runs.service';
import { GracefulShutdownService, resolveDrainMs } from '../graceful-shutdown.service';

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('InflightRunsService', () => {
  it('tira a execução do registro quando termina, com sucesso ou erro', async () => {
    const service = new InflightRunsService();
    const ok = deferred<string>();
    const fail = deferred<string>();
    service.track('a', ok.promise);
    service.track('b', fail.promise).catch(() => undefined);
    expect(service.size).toBe(2);

    ok.resolve('x');
    fail.reject(new Error('falhou'));
    await Promise.allSettled([ok.promise, fail.promise]);
    await Promise.resolve();
    expect(service.size).toBe(0);
  });

  it('drain espera as execuções, inclusive as que começam durante a espera', async () => {
    const service = new InflightRunsService();
    const first = deferred();
    const second = deferred();
    service.track('primeira', first.promise);

    const draining = service.drain(Date.now() + 5_000);
    service.track('segunda', second.promise);
    first.resolve();
    await new Promise((r) => setTimeout(r, 10));
    second.resolve();

    await expect(draining).resolves.toBe(0);
  });

  it('drain para no prazo e devolve quantas ficaram rodando', async () => {
    const service = new InflightRunsService();
    service.track('travada', new Promise(() => undefined));
    await expect(service.drain(Date.now() + 30)).resolves.toBe(1);
  });
});

describe('resolveDrainMs', () => {
  it('usa o padrão quando a env falta ou é inválida', () => {
    expect(resolveDrainMs(undefined)).toBe(270_000);
    expect(resolveDrainMs('abc')).toBe(270_000);
    expect(resolveDrainMs('-5')).toBe(270_000);
  });

  it('aceita um valor numérico da env', () => {
    expect(resolveDrainMs('60000')).toBe(60_000);
    expect(resolveDrainMs('0')).toBe(0);
  });
});

describe('GracefulShutdownService', () => {
  const originalEnv = process.env.SHUTDOWN_DRAIN_MS;
  afterEach(() => {
    process.env.SHUTDOWN_DRAIN_MS = originalEnv;
  });

  class FakeHost extends WorkerHost {
    constructor(private readonly fakeWorker: unknown) {
      super();
    }
    get worker() {
      if (!this.fakeWorker) throw new Error('not initialized');
      return this.fakeWorker as WorkerHost['worker'];
    }
    async process(): Promise<void> {
      return undefined;
    }
  }

  const discoveryWith = (instances: unknown[]) =>
    ({ getProviders: () => instances.map((instance) => ({ instance })) }) as never;

  it('fecha os workers da fila e espera as execuções diretas', async () => {
    process.env.SHUTDOWN_DRAIN_MS = '5000';
    const closeWorker = deferred();
    const worker = { close: jest.fn(() => closeWorker.promise) };
    const runs = new InflightRunsService();
    const direct = deferred();
    runs.track('image:g1', direct.promise);

    const service = new GracefulShutdownService(
      discoveryWith([new FakeHost(worker), new FakeHost(undefined), { other: true }]),
      runs,
    );
    let finished = false;
    const shutdown = service.onModuleDestroy().then(() => {
      finished = true;
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);

    closeWorker.resolve();
    direct.resolve();
    await shutdown;
    expect(finished).toBe(true);
  });

  it('não passa do prazo quando um worker não fecha', async () => {
    process.env.SHUTDOWN_DRAIN_MS = '50';
    const worker = { close: jest.fn(() => new Promise(() => undefined)) };
    const service = new GracefulShutdownService(
      discoveryWith([new FakeHost(worker)]),
      new InflightRunsService(),
    );
    const startedAt = Date.now();
    await service.onModuleDestroy();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe('injeção do Nest', () => {
  it('monta o GracefulShutdownService com DiscoveryModule e o módulo global', async () => {
    const { Test } = await import('@nestjs/testing');
    const { DiscoveryModule } = await import('@nestjs/core');
    const { InflightRunsModule } = await import('../inflight-runs.module');
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule, InflightRunsModule],
      providers: [GracefulShutdownService],
    }).compile();
    expect(moduleRef.get(GracefulShutdownService)).toBeInstanceOf(GracefulShutdownService);
    await moduleRef.close();
  });
});
