import { ModelsService } from '../models.service';
import { TALKING_AVATAR_MODEL, TALKING_AVATAR_SLUG } from '../../generations/talking-avatar.constants';

/** O seed não roda em produção: as linhas dos modelos novos nascem no boot, desligadas, sem tocar no interruptor do admin. */
describe('ModelsService.onModuleInit', () => {
  it('garante a linha do avatar falante desligada e não sobrescreve a existente', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const service = new ModelsService({ aiModel: { upsert } } as never);
    await service.onModuleInit();
    const call = upsert.mock.calls.map(([args]) => args).find((args) => args.where.slug === TALKING_AVATAR_SLUG);
    expect(call).toBeDefined();
    expect(call.update).toEqual({});
    expect(call.create).toMatchObject({
      slug: TALKING_AVATAR_SLUG,
      modelVariant: TALKING_AVATAR_MODEL,
      type: 'VIDEO',
      provider: 'WAVESPEED',
      isActive: false,
    });
  });

  it('uma falha no banco só registra aviso e não derruba o boot', async () => {
    const upsert = jest.fn().mockRejectedValue(new Error('db down'));
    const service = new ModelsService({ aiModel: { upsert } } as never);
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });
});
