import {
  curiosityAbBucketFor,
  isCuriosityLockEligible,
  parseCuriosityMediaUrls,
  pickCuriosityMedia,
} from './curiosity-lock.rules';
import { CuriosityLockService } from './curiosity-lock.service';

function makeService(opts: { completed: number; paid?: boolean; paidSub?: boolean; env?: Record<string, string> }) {
  const prisma = {
    generation: { findMany: jest.fn().mockResolvedValue(Array.from({ length: opts.completed }, (_, i) => ({ id: `g${i}` }))) },
    payment: { findFirst: jest.fn().mockResolvedValue(opts.paid ? { id: 'p1' } : null) },
    subscription: { findFirst: jest.fn().mockResolvedValue(opts.paidSub ? { id: 's1' } : null) },
  };
  const config = { get: jest.fn((key: string) => opts.env?.[key]) };
  return new CuriosityLockService(prisma as never, config as never);
}

describe('paywall de curiosidade (L02)', () => {
  describe('elegibilidade', () => {
    it('nunca pagou + 1ª geração concluída = elegível', () => {
      expect(isCuriosityLockEligible({ completedGenerations: 1, everPaid: false, hasPaidPlan: false })).toBe(true);
    });
    it('sem geração concluída, ou já passou do 1º resultado = não', () => {
      expect(isCuriosityLockEligible({ completedGenerations: 0, everPaid: false, hasPaidPlan: false })).toBe(false);
      expect(isCuriosityLockEligible({ completedGenerations: 2, everPaid: false, hasPaidPlan: false })).toBe(false);
    });
    it('já pagou alguma vez, ou tem plano pago ativo = não', () => {
      expect(isCuriosityLockEligible({ completedGenerations: 1, everPaid: true, hasPaidPlan: false })).toBe(false);
      expect(isCuriosityLockEligible({ completedGenerations: 1, everPaid: false, hasPaidPlan: true })).toBe(false);
    });
  });

  describe('A/B (CURIOSITY_LOCK_REAL_VIDEO_PCT)', () => {
    it.each([undefined, null, '', '0', '-5', 'abc'])('pct %p = todo mundo na A (padrão)', (pct) => {
      for (let i = 0; i < 50; i += 1) expect(curiosityAbBucketFor(`user-${i}`, pct)).toBe('A');
    });
    it('100 = todo mundo no balde B; balde estável por conta', () => {
      expect(curiosityAbBucketFor('user-1', '100')).toBe('B');
      expect(curiosityAbBucketFor('user-7', '50')).toBe(curiosityAbBucketFor('user-7', '50'));
    });
  });

  describe('acervo (CURIOSITY_LOCK_MEDIA_URLS)', () => {
    it('só https entra', () => {
      expect(parseCuriosityMediaUrls('https://a.com/1.mp4, http://b.com/2.mp4 javascript:alert(1) https://c.com/3.mp4')).toEqual([
        'https://a.com/1.mp4',
        'https://c.com/3.mp4',
      ]);
    });
    it('mesma conta = mesma mídia; lista vazia = null', () => {
      const urls = ['https://a.com/1.mp4', 'https://a.com/2.mp4', 'https://a.com/3.mp4'];
      expect(pickCuriosityMedia('u1', urls)).toBe(pickCuriosityMedia('u1', urls));
      expect(urls).toContain(pickCuriosityMedia('u1', urls));
      expect(pickCuriosityMedia('u1', [])).toBeNull();
    });
  });

  describe('CuriosityLockService', () => {
    it('elegível: serve a variante A com a mídia do acervo', async () => {
      const service = makeService({ completed: 1, env: { CURIOSITY_LOCK_MEDIA_URLS: 'https://cdn.x/1.mp4' } });
      await expect(service.statusFor('u1')).resolves.toEqual({
        eligible: true,
        completedGenerations: 1,
        abBucket: 'A',
        variant: 'A',
        mediaUrl: 'https://cdn.x/1.mp4',
      });
    });
    it('balde B ainda serve a variante A (a B não foi construída)', async () => {
      const service = makeService({ completed: 1, env: { CURIOSITY_LOCK_REAL_VIDEO_PCT: '100' } });
      const status = await service.statusFor('u1');
      expect(status.abBucket).toBe('B');
      expect(status.variant).toBe('A');
    });
    it('quem já pagou não é elegível e não recebe mídia', async () => {
      const service = makeService({ completed: 1, paid: true, env: { CURIOSITY_LOCK_MEDIA_URLS: 'https://cdn.x/1.mp4' } });
      await expect(service.statusFor('u1')).resolves.toEqual(expect.objectContaining({ eligible: false, mediaUrl: null }));
    });
  });
});
