import { WelcomeCreditsService, welcomeAbExtraFor } from '../welcome-credits.service';

/** A/B das boas-vindas (23/11): metade das contas novas ganha +50 para a 1ª foto sem censura 2K (235) caber. */
describe('A/B das boas-vindas', () => {
  const ids = Array.from({ length: 2000 }, (_, i) => `cmuser${i.toString(36).padStart(6, '0')}`);

  describe('welcomeAbExtraFor', () => {
    it('desligado (vazio, 0, inválido ou negativo) = 0 para todo mundo', () => {
      for (const pct of [undefined, null, '', '0', 'abc', '-10']) {
        expect(ids.every((id) => welcomeAbExtraFor(id, pct, '50') === 0)).toBe(true);
      }
    });

    it('100% = todo mundo leva o extra; extra vazio vale 50', () => {
      expect(ids.every((id) => welcomeAbExtraFor(id, '100', '') === 50)).toBe(true);
      expect(ids.every((id) => welcomeAbExtraFor(id, '100', undefined) === 50)).toBe(true);
      expect(ids.every((id) => welcomeAbExtraFor(id, '150', '35') === 35)).toBe(true);
    });

    it('extra inválido ou <= 0 desliga o teste', () => {
      expect(ids.every((id) => welcomeAbExtraFor(id, '50', '0') === 0)).toBe(true);
      expect(ids.every((id) => welcomeAbExtraFor(id, '50', 'x') === 0)).toBe(true);
    });

    it('50% divide perto de metade e o sorteio é fixo por conta', () => {
      const b = ids.filter((id) => welcomeAbExtraFor(id, '50', '50') === 50).length;
      expect(b / ids.length).toBeGreaterThan(0.44);
      expect(b / ids.length).toBeLessThan(0.56);
      for (const id of ids.slice(0, 50)) {
        expect(welcomeAbExtraFor(id, '50', '50')).toBe(welcomeAbExtraFor(id, '50', '50'));
      }
    });
  });

  describe('WelcomeCreditsService.grantIfEligible', () => {
    function setup(env: Record<string, string | undefined>, configured = 150) {
      const tx = {
        creditTransaction: { findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
        creditBalance: { upsert: jest.fn(async () => ({})) },
      };
      const prisma = {
        creditTransaction: { findFirst: jest.fn(async () => null) },
        $transaction: jest.fn(async (fn: any) => fn(tx)),
      };
      const config = { get: jest.fn((key: string) => env[key]) };
      const settings = { getInt: jest.fn(async () => configured) };
      const service = new WelcomeCreditsService(prisma as any, config as any, settings as any);
      jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
      return { service, tx };
    }

    it('teste desligado: concede só a base, como antes', async () => {
      const { service, tx } = setup({});
      await expect(service.grantIfEligible('cmuser000001')).resolves.toBe(150);
      expect((tx.creditTransaction.create.mock.calls as any[][])[0][0].data).toMatchObject({
        type: 'ONBOARDING_BONUS',
        amount: 150,
        description: WelcomeCreditsService.WELCOME_CREDITS_MARKER,
      });
    });

    it('variante B: base + extra numa transação só, com o mesmo marcador (idempotência intacta)', async () => {
      const { service, tx } = setup({ WELCOME_CREDITS_AB_PCT: '100', WELCOME_CREDITS_AB_EXTRA: '50' });
      await expect(service.grantIfEligible('cmuser000001')).resolves.toBe(200);
      expect(tx.creditTransaction.create).toHaveBeenCalledTimes(1);
      expect((tx.creditTransaction.create.mock.calls as any[][])[0][0].data).toMatchObject({
        amount: 200,
        description: WelcomeCreditsService.WELCOME_CREDITS_MARKER,
      });
      expect(tx.creditBalance.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { bonusCreditsRemaining: { increment: 200 } } }),
      );
    });

    it('boas-vindas desligadas no banco: o A/B não concede nada sozinho', async () => {
      const { service, tx } = setup({ WELCOME_CREDITS_AB_PCT: '100' }, 0);
      await expect(service.grantIfEligible('cmuser000001')).resolves.toBe(0);
      expect(tx.creditTransaction.create).not.toHaveBeenCalled();
    });

    it('a promessa do e-mail do código mostra o valor da variante', async () => {
      const { service } = setup({ WELCOME_CREDITS_AB_PCT: '100', WELCOME_CREDITS_AB_EXTRA: '50' });
      await expect(service.pendingAmountFor('cmuser000001')).resolves.toBe(200);
    });
  });
});
