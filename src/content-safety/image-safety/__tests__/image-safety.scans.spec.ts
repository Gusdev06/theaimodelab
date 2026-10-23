import { Logger } from '@nestjs/common';
import { ContentSafetyService } from '../../content-safety.service';
import {
  REFINER_TEXT_MEDIA_KEY,
  holdReasonOf,
  inputNudityFromScans,
  inputSummaryFromScans,
  latestScanBatch,
  preflightStatusFromScans,
  signalsFromScores,
  textSexualFromScans,
  uncensoredFallbackStatus,
  type ScanRowLike,
} from '../image-safety.scans';
import { loadImageSafetyConfig } from '../image-safety.config';
import { createPreflightStatusReader } from '../preflight-status.reader';

const THRESHOLDS = loadImageSafetyConfig(() => undefined).config.thresholds;

/** Leitura das checagens gravadas: última rodada por mídia, status do preflight, motivo do IN_REVIEW, cache. */

const T1 = new Date('2026-10-17T10:00:00Z');
const T2 = new Date('2026-10-17T10:05:00Z');

const row = (overrides: Partial<ScanRowLike> = {}): ScanRowLike => ({
  stage: 'INPUT',
  verdict: 'CLEAN',
  mediaKey: 'inputs/g/u/a.png',
  sha256: 'a'.repeat(64),
  createdAt: T1,
  ...overrides,
});

describe('image-safety.scans', () => {
  describe('uncensoredFallbackStatus (entrada reavaliada como pedido sexual)', () => {
    const adult = {
      faces: [
        { ageLow: 30, ageHigh: 38, ageMid: 34, confidence: 99, fromCrop: false },
      ],
    };
    it('rosto adulto acima da zona de dúvida continua limpo; outro status nunca vira limpo', () => {
      expect(
        uncensoredFallbackStatus('clean', [row({ scores: adult })], THRESHOLDS),
      ).toBe('clean');
      expect(
        uncensoredFallbackStatus('gray', [row({ scores: adult })], THRESHOLDS),
      ).toBe('gray');
    });

    it('zona de dúvida, estilizado sem juiz e linha sem sinais não são limpos; juiz infantil = flagged', () => {
      const young = {
        faces: [
          { ageLow: 18, ageHigh: 24, ageMid: 21, confidence: 99, fromCrop: false },
        ],
      };
      expect(
        uncensoredFallbackStatus('clean', [row({ scores: young })], THRESHOLDS),
      ).toBe('gray');
      expect(
        uncensoredFallbackStatus(
          'clean',
          [row({ scores: { faces: [], illustrated: true } })],
          THRESHOLDS,
        ),
      ).toBe('gray');
      expect(
        uncensoredFallbackStatus(
          'clean',
          [
            row({
              scores: {
                faces: [],
                illustrated: true,
                stylized: {
                  status: 'judged',
                  judge: 'hive',
                  childlike: false,
                  confidence: 0.9,
                },
              },
            }),
          ],
          THRESHOLDS,
        ),
      ).toBe('clean');
      expect(
        uncensoredFallbackStatus(
          'clean',
          [
            row({
              scores: {
                faces: [],
                illustrated: true,
                stylized: {
                  status: 'judged',
                  judge: 'hive',
                  childlike: true,
                  confidence: 0.9,
                },
              },
            }),
          ],
          THRESHOLDS,
        ),
      ).toBe('flagged');
      expect(uncensoredFallbackStatus('clean', [row()], THRESHOLDS)).toBe(
        'unavailable',
      );
    });
  });

  it('IN_REVIEW: HOLD de regra só de sombra no resultado não vira revisão (não trava a quarentena)', () => {
    const output = (enforced: boolean) =>
      row({
        stage: 'OUTPUT',
        verdict: 'HOLD',
        mediaKey: 'generations/g/q/o.png',
        enforced,
      });
    expect(holdReasonOf([output(false)], true)).toBe('output_unchecked');
    expect(holdReasonOf([output(true)], true)).toBe('output_review');
  });

  it('última rodada de cada mídia: a indisponível antiga sai quando a mídia foi checada de novo', () => {
    const rows = [
      row({ verdict: 'UNAVAILABLE', createdAt: T1 }),
      row({ stage: 'INPUT_FRAME', verdict: 'CLEAN', createdAt: T2 }),
      row({ stage: 'INPUT_FRAME', verdict: 'GRAY', createdAt: T2 }),
      row({ mediaKey: 'inputs/g/u/b.png', verdict: 'CLEAN', createdAt: T1 }),
    ];
    const latest = latestScanBatch(rows);
    expect(latest.map((item) => item.verdict)).toEqual([
      'CLEAN',
      'GRAY',
      'CLEAN',
    ]);
    expect(preflightStatusFromScans(rows, false)).toBe('gray');
  });

  it('status do preflight: nunca limpo por ausência; texto esperado sem linha = unavailable; refinador fora', () => {
    expect(preflightStatusFromScans([], false)).toBe('unavailable');
    expect(preflightStatusFromScans([row()], true)).toBe('unavailable');
    expect(
      preflightStatusFromScans(
        [row(), row({ stage: 'TEXT', mediaKey: null })],
        true,
      ),
    ).toBe('clean');
    // a linha do refinador (acusada) não muda o status da entrada
    expect(
      preflightStatusFromScans(
        [
          row(),
          row({ stage: 'TEXT', mediaKey: null }),
          row({
            stage: 'TEXT',
            mediaKey: REFINER_TEXT_MEDIA_KEY,
            verdict: 'BLOCK',
            createdAt: T2,
          }),
        ],
        true,
      ),
    ).toBe('clean');
    // só texto, sem linha de imagem: a imagem é sempre esperada
    expect(
      preflightStatusFromScans([row({ stage: 'TEXT', mediaKey: null })], true),
    ).toBe('unavailable');
    expect(preflightStatusFromScans([row({ verdict: 'HOLD' })], false)).toBe(
      'flagged',
    );
    // resultado não entra no preflight
    expect(
      preflightStatusFromScans(
        [row(), row({ stage: 'OUTPUT', verdict: 'BLOCK' })],
        false,
      ),
    ).toBe('clean');
  });

  it('motivo do IN_REVIEW', () => {
    expect(holdReasonOf([row({ verdict: 'HOLD' })], false)).toBe(
      'input_review',
    );
    expect(
      holdReasonOf([row({ stage: 'OUTPUT', verdict: 'HOLD' })], true),
    ).toBe('output_review');
    expect(
      holdReasonOf([row({ stage: 'OUTPUT_FRAME', verdict: 'BLOCK' })], true),
    ).toBe('output_review');
    expect(
      holdReasonOf([row({ stage: 'OUTPUT', verdict: 'UNAVAILABLE' })], true),
    ).toBe('output_unchecked');
    // saída guardada sem linha gravada (o registro falhou): conta como não checada
    expect(holdReasonOf([row({ verdict: 'CLEAN' })], true)).toBe(
      'output_unchecked',
    );
    // a nova checagem que achou suspeita vence a indisponível antiga
    expect(
      holdReasonOf(
        [
          row({
            stage: 'OUTPUT',
            verdict: 'UNAVAILABLE',
            mediaKey: 'generations/g/q/o.png',
            createdAt: T1,
          }),
          row({
            stage: 'OUTPUT',
            verdict: 'HOLD',
            mediaKey: 'generations/g/q/o.png',
            createdAt: T2,
          }),
        ],
        true,
      ),
    ).toBe('output_review');
  });

  it('resumo da entrada para a S7: pior veredito e o rosto mais jovem; mídia sem checagem nunca é limpa', () => {
    const scores = (ages: number[]) => ({
      faces: ages.map((ageMid) => ({
        ageLow: ageMid - 3,
        ageHigh: ageMid + 3,
        ageMid,
        confidence: 99,
        fromCrop: false,
      })),
    });
    expect(
      inputSummaryFromScans(
        [
          row({ scores: scores([31, 27]) }),
          row({
            mediaKey: 'inputs/g/u/b.png',
            verdict: 'GRAY',
            scores: scores([21]),
          }),
        ],
        true,
      ),
    ).toEqual({ verdict: 'GRAY', hadFace: true, youngestAgeMid: 21 });
    expect(inputSummaryFromScans([], true)).toEqual({
      verdict: 'UNAVAILABLE',
      hadFace: false,
      youngestAgeMid: null,
    });
    expect(inputSummaryFromScans([], false)).toEqual({
      verdict: null,
      hadFace: false,
      youngestAgeMid: null,
    });
  });

  it('pistas de pedido sexual gravadas: nudez da entrada e intenção do texto do pedido', () => {
    expect(inputNudityFromScans([row({ scores: { nudity: 75 } })], 60)).toBe(
      true,
    );
    expect(
      inputNudityFromScans(
        [
          row({
            scores: {
              moderation: [
                {
                  name: 'Implied Nudity',
                  parent: 'Non-Explicit Nudity of Intimate parts and Kissing',
                  confidence: 80,
                  taxonomyLevel: 3,
                },
              ],
            },
          }),
        ],
        60,
      ),
    ).toBe(true);
    expect(inputNudityFromScans([row({ scores: { nudity: 30 } })], 60)).toBe(
      false,
    );
    expect(
      inputNudityFromScans([row({ verdict: 'UNAVAILABLE' })], 60),
    ).toBeNull();
    expect(
      textSexualFromScans([
        row({ stage: 'TEXT', mediaKey: null, scores: { sexual: true } }),
      ]),
    ).toBe(true);
    expect(
      textSexualFromScans([
        row({
          stage: 'TEXT',
          mediaKey: REFINER_TEXT_MEDIA_KEY,
          scores: { sexual: true },
        }),
      ]),
    ).toBeNull();
  });

  it('cache: sinais reconstruídos sem caixa do rosto e sem acerto de hash antigo', () => {
    const signals = signalsFromScores({
      scores: {
        faces: [
          {
            ageLow: 30,
            ageHigh: 38,
            ageMid: 34,
            confidence: 99,
            fromCrop: true,
          },
        ],
        labels: [{ name: 'Person', confidence: 98, instanceCount: 1 }],
        moderation: [
          {
            name: 'Explicit Nudity',
            parent: 'Explicit',
            confidence: 90,
            taxonomyLevel: 2,
          },
        ],
        illustrated: true,
        hashMatch: { source: 'blocklist', matcher: 'x', distance: 2 },
      },
      phash: '0123456789abcdef',
      sha256: 'b'.repeat(64),
    });
    expect(signals).toMatchObject({
      faces: [
        { ageLow: 30, ageHigh: 38, ageMid: 34, box: null, fromCrop: true },
      ],
      illustrated: true,
      hashMatch: null,
      scanner: 'cache',
      phash: '0123456789abcdef',
    });
  });

  describe('leitor do status (ContentSafetyService)', () => {
    beforeEach(() =>
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
    );
    afterEach(() => jest.restoreAllMocks());

    it('modo off: unavailable sem ler o banco', async () => {
      const prisma = { contentSafetyScan: { findMany: jest.fn() } };
      const reader = createPreflightStatusReader(prisma as never, {
        imageMode: 'off',
        textMode: 'off',
        thresholds: THRESHOLDS,
      });
      await expect(reader.statusFor('g')).resolves.toBe('unavailable');
      expect(prisma.contentSafetyScan.findMany).not.toHaveBeenCalled();
    });

    it('ligado: lê as checagens de entrada e texto; erro de leitura = unavailable', async () => {
      const prisma = {
        contentSafetyScan: {
          findMany: jest.fn(async () => [
            row(),
            row({ verdict: 'GRAY', mediaKey: 'x' }),
          ]),
        },
      };
      const reader = createPreflightStatusReader(prisma as never, {
        imageMode: 'shadow',
        textMode: 'off',
        thresholds: THRESHOLDS,
      });
      await expect(reader.statusFor('g')).resolves.toBe('gray');
      expect(prisma.contentSafetyScan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            generationId: 'g',
            stage: { in: ['INPUT', 'INPUT_FRAME', 'TEXT'] },
          },
        }),
      );
      prisma.contentSafetyScan.findMany.mockRejectedValueOnce(new Error('db'));
      await expect(reader.statusFor('g')).resolves.toBe('unavailable');
    });

    it("desvio sem censura: o 'clean' do pedido com filtro é reavaliado como pedido sexual", async () => {
      // rosto de ponto médio 20: limpo num pedido comum, zona de dúvida (E4) no destino sem censura
      const young = row({
        scores: {
          faces: [
            { ageLow: 17, ageHigh: 23, ageMid: 20, confidence: 99, fromCrop: false },
          ],
        },
      });
      const prisma = {
        contentSafetyScan: { findMany: jest.fn(async () => [young]) },
      };
      const reader = createPreflightStatusReader(prisma as never, {
        imageMode: 'shadow',
        textMode: 'off',
        thresholds: THRESHOLDS,
      });
      await expect(reader.statusFor('g')).resolves.toBe('clean');
      await expect(reader.statusFor('g', 'uncensored')).resolves.toBe('gray');
    });

    it.each([
      ['off', false],
      ['shadow', true],
      ['enforce', true],
    ] as const)(
      'modo %s: o desvio com mídia depende do veredito = %s',
      (imageMode, expected) => {
        const reader = createPreflightStatusReader(
          { contentSafetyScan: { findMany: jest.fn() } } as never,
          { imageMode, textMode: 'off', thresholds: THRESHOLDS },
        );
        expect(reader.enforcesMediaPreflight).toBe(expected);
      },
    );

    it('ContentSafetyService usa o leitor; sem ele, unavailable e porteiro desligado (regra de antes da checagem)', async () => {
      const without = new ContentSafetyService({} as never);
      await expect(without.preflightStatusForGeneration('g')).resolves.toBe(
        'unavailable',
      );
      expect(without.enforcesMediaPreflight()).toBe(false);
      const withReader = new ContentSafetyService({} as never, {
        enforcesMediaPreflight: true,
        statusFor: jest.fn(async () => 'clean' as const),
      });
      await expect(withReader.preflightStatusForGeneration('g')).resolves.toBe(
        'clean',
      );
      expect(withReader.enforcesMediaPreflight()).toBe(true);
      const offReader = new ContentSafetyService({} as never, {
        enforcesMediaPreflight: false,
        statusFor: jest.fn(async () => 'unavailable' as const),
      });
      expect(offReader.enforcesMediaPreflight()).toBe(false);
    });
  });
});
