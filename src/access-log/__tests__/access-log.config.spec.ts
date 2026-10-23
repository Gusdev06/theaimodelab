import { Logger } from '@nestjs/common';
import {
  accessLogConfigProvider,
  DEFAULT_SOURCE_PORT_HEADER,
  loadAccessLogConfig,
  MIN_RETENTION_MONTHS,
  NO_TRUSTED_PROXY_ALERT,
  type AccessLogConfig,
} from '../access-log.config';
import { TRUST_NO_PROXY } from '../client-address';

function load(values: Record<string, string>) {
  return loadAccessLogConfig((key) => values[key]);
}

describe('loadAccessLogConfig', () => {
  it('padrão: nenhum proxy (o main.ts não mexe no Express), porta x-real-port, guarda de 6 meses', () => {
    const { config, warnings } = load({});
    expect(config.trust).toBe(TRUST_NO_PROXY);
    expect(config.trustConfigured).toBe(false);
    expect(config.sourcePortHeader).toBe(DEFAULT_SOURCE_PORT_HEADER);
    expect(config.retentionMonths).toBe(MIN_RETENTION_MONTHS);
    expect(config.summary).toMatch(/nenhum/);
    expect(warnings).toEqual([]);
  });

  it('saltos', () => {
    const { config } = load({ TRUSTED_PROXY_HOPS: '2' });
    expect(config.trustConfigured).toBe(true);
    expect(config.trust('192.0.2.1', 1)).toBe(true);
    expect(config.trust('192.0.2.1', 2)).toBe(false);
    expect(config.summary).toMatch(/saltos=2/);
  });

  it('lista e saltos juntos', () => {
    const { config } = load({
      TRUSTED_PROXY_HOPS: '1',
      TRUSTED_PROXY_IPS: 'loopback',
    });
    expect(config.trust('127.0.0.1', 0)).toBe(true);
    expect(config.trust('192.0.2.1', 0)).toBe(false);
    expect(config.summary).toMatch(/saltos=1 lista=loopback/);
  });

  it('valores inválidos: avisa e não confia em ninguém (nunca abre o cabeçalho por engano)', () => {
    const { config, warnings } = load({
      TRUSTED_PROXY_HOPS: 'dois',
      TRUSTED_PROXY_IPS: 'banana',
      ACCESS_LOG_PORT_HEADER: 'x real port',
      ACCESS_LOG_RETENTION_MONTHS: '3',
    });
    expect(config.trustConfigured).toBe(false);
    expect(config.sourcePortHeader).toBe(DEFAULT_SOURCE_PORT_HEADER);
    expect(config.retentionMonths).toBe(MIN_RETENTION_MONTHS);
    expect(warnings.length).toBeGreaterThanOrEqual(4);
  });

  it('saltos acima do teto: recusado', () => {
    const { config, warnings } = load({ TRUSTED_PROXY_HOPS: '11' });
    expect(config.trustConfigured).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  it('guarda maior que 6 meses é aceita (a autoridade pode pedir mais)', () => {
    expect(
      load({ ACCESS_LOG_RETENTION_MONTHS: '12' }).config.retentionMonths,
    ).toBe(12);
  });

  it('x-forwarded-port como porta: aceito com aviso (por convenção é a porta de destino)', () => {
    const { config, warnings } = load({
      ACCESS_LOG_PORT_HEADER: 'X-Forwarded-Port',
    });
    expect(config.sourcePortHeader).toBe('x-forwarded-port');
    expect(warnings.join(' ')).toMatch(/destino/);
  });
});

describe('accessLogConfigProvider: aviso de proxy no boot', () => {
  const factory = accessLogConfigProvider as unknown as {
    useFactory: (configService: unknown) => AccessLogConfig;
  };
  const boot = (values: Record<string, string>) =>
    factory.useFactory({ get: (key: string) => values[key] });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sem proxy declarado: erro a cada boot, em qualquer NODE_ENV (o registro gravaria o IP do proxy)', () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    for (const nodeEnv of ['production', 'development']) {
      expect(boot({ NODE_ENV: nodeEnv }).trustConfigured).toBe(false);
    }
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(NO_TRUSTED_PROXY_ALERT);
    expect(NO_TRUSTED_PROXY_ALERT).toMatch(/TRUSTED_PROXY_HOPS/);
  });

  it('com proxy declarado: sem erro', () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    expect(boot({ TRUSTED_PROXY_HOPS: '2' }).trustConfigured).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });
});
