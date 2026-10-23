import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { GenerationStatus, GenerationType } from '@prisma/client';
import { isRuleEnforced } from '../../content-safety/image-safety/image-safety.config';
import type { RuledInputVerdict } from '../../content-safety/image-safety/image-safety.rules';
import { LEGAL_HOLD_POST_REJECTION_REASON } from '../../users/account-erasure.service';
import { SAFETY_SUSPENSION_POST_REJECTION_REASON } from '../../content-safety/strikes/strikes.types';
import {
  COMMUNITY_MEDIA_NOT_ALLOWED,
  COMMUNITY_POST_UNDER_REVIEW,
  CommunityService,
} from '../community.service';
import {
  CDN,
  OTHER,
  OWNER,
  fakeDb,
  generation,
  heldEvent,
  makeUploads,
  post,
  type FakeGeneration,
  type FakePost,
} from './promoted-output.fixtures';

/**
 * Comunidade (passo 22): só saída promovida da própria conta vira post; o post sai do feed na hora em que a geração
 * vira IN_REVIEW ou ganha evidência (e volta se o revisor liberar); a fila do admin vem borrada e nunca com a mídia de
 * geração em revisão. Scanner simulado: nenhuma imagem real.
 */
describe('CommunityService · portas da CDN', () => {
  function setup(
    options: {
      generations?: FakeGeneration[];
      posts?: FakePost[];
      events?: ReturnType<typeof heldEvent>[];
      safety?: 'off' | 'shadow' | 'enforce';
      verdict?: Partial<RuledInputVerdict>;
    } = {},
  ) {
    const { prisma, db } = fakeDb({
      generations: options.generations ?? [],
      posts: options.posts ?? [],
      events: options.events ?? [],
    });
    const uploads = makeUploads();
    const notifications = { create: jest.fn(async () => undefined) };
    const mode = options.safety ?? 'off';
    const checkInput = jest.fn(
      async () =>
        ({
          verdict: 'CLEAN',
          ruleId: null,
          strength: 'NONE',
          ...options.verdict,
        }) as RuledInputVerdict,
    );
    const imageSafety = {
      imageEnabled: mode !== 'off',
      checkInput,
      actsOn: (verdict: RuledInputVerdict) =>
        verdict.verdict !== 'CLEAN' &&
        isRuleEnforced(
          {
            layer: 'image',
            ruleId: verdict.ruleId,
            strength: verdict.strength,
            cause: verdict.cause,
          },
          { imageMode: mode, textMode: 'off', enforceStrong: true },
        ),
    };
    const service = new CommunityService(
      prisma as never,
      notifications as never,
      uploads,
      imageSafety as never,
    );
    return { service, prisma, db, checkInput, notifications };
  }

  const imageGen = (id: string, overrides: Partial<FakeGeneration> = {}) =>
    generation(id, {
      type: GenerationType.TEXT_TO_IMAGE,
      file: 'output_0.png',
      mimeType: 'image/png',
      ...overrides,
    });

  describe('submit', () => {
    it('saída promovida da própria conta vira post pendente', async () => {
      const gen = imageGen('cimg0000000000000000000001');
      const ctx = setup({ generations: [gen] });
      const created = await ctx.service.submit(OWNER, { generationId: gen.id });
      expect(created).toMatchObject({
        status: 'PENDING',
        mediaUrl: gen.outputs[0].url,
        thumbnailUrl: gen.outputs[0].thumbnailUrl,
        generationId: gen.id,
      });
    });

    it('resultado fora do nosso bucket (URL do provedor gravada no banco) não vira post', async () => {
      const gen = imageGen('cimg0000000000000000000002');
      gen.outputs[0].url = 'https://cdn-do-provedor.exemplo/resultado.png';
      const ctx = setup({ generations: [gen] });
      await expect(
        ctx.service.submit(OWNER, { generationId: gen.id }),
      ).rejects.toMatchObject({
        response: { code: COMMUNITY_MEDIA_NOT_ALLOWED },
      });
      expect(ctx.prisma.communityPost.create).not.toHaveBeenCalled();
    });

    it('geração com evidência sem liberação não vira post', async () => {
      const gen = imageGen('cimg0000000000000000000003');
      const ctx = setup({ generations: [gen], events: [heldEvent(gen.id)] });
      await expect(
        ctx.service.submit(OWNER, { generationId: gen.id }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(ctx.prisma.communityPost.create).not.toHaveBeenCalled();
    });

    it('geração em revisão não vira post', async () => {
      const gen = imageGen('cimg0000000000000000000004', {
        status: GenerationStatus.IN_REVIEW,
      });
      const ctx = setup({ generations: [gen] });
      await expect(
        ctx.service.submit(OWNER, { generationId: gen.id }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('geração de outra conta: 403 e nada criado', async () => {
      const gen = imageGen('cimg0000000000000000000005', { userId: OTHER });
      const ctx = setup({ generations: [gen] });
      await expect(
        ctx.service.submit(OWNER, { generationId: gen.id }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(ctx.prisma.communityPost.create).not.toHaveBeenCalled();
    });

    it('outputUrl que não é da geração (URL livre): recusado', async () => {
      const gen = imageGen('cimg0000000000000000000006');
      const ctx = setup({ generations: [gen] });
      await expect(
        ctx.service.submit(OWNER, {
          generationId: gen.id,
          outputUrl: 'http://169.254.169.254/latest/meta-data/',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(ctx.prisma.communityPost.create).not.toHaveBeenCalled();
    });

    it('miniatura fora do nosso bucket não vai para o post', async () => {
      const gen = imageGen('cimg0000000000000000000007');
      gen.outputs[0].thumbnailUrl = 'https://rastreador.exemplo/pixel.gif';
      const ctx = setup({ generations: [gen] });
      const created = await ctx.service.submit(OWNER, { generationId: gen.id });
      expect(created.thumbnailUrl).toBeNull();
    });
  });

  describe('feed e leitura pública', () => {
    const visible = imageGen('cimg0000000000000000000010');
    const flagged = imageGen('cimg0000000000000000000011');

    const scenario = () => {
      const adminPost = post({
        generationId: null,
        mediaUrl: `${CDN}/inputs/admin/u/banner.png`,
      });
      const okPost = post({
        generationId: visible.id,
        mediaUrl: visible.outputs[0].url,
      });
      const flaggedPost = post({
        generationId: flagged.id,
        mediaUrl: flagged.outputs[0].url,
      });
      const ctx = setup({
        generations: [visible, { ...flagged, outputs: [...flagged.outputs] }],
        posts: [adminPost, okPost, flaggedPost],
      });
      return { ...ctx, adminPost, okPost, flaggedPost };
    };

    it('sem nada em revisão, o feed é o de antes', async () => {
      const ctx = scenario();
      const feed = await ctx.service.feed(OWNER);
      expect(feed.data.map((item) => item.id).sort()).toEqual(
        [ctx.adminPost.id, ctx.okPost.id, ctx.flaggedPost.id].sort(),
      );
      expect(feed.meta.total).toBe(3);
    });

    it('geração vira IN_REVIEW: o post sai na hora (post do admin, sem geração, continua) e volta quando liberada', async () => {
      const ctx = scenario();
      ctx.db.generations[1].status = GenerationStatus.IN_REVIEW;

      const during = await ctx.service.feed(OWNER);
      expect(during.data.map((item) => item.id).sort()).toEqual(
        [ctx.adminPost.id, ctx.okPost.id].sort(),
      );
      expect(during.meta.total).toBe(2);
      expect(JSON.stringify(during)).not.toContain(flagged.outputs[0].url);

      ctx.db.generations[1].status = GenerationStatus.COMPLETED;
      const after = await ctx.service.feed(OWNER);
      expect(after.meta.total).toBe(3);
    });

    it('evidência sem liberação também tira do feed, do perfil, do link e da curtida', async () => {
      const ctx = scenario();
      ctx.db.events.push(heldEvent(flagged.id));

      const feed = await ctx.service.feed(OWNER);
      expect(feed.data.map((item) => item.id)).not.toContain(
        ctx.flaggedPost.id,
      );

      const byUser = await ctx.service.userPosts(OTHER, OWNER);
      expect(byUser.data.map((item) => item.id)).not.toContain(
        ctx.flaggedPost.id,
      );
      expect(byUser.meta.total).toBe(2);

      const profile = await ctx.service.publicProfile(OTHER, OWNER);
      expect(profile.postsCount).toBe(2);

      await expect(
        ctx.service.getPost(OTHER, ctx.flaggedPost.id),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        ctx.service.like(OTHER, ctx.flaggedPost.id),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        ctx.service.getPost(OTHER, ctx.okPost.id),
      ).resolves.toMatchObject({
        id: ctx.okPost.id,
      });
    });

    it('meus posts: o de geração em revisão vem sem a mídia', async () => {
      const ctx = scenario();
      ctx.db.generations[1].status = GenerationStatus.IN_REVIEW;
      const mine = await ctx.service.mine(OWNER);
      const held = mine.find((item) => item.id === ctx.flaggedPost.id)!;
      expect(held).toMatchObject({
        mediaUrl: null,
        thumbnailUrl: null,
        safetyHold: true,
      });
      const ok = mine.find((item) => item.id === ctx.okPost.id)!;
      expect(ok).toMatchObject({
        mediaUrl: ctx.okPost.mediaUrl,
        safetyHold: false,
      });
    });
  });

  describe('admin', () => {
    it('fila de aprovação: tudo marcado para borrar; geração em revisão sem URL nenhuma', async () => {
      const ok = imageGen('cimg0000000000000000000020');
      const review = imageGen('cimg0000000000000000000021', {
        status: GenerationStatus.IN_REVIEW,
      });
      const evidence = imageGen('cimg0000000000000000000022');
      const okPost = post({
        status: 'PENDING',
        generationId: ok.id,
        mediaUrl: ok.outputs[0].url,
        thumbnailUrl: ok.outputs[0].thumbnailUrl,
      });
      const reviewPost = post({
        status: 'PENDING',
        generationId: review.id,
        mediaUrl: review.outputs[0].url,
        thumbnailUrl: review.outputs[0].thumbnailUrl,
      });
      const evidencePost = post({
        status: 'PENDING',
        generationId: evidence.id,
        mediaUrl: evidence.outputs[0].url,
      });
      const ctx = setup({
        generations: [ok, review, evidence],
        posts: [okPost, reviewPost, evidencePost],
        events: [heldEvent(evidence.id)],
      });

      const list = await ctx.service.adminList('PENDING');
      expect(list.data.every((item) => item.mediaBlurred === true)).toBe(true);

      const okItem = list.data.find((item) => item.id === okPost.id)!;
      expect(okItem).toMatchObject({
        mediaUrl: ok.outputs[0].url,
        safetyHold: false,
        blurDataUrl: ok.outputs[0].blurDataUrl,
      });

      for (const held of [reviewPost, evidencePost]) {
        const item = list.data.find((entry) => entry.id === held.id)!;
        expect(item).toMatchObject({
          mediaUrl: null,
          thumbnailUrl: null,
          blurDataUrl: null,
          safetyHold: true,
        });
      }
      const serialized = JSON.stringify(list);
      expect(serialized).not.toContain(review.outputs[0].url);
      expect(serialized).not.toContain(evidence.outputs[0].url);
      expect(serialized).not.toContain(review.outputs[0].thumbnailUrl!);
    });

    it('aprovar post de geração em revisão: 409 e nada muda', async () => {
      const review = imageGen('cimg0000000000000000000030', {
        status: GenerationStatus.IN_REVIEW,
      });
      const pending = post({
        status: 'PENDING',
        generationId: review.id,
        mediaUrl: review.outputs[0].url,
      });
      const ctx = setup({ generations: [review], posts: [pending] });
      await expect(ctx.service.approve(pending.id)).rejects.toMatchObject({
        response: { code: COMMUNITY_POST_UNDER_REVIEW },
      });
      expect(ctx.prisma.communityPost.update).not.toHaveBeenCalled();
      expect(ctx.notifications.create).not.toHaveBeenCalled();
    });

    it('post tirado do ar pela guarda legal: não aprova, não troca o motivo, não apaga', async () => {
      const held = post({
        status: 'REJECTED',
        rejectionReason: LEGAL_HOLD_POST_REJECTION_REASON,
      });
      const ctx = setup({ posts: [held] });
      await expect(ctx.service.approve(held.id)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(
        ctx.service.reject(held.id, 'outro motivo'),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(ctx.service.adminDelete(held.id)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(ctx.prisma.communityPost.update).not.toHaveBeenCalled();
      expect(ctx.prisma.communityPost.delete).not.toHaveBeenCalled();
    });

    it('post tirado do ar pela suspensão da conta: parado enquanto ela está suspensa; reativada, o admin decide', async () => {
      const held = post({
        status: 'REJECTED',
        rejectionReason: SAFETY_SUSPENSION_POST_REJECTION_REASON,
      });
      const ctx = setup({ posts: [held] });
      let ownerActive = false;
      (ctx.prisma.user.findUnique as jest.Mock).mockImplementation(
        async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          name: `nome-${where.id}`,
          avatarUrl: null,
          isActive: ownerActive,
        }),
      );
      await expect(ctx.service.approve(held.id)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(
        ctx.service.reject(held.id, 'outro motivo'),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(ctx.service.adminDelete(held.id)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(ctx.prisma.communityPost.update).not.toHaveBeenCalled();
      expect(ctx.prisma.communityPost.delete).not.toHaveBeenCalled();

      ownerActive = true;
      await expect(ctx.service.approve(held.id)).resolves.toMatchObject({
        status: 'APPROVED',
      });
    });

    it('apagar post de geração com evidência: 409 (a linha é evidência)', async () => {
      const evidence = imageGen('cimg0000000000000000000031');
      const approved = post({
        generationId: evidence.id,
        mediaUrl: evidence.outputs[0].url,
      });
      const ctx = setup({
        generations: [evidence],
        posts: [approved],
        events: [heldEvent(evidence.id)],
      });
      await expect(ctx.service.adminDelete(approved.id)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(ctx.prisma.communityPost.delete).not.toHaveBeenCalled();
    });

    it('rejeitar post de geração em revisão continua possível (tira do ar)', async () => {
      const review = imageGen('cimg0000000000000000000032', {
        status: GenerationStatus.IN_REVIEW,
      });
      const pending = post({
        status: 'PENDING',
        generationId: review.id,
        mediaUrl: review.outputs[0].url,
      });
      const ctx = setup({ generations: [review], posts: [pending] });
      await expect(
        ctx.service.reject(pending.id, 'fora da regra'),
      ).resolves.toMatchObject({
        status: 'REJECTED',
      });
    });

    describe('post direto do admin', () => {
      it.each([
        ['URL externa', 'https://hospedagem-de-fora.com/banner.png'],
        ['URL interna', 'http://127.0.0.1:8080/banner.png'],
        ['metadados de nuvem', 'http://169.254.169.254/latest/meta-data/'],
      ])('recusa %s', async (_label, mediaUrl) => {
        const ctx = setup();
        await expect(
          ctx.service.adminCreate(OWNER, { kind: 'image', mediaUrl }),
        ).rejects.toMatchObject({
          response: { code: COMMUNITY_MEDIA_NOT_ALLOWED },
        });
        expect(ctx.prisma.communityPost.create).not.toHaveBeenCalled();
      });

      it('guarda a URL canônica do nosso bucket (nunca o host que veio)', async () => {
        const ctx = setup();
        const created = await ctx.service.adminCreate(OWNER, {
          kind: 'image',
          mediaUrl:
            'http://169.254.169.254/ai-generations/inputs/admin/u/banner.png',
          thumbnailUrl: 'https://rastreador.exemplo/pixel.gif',
        });
        expect(created.mediaUrl).toBe(`${CDN}/inputs/admin/u/banner.png`);
        expect(created.thumbnailUrl).toBeNull();
      });

      it('modo ligado: checa pela chave antes de publicar; barrado = 422, indisponível = 503', async () => {
        const clean = setup({ safety: 'shadow' });
        await clean.service.adminCreate(OWNER, {
          kind: 'video',
          mediaUrl: `${CDN}/inputs/admin/u/clip.mp4`,
        });
        expect(clean.checkInput).toHaveBeenCalledWith(
          [
            {
              kind: 'video',
              mimeType: null,
              area: 'public',
              key: 'inputs/admin/u/clip.mp4',
            },
          ],
          expect.objectContaining({ userId: OWNER, generationId: null }),
        );
        expect(clean.prisma.communityPost.create).toHaveBeenCalledTimes(1);

        const blocked = setup({
          safety: 'shadow',
          verdict: { verdict: 'BLOCK', ruleId: 'E2', strength: 'STRONG' },
        });
        await expect(
          blocked.service.adminCreate(OWNER, {
            kind: 'image',
            mediaUrl: `${CDN}/inputs/admin/u/b.png`,
          }),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
        expect(blocked.prisma.communityPost.create).not.toHaveBeenCalled();

        const blind = setup({
          safety: 'enforce',
          verdict: {
            verdict: 'UNAVAILABLE',
            ruleId: 'UNAVAILABLE',
            strength: 'NONE',
          },
        });
        await expect(
          blind.service.adminCreate(OWNER, {
            kind: 'image',
            mediaUrl: `${CDN}/inputs/admin/u/b.png`,
          }),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(blind.prisma.communityPost.create).not.toHaveBeenCalled();
      });

      it('modo off: não checa', async () => {
        const ctx = setup();
        await ctx.service.adminCreate(OWNER, {
          kind: 'image',
          mediaUrl: `${CDN}/inputs/admin/u/b.png`,
        });
        expect(ctx.checkInput).not.toHaveBeenCalled();
        expect(ctx.prisma.communityPost.create).toHaveBeenCalledTimes(1);
      });
    });
  });
});
