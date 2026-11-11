import { Logger } from '@nestjs/common';
import { ContentSafetyService } from '../content-safety.service';
import { PrismaService } from '../../prisma/prisma.service';

interface AccountRow {
  imageDeclarationAt: Date | null;
  imageDeclarationVersion: string | null;
}

/** Banco em memória: só o que a declaração da conta usa, respeitando a condição do updateMany. */
function fakePrisma(rows: Record<string, AccountRow>) {
  return {
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = rows[where.id];
        return row ? { imageDeclarationAt: row.imageDeclarationAt, imageDeclarationVersion: row.imageDeclarationVersion } : null;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string; imageDeclarationAt?: null }; data: AccountRow }) => {
        const row = rows[where.id];
        if (!row) return { count: 0 };
        if ('imageDeclarationAt' in where && row.imageDeclarationAt !== null) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  };
}

function serviceOver(prisma: ReturnType<typeof fakePrisma>): ContentSafetyService {
  return new ContentSafetyService(prisma as unknown as PrismaService);
}

const SEM_DECLARACAO = (): AccountRow => ({ imageDeclarationAt: null, imageDeclarationVersion: null });

/**
 * Declaração de responsabilidade pelas imagens lida pelo ContentSafetyService (o que o interceptor usa). O service
 * só lê: quem grava é o POST /users/me/image-declaration.
 * O ponto delicado é a memória: a cliente que acabou de declarar não pode levar 400 no pedido seguinte.
 */
describe('ContentSafetyService: declaração de imagens da conta', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('accountImageDeclaration (leitura)', () => {
    it('o "não" nunca fica em memória: quem declara logo depois (pela rota, até em outra instância) passa no pedido seguinte', async () => {
      const rows = { 'user-1': SEM_DECLARACAO() };
      const prisma = fakePrisma(rows);
      const service = serviceOver(prisma);

      expect(await service.accountImageDeclaration('user-1')).toBeNull();
      expect(await service.accountImageDeclaration('user-1')).toBeNull();
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);

      // a declaração é gravada por fora deste service (POST /users/me/image-declaration, outra instância da API)
      rows['user-1'] = { imageDeclarationAt: new Date('2026-11-06T15:00:00.000Z'), imageDeclarationVersion: '2026-11-06' };

      expect(await service.accountImageDeclaration('user-1')).toEqual({ version: '2026-11-06' });
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(3);
    });

    it('o "sim" fica em memória (a declaração nunca é desfeita): os pedidos seguintes não vão ao banco', async () => {
      const prisma = fakePrisma({
        'user-1': { imageDeclarationAt: new Date('2026-11-06T15:00:00.000Z'), imageDeclarationVersion: '2026-11-06' },
      });
      const service = serviceOver(prisma);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(await service.accountImageDeclaration('user-1')).toEqual({ version: '2026-11-06' });
      }
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        select: { imageDeclarationAt: true, imageDeclarationVersion: true },
      });
    });

    it('a memória é por conta: uma conta declarada não libera outra', async () => {
      const prisma = fakePrisma({
        'user-1': { imageDeclarationAt: new Date('2026-11-06T15:00:00.000Z'), imageDeclarationVersion: '2026-11-06' },
        'user-2': SEM_DECLARACAO(),
      });
      const service = serviceOver(prisma);
      expect(await service.accountImageDeclaration('user-1')).toEqual({ version: '2026-11-06' });
      expect(await service.accountImageDeclaration('user-2')).toBeNull();
    });

    it('pedido sem usuário ou conta que não existe: "não", sem lançar', async () => {
      const prisma = fakePrisma({});
      const service = serviceOver(prisma);
      expect(await service.accountImageDeclaration(null)).toBeNull();
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(await service.accountImageDeclaration('fantasma')).toBeNull();
    });

    it('banco fora: responde "não" (vale a regra do campo no pedido) e não lança', async () => {
      const prisma = fakePrisma({ 'user-1': SEM_DECLARACAO() });
      prisma.user.findUnique.mockRejectedValueOnce(new Error('banco fora'));
      const service = serviceOver(prisma);
      await expect(service.accountImageDeclaration('user-1')).resolves.toBeNull();
    });
  });

  it('o service só lê a declaração: nenhuma leitura escreve na conta e não existe mais gravação a partir do pedido', async () => {
    const rows = { 'user-1': SEM_DECLARACAO() };
    const prisma = fakePrisma(rows);
    const service = serviceOver(prisma);
    await service.accountImageDeclaration('user-1');
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(rows['user-1']).toEqual(SEM_DECLARACAO());
    expect('rememberImageDeclaration' in service).toBe(false);
  });
});
