import { Logger, UnauthorizedException } from '@nestjs/common';
import { HublaWebhookService } from '../hubla-webhook.service';

/**
 * TKT-036: o webhook da Hubla aceitava qualquer POST. Um "invoice.paid" com um e-mail qualquer criava acesso de
 * graça. Agora exige HUBLA_WEBHOOK_TOKEN (?token= ou header x-hubla-token) e, sem o env, recusa tudo (fail-closed).
 */
function build(token: string | undefined) {
  const config = { get: jest.fn((key: string) => (key === 'HUBLA_WEBHOOK_TOKEN' ? token : undefined)) };
  const pending = { createPending: jest.fn(async () => ({ created: true })) };
  const logs = { create: jest.fn(async () => ({ id: 'log-1' })) };
  return { service: new HublaWebhookService(config as any, pending as any, logs as any), pending, logs };
}

const paid = { type: 'invoice.paid', data: { user: { email: 'golpe@mail.com' }, id: 'evt_1' } };

describe('Hubla · token obrigatório', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('sem HUBLA_WEBHOOK_TOKEN no env, recusa e não cria acesso', async () => {
    const { service, pending, logs } = build(undefined);
    await expect(service.handle(paid, {}, 'qualquer')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(pending.createPending).not.toHaveBeenCalled();
    expect(logs.create).not.toHaveBeenCalled();
  });

  it('token errado ou ausente é recusado', async () => {
    const { service, pending } = build('tok-certo-123');
    await expect(service.handle(paid, {}, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.handle(paid, { 'x-hubla-token': 'tok-errado-12' }, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(pending.createPending).not.toHaveBeenCalled();
  });

  it('token certo na query ou no header processa como antes', async () => {
    const { service, pending } = build('tok-certo-123');
    await expect(service.handle(paid, {}, 'tok-certo-123')).resolves.toEqual({ processed: true });
    await expect(service.handle(paid, { 'x-hubla-token': 'tok-certo-123' }, undefined)).resolves.toEqual({ processed: true });
    expect(pending.createPending).toHaveBeenCalledTimes(2);
  });
});
