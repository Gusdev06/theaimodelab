import { ConflictException } from '@nestjs/common';
import { AffiliatesService } from '../affiliates.service';

/**
 * O código de afiliado sai do nome que a pessoa escolhe. Sem esta trava, quem se cadastrasse com o nome igual ao
 * código de indicação de outro usuário viraria afiliado com esse código e passaria a receber comissão em dinheiro
 * por cada cadastro feito pelo link da vítima.
 */
describe('AffiliatesService · colisão com código de indicação', () => {
  function setup() {
    const prisma = {
      affiliate: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }: { data: { code: string } }) => ({ id: 'aff', code: data.code })),
      },
      referralCode: {
        findUnique: jest.fn(async ({ where }: { where: { code: string } }) =>
          where.code === 'K7Q3M9XP' ? { id: 'rc' } : null,
        ),
      },
      user: { findUnique: jest.fn().mockResolvedValue({ name: 'K7Q3M9XP', email: 'atacante@exemplo.test' }) },
    };
    const service = new AffiliatesService(prisma as never, {} as never, {} as never);
    return { service, prisma };
  }

  it('afiliado pelo próprio usuário pula o código que já é de indicação', async () => {
    const { service, prisma } = setup();
    const affiliate = await service.createForUser('atacante', { pixKey: 'x@exemplo.test', pixKeyType: 'EMAIL' } as never);
    expect(affiliate.code).not.toBe('K7Q3M9XP');
    expect(prisma.affiliate.create).toHaveBeenCalledTimes(1);
    expect(prisma.affiliate.create.mock.calls[0][0].data.code).not.toBe('K7Q3M9XP');
  });

  it('afiliado criado pelo admin com código de indicação existente dá conflito', async () => {
    const { service, prisma } = setup();
    await expect(service.create({ name: 'X', code: 'k7q3m9xp' } as never)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.affiliate.create).not.toHaveBeenCalled();
  });
});
