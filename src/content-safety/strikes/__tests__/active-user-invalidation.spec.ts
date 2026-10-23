import { Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import * as jwt from '../../../auth/strategies/jwt.strategy';
import {
  activeUserCache,
  invalidateActiveUser,
  setActiveUserBroadcast,
} from '../../../auth/strategies/jwt.strategy';
import {
  ACTIVE_USER_INVALIDATION_CHANNEL,
  ActiveUserInvalidationBus,
  attachActiveUserInvalidation,
} from '../active-user-invalidation';
import { strikesConfig } from './strikes.harness';

/**
 * Aviso entre instâncias (Redis simulado por um EventEmitter): suspender numa instância derruba a sessão aberta nas
 * outras sem esperar os 60 s do cache. Sem o aviso ligado, nada muda (só o processo).
 */

const USER = 'cmuser000000000000000001';

class FakeSubscriber extends EventEmitter {
  subscribe = jest.fn(async () => 1);
}

describe('aviso entre instâncias do JWT', () => {
  afterEach(() => {
    setActiveUserBroadcast(null);
    activeUserCache.invalidate(USER);
    jest.restoreAllMocks();
  });

  it('sem aviso ligado, invalidateActiveUser vale só para este processo (como antes)', async () => {
    await activeUserCache.resolve(USER, async () => true);
    expect(() => invalidateActiveUser(USER)).not.toThrow();
    const lookup = jest.fn(async () => false);
    await expect(activeUserCache.resolve(USER, lookup)).resolves.toBe(false);
  });

  it('ligado: publica o id no canal e o que chega no canal limpa o cache local', async () => {
    const publisher = { publish: jest.fn(async () => 1) };
    const subscriber = new FakeSubscriber();
    const detach = attachActiveUserInvalidation(publisher, subscriber);
    expect(subscriber.subscribe).toHaveBeenCalledWith(
      ACTIVE_USER_INVALIDATION_CHANNEL,
    );

    invalidateActiveUser(USER);
    expect(publisher.publish).toHaveBeenCalledWith(
      ACTIVE_USER_INVALIDATION_CHANNEL,
      USER,
    );

    // outra instância suspendeu: a sessão em cache aqui cai
    await activeUserCache.resolve(USER, async () => true);
    subscriber.emit('message', ACTIVE_USER_INVALIDATION_CHANNEL, USER);
    const lookup = jest.fn(async () => false);
    await expect(activeUserCache.resolve(USER, lookup)).resolves.toBe(false);
    expect(lookup).toHaveBeenCalledTimes(1);

    detach();
    publisher.publish.mockClear();
    invalidateActiveUser(USER);
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('mensagem de outro canal ou sem formato de id é ignorada; falha ao publicar não lança', async () => {
    const publisher = {
      publish: jest.fn(async () => {
        throw new Error('redis fora');
      }),
    };
    const subscriber = new FakeSubscriber();
    attachActiveUserInvalidation(publisher, subscriber);
    await activeUserCache.resolve(USER, async () => true);
    const invalidate = jest.spyOn(activeUserCache, 'invalidate');
    subscriber.emit('message', 'outro-canal', USER);
    subscriber.emit('message', ACTIVE_USER_INVALIDATION_CHANNEL, 'x; DROP');
    expect(invalidate).not.toHaveBeenCalled();
    expect(() => invalidateActiveUser(USER)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('o barramento não liga com o modo off nem sem REDIS_URL (nenhum Redis, nenhum aviso registrado)', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const register = jest.spyOn(jwt, 'setActiveUserBroadcast');
    const config = { get: jest.fn(() => undefined) };
    new ActiveUserInvalidationBus(
      strikesConfig('off'),
      config as never,
    ).onModuleInit();
    expect(config.get).not.toHaveBeenCalled();

    new ActiveUserInvalidationBus(
      strikesConfig('shadow'),
      config as never,
    ).onModuleInit();
    expect(config.get).toHaveBeenCalledWith('REDIS_URL');
    expect(register).not.toHaveBeenCalled();
  });
});
