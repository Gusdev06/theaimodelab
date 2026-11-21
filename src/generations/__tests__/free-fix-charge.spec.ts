import { GenerationStatus, Resolution } from '@prisma/client';
import { GenerationsService } from '../generations.service';
import type { GenerateImageDto } from '../dto/generate-image.dto';

/**
 * Cobrança da 1ª correção grátis do Unlocked em generate-image: elegível = nada debitado e o vínculo
 * fica em parameters; não elegível = cobra normal sem erro; perdeu a corrida = cobra normal.
 */
describe('GenerationsService · cobrança da 1ª correção grátis do Unlocked', () => {
  const COST = 40;

  function harness(opts: { eligible: boolean; claimed?: boolean }) {
    const prisma = {
      generation: {
        create: jest.fn(async (args: any) => ({ id: 'gen-new', ...args.data })),
        update: jest.fn(async () => ({})),
      },
    };
    const freeFix = {
      checkEligibility: jest.fn(async () =>
        opts.eligible
          ? { eligible: true, reason: null }
          : { eligible: false, reason: 'daily_limit' },
      ),
      confirmClaim: jest.fn(async () => opts.claimed ?? true),
    };
    const creditsService = {
      getBalance: jest.fn(async () => ({ totalCreditsAvailable: 5_000 })),
      debit: jest.fn(async () => undefined),
      hasFreeGeneration: jest.fn(async () => false),
    };
    const plansService = { calculateGenerationCost: jest.fn(async () => COST) };
    const modelsService = {
      assertActiveBySlug: jest.fn(async () => undefined),
    };
    const generationProcessor = {
      runImageJobDirectly: jest.fn(async () => undefined),
    };
    const service = Object.assign(Object.create(GenerationsService.prototype), {
      prisma,
      freeFix,
      creditsService,
      plansService,
      modelsService,
      generationProcessor,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    }) as GenerationsService;
    return { service, prisma, freeFix, creditsService, generationProcessor };
  }

  const dto = (): GenerateImageDto =>
    ({
      prompt: 'fix the left hand',
      model: 'sem-censura',
      resolution: Resolution.RES_2K,
      aspect_ratio: '9:16',
      mime_type: 'image/png',
      fix_of_generation_id: 'gen-origem',
    }) as GenerateImageDto;

  // a tela manda a correção por generate-image-auto (generateImageWithFallback): os 2 caminhos são cobertos
  describe.each(['generateImage', 'generateImageWithFallback'] as const)('%s', (metodo) => {
    it('elegível: 0 créditos, nada debitado, vínculo freeFixOf gravado', async () => {
      const h = harness({ eligible: true });
      const result = await h.service[metodo]('u-1', dto());

      expect(result).toEqual({
        id: 'gen-new',
        status: GenerationStatus.PROCESSING,
        creditsConsumed: 0,
      });
      const created = h.prisma.generation.create.mock.calls[0][0].data;
      expect(created.creditsConsumed).toBe(0);
      expect(created.usedFreeGeneration).toBe(false);
      expect(created.parameters).toMatchObject({
        freeFix: true,
        freeFixOf: 'gen-origem',
      });
      expect(h.creditsService.debit).not.toHaveBeenCalled();
      expect(h.freeFix.confirmClaim).toHaveBeenCalledWith(
        'u-1',
        'gen-new',
        'gen-origem',
      );
      expect(h.generationProcessor.runImageJobDirectly).toHaveBeenCalledWith(
        expect.objectContaining({
          creditsConsumed: 0,
          usedFreeGeneration: false,
        }),
      );
    });

    it('não elegível: cobra normal, sem erro e sem vínculo', async () => {
      const h = harness({ eligible: false });
      const result = await h.service[metodo]('u-1', dto());

      expect(result.creditsConsumed).toBe(COST);
      const created = h.prisma.generation.create.mock.calls[0][0].data;
      expect(created.parameters).not.toHaveProperty('freeFix');
      expect(h.creditsService.debit).toHaveBeenCalledWith(
        'u-1',
        COST,
        'GENERATION_DEBIT',
        'gen-new',
        expect.any(String),
      );
    });

    it('perdeu a corrida para outro pedido: tira o vínculo e cobra normal', async () => {
      const h = harness({ eligible: true, claimed: false });
      const result = await h.service[metodo]('u-1', dto());

      expect(result.creditsConsumed).toBe(COST);
      const update = (h.prisma.generation.update.mock.calls[0] as any[])[0];
      expect(update.data.creditsConsumed).toBe(COST);
      expect(update.data.parameters).not.toHaveProperty('freeFix');
      expect(update.data.parameters).not.toHaveProperty('freeFixOf');
      expect(h.creditsService.debit).toHaveBeenCalledWith(
        'u-1',
        COST,
        'GENERATION_DEBIT',
        'gen-new',
        expect.any(String),
      );
    });

    it('sem fix_of_generation_id: nem consulta a correção grátis', async () => {
      const h = harness({ eligible: true });
      const plain = dto();
      delete plain.fix_of_generation_id;
      await h.service[metodo]('u-1', plain);
      expect(h.freeFix.checkEligibility).not.toHaveBeenCalled();
      expect(h.creditsService.debit).toHaveBeenCalled();
    });
  });
});
