import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as sharp from 'sharp';
import { GenerationStatus } from '@prisma/client';
import { isTerminalSafetyBlock, OwnMediaRequiredError } from '../../errors/content-safety.error';
import { failureCodeOf, failureUserMessage, UNCENSORED_OWN_MEDIA_REQUIRED_MESSAGE } from '../../errors/failure-reason';
import { GenerationJobName } from '../../queue/generation-queue.constants';
import {
  gateTargetOf,
  OwnMediaCopyError,
  OwnMediaGate,
  type OwnMediaGateAudit,
  type OwnMediaGateDeps,
  type OwnMediaMatchResult,
  ownMediaGateMode,
  substituteJobImages,
  trustedOwnerIds,
  videoLineage,
} from '../own-media-gate';
import { fingerprintImage, FRAME_ORDER_BASE, FRAME_SLOTS, frameSlot, OwnMediaProvenance, type OwnMatch } from '../own-media';
import { EDGE_FRAMES, extractEdgeFrames, extractVideoFrame } from '../video-frame';

const base = { generationId: 'g1', userId: 'u1', creditsConsumed: 1350 };

function ownMatch(inputUrl: string, overrides: Partial<OwnMatch> = {}): OwnMatch {
  return {
    inputUrl,
    generationId: 'g-modelo',
    outputOrder: 0,
    outputUrl: 'https://s3/g-modelo/0.png',
    distance: 2,
    thumbDiff: 3,
    frameIndex: null,
    ...overrides,
  };
}

const found = (...matches: OwnMatch[]): OwnMediaMatchResult => ({ matches, transient: false });
const notFound: OwnMediaMatchResult = { matches: null, transient: false };

function gateWith(mode: OwnMediaGateDeps['mode'], overrides: Partial<OwnMediaGateDeps> = {}) {
  const audits: OwnMediaGateAudit[] = [];
  const deps: OwnMediaGateDeps = {
    mode,
    match: jest.fn(async () => notFound),
    storedImages: jest.fn(async () => []),
    replaceStoredImages: jest.fn(async () => undefined),
    copyFrame: jest.fn(async () => 'https://s3/inputs/g1/own-frame-0.jpg'),
    saveAudit: jest.fn(async (_id: string, audit: OwnMediaGateAudit) => {
      audits.push(audit);
    }),
    ...overrides,
  };
  return { gate: new OwnMediaGate(deps), deps, audits };
}

/** Bate só no critério do desvio (parecida, não idêntica): o estrito diz não. */
const looseOnly = (...matches: OwnMatch[]) =>
  jest.fn(async (_userId: string, _urls: readonly string[], rule: 'lineage' | 'detour') => (rule === 'detour' ? found(...matches) : notFound));

describe('porta da foto própria · regras', () => {
  it('modo: só log e enforce ligam; o resto é off', () => {
    expect(ownMediaGateMode(undefined)).toBe('off');
    expect(ownMediaGateMode('')).toBe('off');
    expect(ownMediaGateMode('true')).toBe('off');
    expect(ownMediaGateMode(' LOG ')).toBe('log');
    expect(ownMediaGateMode('enforce')).toBe('enforce');
    expect(trustedOwnerIds(' a, b,,a ')).toEqual(['a', 'b']);
  });

  it('alvo: motores sem filtro pelo job, pelo motor do Motion Control, pelo face swap Unlocked ou pelo modelo', () => {
    const ltx = gateTargetOf(GenerationJobName.WAVESPEED_IMAGE_TO_VIDEO, { ...base, imageUrl: 'https://x/a.jpg' });
    expect(ltx).toMatchObject({ uncensored: true, model: 'wavespeed-ltx-spicy', jobImageUrls: ['https://x/a.jpg'], producesVideo: true });

    const wan = gateTargetOf(GenerationJobName.MOTION_CONTROL, { ...base, engine: 'wan-replace', imageUrl: 'https://x/a.jpg', videoUrl: 'https://x/v.mp4' });
    expect(wan).toMatchObject({ uncensored: true, model: 'motion-control:wan-replace', jobImageUrls: ['https://x/a.jpg'], hasVideoInput: true });
    expect(gateTargetOf(GenerationJobName.MOTION_CONTROL, { ...base, imageUrl: 'https://x/a.jpg', videoUrl: 'https://x/v.mp4' }).uncensored).toBe(false);

    expect(gateTargetOf(GenerationJobName.FACE_SWAP, { ...base, nsfw: true, sourceImageUrl: 'https://x/s.jpg', targetImageUrl: 'https://x/t.jpg' })).toMatchObject({
      uncensored: true,
      jobImageUrls: ['https://x/s.jpg', 'https://x/t.jpg'],
      producesVideo: false,
    });
    expect(gateTargetOf(GenerationJobName.FACE_SWAP, { ...base, sourceImageUrl: 'https://x/s.jpg' }).uncensored).toBe(false);

    expect(gateTargetOf(GenerationJobName.IMAGE, { ...base, model: 'sem-censura', hasInputImages: true })).toMatchObject({
      uncensored: true,
      usesStoredImages: true,
      producesVideo: false,
    });
    expect(gateTargetOf(GenerationJobName.IMAGE_NANO_BANANA, { ...base, model: 'nano-banana-2', imageUrls: ['https://x/a.jpg'] }).uncensored).toBe(false);
    const veo = gateTargetOf(GenerationJobName.IMAGE_TO_VIDEO, { ...base, model: 'veo-3', resolvedModel: 'veo-3-fast' });
    expect(veo).toMatchObject({ uncensored: false, producesVideo: true });
    expect(gateTargetOf(GenerationJobName.MINIMAX_H3_REFERENCE_TO_VIDEO, { ...base, referenceImageUrls: ['https://x/a.jpg'], referenceVideoUrls: ['https://x/v.mp4'] })).toMatchObject({
      uncensored: true,
      jobImageUrls: ['https://x/a.jpg'],
      hasVideoInput: true,
    });
  });

  it('linhagem do vídeo: fotos próprias ou só texto = limpo; foto de fora, vídeo sem foto ou prompt clonado = sujo', () => {
    expect(videoLineage({ imageCount: 1, allImagesOwn: true, hasVideoInput: true, prompt: 'x' })).toBe('clean');
    expect(videoLineage({ imageCount: 2, allImagesOwn: false, hasVideoInput: false, prompt: 'x' })).toBe('not_clean');
    expect(videoLineage({ imageCount: 0, allImagesOwn: false, hasVideoInput: false, prompt: 'x' })).toBe('clean');
    expect(videoLineage({ imageCount: 0, allImagesOwn: false, hasVideoInput: true, prompt: 'x' })).toBe('not_clean');
    expect(videoLineage({ imageCount: 1, allImagesOwn: true, hasVideoInput: false, prompt: '[reference_override] …' })).toBe('not_clean');
  });

  it('troca só as fotos do job; o vídeo de entrada fica; foto sem troca = null', () => {
    const data = { ...base, imageUrl: 'https://x/a.jpg', videoUrl: 'https://x/v.mp4', referenceImageUrls: ['https://x/b.jpg'] };
    const map = new Map([
      ['https://x/a.jpg', 'https://s3/a.png'],
      ['https://x/b.jpg', 'https://s3/b.png'],
    ]);
    expect(substituteJobImages(data, map)).toEqual({ ...data, imageUrl: 'https://s3/a.png', referenceImageUrls: ['https://s3/b.png'] });
    expect(substituteJobImages(data, new Map([['https://x/a.jpg', 'https://s3/a.png']]))).toBeNull();
  });

  it('erro terminal com código próprio e texto para a cliente', () => {
    const error = new OwnMediaRequiredError('wavespeed-ltx-spicy');
    expect(isTerminalSafetyBlock(error)).toBe(true);
    expect(failureCodeOf(error)).toBe('UNCENSORED_OWN_MEDIA_REQUIRED');
    expect(failureUserMessage('UNCENSORED_OWN_MEDIA_REQUIRED', error)).toBe(UNCENSORED_OWN_MEDIA_REQUIRED_MESSAGE);
  });
});

describe('porta da foto própria · OwnMediaGate', () => {
  const ltxJob = { ...base, imageUrl: 'https://x/foto.jpg', prompt: 'cena' };
  const LTX = GenerationJobName.WAVESPEED_IMAGE_TO_VIDEO;

  it('off: não confere nada e devolve o mesmo job', async () => {
    const { gate, deps } = gateWith('off');
    await expect(gate.apply(LTX, ltxJob)).resolves.toBe(ltxJob);
    expect(deps.match).not.toHaveBeenCalled();
    expect(deps.storedImages).not.toHaveBeenCalled();
    expect(deps.saveAudit).not.toHaveBeenCalled();
  });

  it('log: foto de fora no sem filtro segue igual, com o registro', async () => {
    const { gate, audits } = gateWith('log');
    await expect(gate.apply(LTX, ltxJob)).resolves.toBe(ltxJob);
    expect(audits).toEqual([expect.objectContaining({ mode: 'log', uncensored: true, images: 1, own: false, strict: false, lineage: 'not_clean' })]);
  });

  it('enforce: foto de fora no sem filtro encerra antes do provedor', async () => {
    const { gate, audits } = gateWith('enforce');
    await expect(gate.apply(LTX, ltxJob)).rejects.toBeInstanceOf(OwnMediaRequiredError);
    expect(audits).toEqual([expect.objectContaining({ blocked: true, own: false })]);
  });

  it('enforce: foto própria vai a NOSSA cópia; o vídeo do Copiar movimentos fica', async () => {
    const job = { ...base, engine: 'wan-replace', imageUrl: 'https://x/foto.jpg', videoUrl: 'https://x/v.mp4' };
    const { gate, audits } = gateWith('enforce', { match: jest.fn(async () => found(ownMatch('https://x/foto.jpg'))) });
    const out = await gate.apply(GenerationJobName.MOTION_CONTROL, job);
    expect(out).toEqual({ ...job, imageUrl: 'https://s3/g-modelo/0.png' });
    expect(audits).toEqual([expect.objectContaining({ own: true, strict: true, substituted: true, lineage: 'clean' })]);
  });

  it('linhagem: foto só PARECIDA (critério do desvio) limpa o vídeo apenas quando o provedor recebeu a nossa cópia', async () => {
    const similar = ownMatch('https://x/foto.jpg', { distance: 6 });
    // enforce num sem filtro: vai a nossa cópia → os quadros valem depois
    const enforced = gateWith('enforce', { match: looseOnly(similar) });
    await expect(enforced.gate.apply(LTX, ltxJob)).resolves.toEqual({ ...ltxJob, imageUrl: 'https://s3/g-modelo/0.png' });
    expect(enforced.audits).toEqual([expect.objectContaining({ own: true, strict: false, substituted: true, lineage: 'clean' })]);

    // log num sem filtro: o provedor recebe os bytes do pedido → o registro diz que o enforce deixaria, mas a linhagem fica suja
    const logged = gateWith('log', { match: looseOnly(similar) });
    await expect(logged.gate.apply(LTX, ltxJob)).resolves.toBe(ltxJob);
    expect(logged.audits).toEqual([expect.objectContaining({ own: true, strict: false, lineage: 'not_clean' })]);
    expect(logged.audits[0]).not.toHaveProperty('substituted');

    // vídeo COM filtro (Veo), mesmo no enforce: nada é trocado, só o critério estrito conta (e o do desvio nem roda)
    const veo = { ...base, model: 'veo-3', resolvedModel: 'veo-3-fast', imageUrl: 'https://x/foto.jpg', prompt: 'x' };
    const filtered = gateWith('enforce', { match: looseOnly(similar) });
    await expect(filtered.gate.apply(GenerationJobName.IMAGE_TO_VIDEO, veo)).resolves.toBe(veo);
    expect(filtered.deps.match).toHaveBeenCalledTimes(1);
    expect(filtered.deps.match).toHaveBeenCalledWith('u1', ['https://x/foto.jpg'], 'lineage');
    expect(filtered.audits).toEqual([expect.objectContaining({ uncensored: false, own: false, strict: false, lineage: 'not_clean' })]);
  });

  it('enforce: quadro de vídeo próprio vai o quadro tirado do NOSSO vídeo; cópia que falha é passageira, não terminal', async () => {
    const frame = ownMatch('https://x/foto.jpg', { outputUrl: 'https://s3/g-video/0.mp4', outputOrder: FRAME_ORDER_BASE + 9, frameIndex: -2 });
    const ok = gateWith('enforce', { match: jest.fn(async () => found(frame)) });
    const out = await ok.gate.apply(LTX, ltxJob);
    expect(ok.deps.copyFrame).toHaveBeenCalledWith('https://s3/g-video/0.mp4', -2, 'g1', 0);
    expect(out).toEqual({ ...ltxJob, imageUrl: 'https://s3/inputs/g1/own-frame-0.jpg' });

    const failing = gateWith('enforce', { match: jest.fn(async () => found(frame)), copyFrame: jest.fn(async () => null) });
    const error = await failing.gate.apply(LTX, ltxJob).catch((e) => e);
    expect(error).toBeInstanceOf(OwnMediaCopyError);
    expect(isTerminalSafetyBlock(error)).toBe(false);
    // o texto que a cliente vê não traz id nem detalhe interno
    expect(error.message).not.toMatch(/gen=|quadro/);
  });

  it('enforce: não conseguir LER a foto (rede, armazenamento, banco) é passageiro, não "foto de fora"', async () => {
    const { gate, audits } = gateWith('enforce', { match: jest.fn(async () => ({ matches: null, transient: true })) });
    const error = await gate.apply(LTX, ltxJob).catch((e) => e);
    expect(error).toBeInstanceOf(OwnMediaCopyError);
    expect(isTerminalSafetyBlock(error)).toBe(false);
    expect(audits).toEqual([]);

    // em log, a mesma falha só fica no registro
    const logged = gateWith('log', { match: jest.fn(async () => ({ matches: null, transient: true })) });
    await expect(logged.gate.apply(LTX, ltxJob)).resolves.toBe(ltxJob);
    expect(logged.audits).toEqual([expect.objectContaining({ own: false, unreadable: true, lineage: 'not_clean' })]);
  });

  it('enforce no Copiar movimentos (Wan): entradas guardadas = vídeo + foto; só a foto é conferida e trocada', async () => {
    const job = { ...base, engine: 'wan-replace', imageUrl: 'https://x/ela.jpg', videoUrl: 'https://x/v.mp4' };
    const { gate, deps, audits } = gateWith('enforce', {
      storedImages: jest.fn(async () => [
        { id: 'i0', url: 'https://x/v.mp4', mimeType: 'video/mp4' },
        { id: 'i1', url: 'https://x/ela.jpg', mimeType: 'image/jpeg' },
      ]),
      match: jest.fn(async () => found(ownMatch('https://x/ela.jpg'))),
    });
    await expect(gate.apply(GenerationJobName.MOTION_CONTROL, job)).resolves.toEqual({ ...job, imageUrl: 'https://s3/g-modelo/0.png' });
    expect(deps.match).toHaveBeenCalledWith('u1', ['https://x/ela.jpg'], 'lineage');
    expect(deps.replaceStoredImages).toHaveBeenCalledWith([{ id: 'i1', url: 'https://s3/g-modelo/0.png' }]);
    expect(audits).toEqual([expect.objectContaining({ images: 1, own: true, lineage: 'clean', substituted: true })]);
  });

  it('enforce: foto guardada sem link, ou job sem dono, não dá para conferir = encerra', async () => {
    const { gate, deps } = gateWith('enforce', { storedImages: jest.fn(async () => [{ id: 'i1', url: null, mimeType: 'image/jpeg' }]) });
    await expect(gate.apply(GenerationJobName.MINIMAX_H3_IMAGE_TO_VIDEO, { ...base, prompt: 'x' })).rejects.toBeInstanceOf(OwnMediaRequiredError);
    expect(deps.match).not.toHaveBeenCalled();

    const orphan = gateWith('enforce');
    await expect(orphan.gate.apply(LTX, { imageUrl: 'https://x/foto.jpg' })).rejects.toBeInstanceOf(OwnMediaRequiredError);
    // em log, o job sem dono só segue
    const job = { imageUrl: 'https://x/foto.jpg' };
    await expect(gateWith('log').gate.apply(LTX, job)).resolves.toBe(job);
  });

  it('imagem sem filtro (Unlocked com foto de referência): só registro, mesmo no enforce', async () => {
    const job = { ...base, model: 'sem-censura', hasInputImages: true, prompt: 'x' };
    const { gate, deps, audits } = gateWith('enforce', {
      storedImages: jest.fn(async () => [{ id: 'i1', url: 'https://x/de-fora.jpg', mimeType: 'image/jpeg' }]),
    });
    await expect(gate.apply(GenerationJobName.IMAGE, job)).resolves.toBe(job);
    expect(deps.replaceStoredImages).not.toHaveBeenCalled();
    expect(audits).toEqual([expect.objectContaining({ uncensored: true, images: 1, own: false })]);
    expect(audits[0]).not.toHaveProperty('blocked');
  });

  it('vídeo com filtro: nunca bloqueia; a foto guardada de fora deixa a linhagem suja (os quadros não valem depois)', async () => {
    const veo = { ...base, model: 'veo-3', resolvedModel: 'veo-3-fast', prompt: 'x' };
    const { gate, audits } = gateWith('enforce', {
      storedImages: jest.fn(async () => [{ id: 'i1', url: 'https://x/de-fora.jpg', mimeType: 'image/jpeg' }]),
    });
    await expect(gate.apply(GenerationJobName.IMAGE_TO_VIDEO, veo)).resolves.toBe(veo);
    expect(audits).toEqual([expect.objectContaining({ uncensored: false, images: 1, own: false, lineage: 'not_clean' })]);

    const clean = gateWith('enforce', {
      storedImages: jest.fn(async () => [{ id: 'i1', url: 'https://x/ela.jpg', mimeType: 'image/png' }]),
      match: jest.fn(async () => found(ownMatch('https://x/ela.jpg'))),
    });
    await expect(clean.gate.apply(GenerationJobName.IMAGE_TO_VIDEO, veo)).resolves.toBe(veo);
    expect(clean.audits).toEqual([expect.objectContaining({ own: true, strict: true, lineage: 'clean' })]);
    expect(clean.audits[0]).not.toHaveProperty('substituted');
  });

  it('imagem com filtro: nada roda', async () => {
    const nano = gateWith('enforce');
    const job = { ...base, model: 'nano-banana-2', imageUrls: ['https://x/a.jpg'] };
    await expect(nano.gate.apply(GenerationJobName.IMAGE_NANO_BANANA, job)).resolves.toBe(job);
    expect(nano.deps.match).not.toHaveBeenCalled();
    expect(nano.deps.storedImages).not.toHaveBeenCalled();
  });

  it('log nunca derruba o pedido: conferência que falha vira aviso; no enforce a falha sobe', async () => {
    const down = { storedImages: jest.fn(async () => { throw new Error('db down'); }) };
    await expect(gateWith('log', down).gate.apply(LTX, ltxJob)).resolves.toBe(ltxJob);
    await expect(gateWith('enforce', down).gate.apply(LTX, ltxJob)).rejects.toThrow('db down');
  });

  it('sem filtro só com texto: segue, linhagem limpa, sem conferência', async () => {
    const { gate, deps, audits } = gateWith('enforce');
    const job = { ...base, prompt: 'cena', resolution: 'RES_720P' };
    await expect(gate.apply(GenerationJobName.MINIMAX_H3_TEXT_TO_VIDEO, job)).resolves.toBe(job);
    expect(deps.match).not.toHaveBeenCalled();
    expect(audits).toEqual([expect.objectContaining({ images: 0, lineage: 'clean' })]);
  });
});

describe('own-media · quadros de vídeo', () => {
  function prismaWith(rows: any[]) {
    return {
      mediaFingerprint: {
        findMany: jest.fn(async () => rows),
        upsert: jest.fn(async ({ create }: any) => create),
      },
      generationOutput: {
        findFirst: jest.fn(async ({ where }: any) => ({ url: `https://s3/${where.generationId}/${where.order}.mp4` })),
      },
      generation: {
        findUnique: jest.fn(async () => ({ userId: 'u1', status: GenerationStatus.COMPLETED })),
      },
    };
  }

  it('vagas: quadros do começo e do fim não colidem; fora das vagas não entra', () => {
    expect([0, 3, -1, -4].map(frameSlot)).toEqual([0, 3, 8, 11]);
    expect(frameSlot(8)).toBeNull();
    expect(frameSlot(-9)).toBeNull();
    expect(frameSlot(0.5)).toBeNull();
  });

  it('grava os quadros das pontas de cada saída, cada um na sua vaga', async () => {
    const prisma = prismaWith([]);
    const red = await sharp({ create: { width: 64, height: 96, channels: 3, background: { r: 200, g: 20, b: 20 } } }).jpeg().toBuffer();
    const extract = jest.fn(async () => [
      { index: 0, jpeg: red },
      { index: 1, jpeg: red },
      { index: -1, jpeg: red },
    ]);
    const recorded = await new OwnMediaProvenance(prisma as any).recordVideoFrames('g-video', ['https://s3/a.mp4', 'https://s3/b.mp4'], extract);
    expect(recorded).toBe(6);
    const orders = prisma.mediaFingerprint.upsert.mock.calls.map((call: any[]) => call[0].create.outputOrder);
    expect(orders).toEqual([
      FRAME_ORDER_BASE,
      FRAME_ORDER_BASE + 1,
      FRAME_ORDER_BASE + 8,
      FRAME_ORDER_BASE + FRAME_SLOTS,
      FRAME_ORDER_BASE + FRAME_SLOTS + 1,
      FRAME_ORDER_BASE + FRAME_SLOTS + 8,
    ]);
    expect(prisma.mediaFingerprint.upsert.mock.calls[2][0].create).toMatchObject({ cleanLineage: true, frameIndex: -1, userId: 'u1' });
  });

  it('casou com um quadro: devolve o vídeo da saída certa e o índice do quadro', async () => {
    const image = await sharp({ create: { width: 64, height: 96, channels: 3, background: { r: 10, g: 120, b: 220 } } })
      .composite([{ input: await sharp({ create: { width: 20, height: 30, channels: 3, background: { r: 250, g: 250, b: 0 } } }).png().toBuffer(), left: 5, top: 10 }])
      .jpeg()
      .toBuffer();
    const print = await fingerprintImage(image);
    const prisma = prismaWith([{ generationId: 'g-video', outputOrder: FRAME_ORDER_BASE + FRAME_SLOTS + 9, frameIndex: -2, ...print }]);
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(new Uint8Array(image), { status: 200 }));
    try {
      const own = new OwnMediaProvenance(prisma as any);
      const matches = await own.matchOwnClean('u1', ['https://x/quadro.jpg'], undefined, { includeVideoFrames: true, trustedUserIds: ['casa'] });
      expect(matches).toEqual([expect.objectContaining({ generationId: 'g-video', frameIndex: -2, outputUrl: 'https://s3/g-video/1.mp4' })]);
      // por conta (a cliente e a da casa): as imagens e, à parte, os quadros (um teto para cada)
      const wheres = prisma.mediaFingerprint.findMany.mock.calls.map((call: any[]) => call[0].where);
      expect(wheres.map((where: any) => [where.userId, where.frameIndex])).toEqual([
        ['u1', null],
        ['u1', { not: null }],
        ['casa', null],
        ['casa', { not: null }],
      ]);

      // o desvio (sem a opção) continua só com imagens da própria conta
      prisma.mediaFingerprint.findMany.mockClear();
      await own.matchOwnClean('u1', ['https://x/quadro.jpg']);
      expect(prisma.mediaFingerprint.findMany).toHaveBeenCalledTimes(1);
      expect((prisma.mediaFingerprint.findMany.mock.calls[0] as any[])[0].where).toMatchObject({ userId: 'u1', frameIndex: null });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('video-frame · ffmpeg de verdade', () => {
  let video: Buffer;
  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-frame-test-'));
    const file = path.join(dir, 'v.mp4');
    // 1 s vermelho + 1 s azul, 24 quadros por segundo
    execFileSync(ffmpegInstaller.path, [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=64x96:d=1:r=24',
      '-f', 'lavfi', '-i', 'color=c=blue:s=64x96:d=1:r=24',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-pix_fmt', 'yuv420p', file,
    ]);
    video = fs.readFileSync(file);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tira os quadros das duas pontas; link sem https não baixa', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(new Uint8Array(video), { status: 200 }));
    try {
      const frames = await extractEdgeFrames('https://s3/v.mp4');
      expect(frames.map((frame) => frame.index)).toEqual([0, 1, 2, 3, -4, -3, -2, -1]);
      expect(frames).toHaveLength(EDGE_FRAMES * 2);
      const color = async (buf: Buffer | null) => (await sharp(buf!).stats()).channels.map((channel) => Math.round(channel.mean));
      const [r1, , b1] = await color(frames[1].jpeg);
      const [r2, , b2] = await color(await extractVideoFrame('https://s3/v.mp4', -2));
      expect(r1).toBeGreaterThan(b1);
      expect(b2).toBeGreaterThan(r2);
      await expect(extractEdgeFrames('http://s3/v.mp4')).resolves.toEqual([]);
      await expect(extractVideoFrame('https://s3/v.mp4', 7)).resolves.toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  }, 90_000);
});
