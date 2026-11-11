import { Logger, UnauthorizedException } from '@nestjs/common';
import { PerfectpayWebhookService } from '../perfectpay-webhook.service';

/**
 * Postback recusado pelo token (TKT-177): antes só virava linha de log e a Perfect Pay pausava o webhook sem ninguém
 * saber. Agora fica em webhook_logs como `rejected_token`, sem dado pessoal nem o token, e a resposta segue 401.
 */
function build(webhookLogs: { create: jest.Mock; markFailed: jest.Mock }) {
  const config = { get: jest.fn((key: string) => (key === 'PERFECTPAY_WEBHOOK_TOKEN' ? 'tok-certo' : undefined)) };
  return new PerfectpayWebhookService(
    config as any,
    { createPending: jest.fn() } as any,
    webhookLogs as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
}

const sale = {
  token: 'tok-errado',
  code: 'PPSALE7',
  sale_status_enum: 2,
  sale_status_enum_key: 'approved',
  customer: { email: 'compradora@mail.com', identification_number: '12345678900', phone_number: '11999999999' },
  product: { code: 'PPPROD1' },
  plan: { code: 'PPPLAN1' },
};

describe('Perfect Pay · token recusado', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('grava rejected_token sem dado pessoal nem token e continua respondendo 401', async () => {
    const webhookLogs = { create: jest.fn(async () => ({ id: 'log-1' })), markFailed: jest.fn(async () => undefined) };
    const service = build(webhookLogs);

    await expect(service.handle(sale)).rejects.toBeInstanceOf(UnauthorizedException);

    expect(webhookLogs.create).toHaveBeenCalledWith('perfectpay', 'rejected_token', 'perfectpay-sale-PPSALE7-2', {
      saleCode: 'PPSALE7',
      productCode: 'PPPROD1',
      planCode: 'PPPLAN1',
      saleStatus: 'approved',
    });
    const stored = JSON.stringify((webhookLogs.create.mock.calls[0] as unknown[])[3]);
    expect(stored).not.toContain('compradora@mail.com');
    expect(stored).not.toContain('12345678900');
    expect(stored).not.toContain('tok-errado');
    expect(webhookLogs.markFailed).toHaveBeenCalledWith('log-1', 'Invalid Perfectpay token');
  });

  it('falha ao gravar o registro não troca o 401 por outro erro', async () => {
    const webhookLogs = {
      create: jest.fn(async () => {
        throw new Error('banco fora');
      }),
      markFailed: jest.fn(),
    };
    const service = build(webhookLogs);

    await expect(service.handle(sale)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(webhookLogs.markFailed).not.toHaveBeenCalled();
  });
});
