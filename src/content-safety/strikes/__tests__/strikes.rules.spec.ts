import { RULES_VERSION } from '../../image-safety/image-safety.config';
import {
  countMediumPoints,
  isUserId,
  photoRetryDecision,
  strengthOfMatch,
  suspensionHoldRows,
  suspensionReasonOf,
  usableStrikePhotos,
  type PhotoAttemptRow,
} from '../strikes.rules';
import {
  buildSuspensionNotice,
  noticeLocaleOf,
  reviewChannelOf,
} from '../suspension-notice';

/** Regras puras da camada 6 e o aviso de suspensão. Sem banco, sem rede, sem imagem. */

const NOW = new Date('2026-10-22T12:00:00Z');
const minutesAgo = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000);

const row = (
  minutes: number,
  overrides: Partial<PhotoAttemptRow> = {},
): PhotoAttemptRow => ({
  generationId: `gen-${minutes}`,
  createdAt: minutesAgo(minutes),
  verdict: 'CLEAN',
  enforced: false,
  ...overrides,
});

describe('strengthOfMatch', () => {
  it('lê a força do fim do match do evento (inclusive E7 com a causa)', () => {
    expect(strengthOfMatch('E2/STRONG')).toBe('STRONG');
    expect(strengthOfMatch('E7:E3a/MEDIUM')).toBe('MEDIUM');
    expect(strengthOfMatch('T_CLASSIFIER/MEDIUM')).toBe('MEDIUM');
    expect(strengthOfMatch('ACCOUNT_SUSPENDED/NONE')).toBe('NONE');
  });

  it('match sem força (termo da trava de texto, código do provedor) não vale', () => {
    expect(strengthOfMatch('<TERMO_DA_TRAVA>')).toBeNull();
    expect(strengthOfMatch('E2/forte')).toBeNull();
    expect(strengthOfMatch(null)).toBeNull();
  });
});

describe('countMediumPoints', () => {
  it('uma tentativa conta uma vez; evento sem geração conta sozinho; sinal sem evento gravado soma 1', () => {
    const events = [
      { id: 'e1', generationId: 'g1' },
      { id: 'e2', generationId: 'g1' },
      { id: 'e3', generationId: null },
      { id: 'e4', generationId: 'g2' },
    ];
    expect(countMediumPoints(events, false)).toBe(3);
    expect(countMediumPoints(events, true)).toBe(4);
    expect(countMediumPoints([], false)).toBe(0);
  });
});

describe('usableStrikePhotos', () => {
  it('só fica foto com algum hash válido', () => {
    expect(
      usableStrikePhotos([
        { phash: null, sha256: null, blockId: null },
        { phash: null, sha256: 'nao-e-hash', blockId: null },
        { phash: '0123456789abcdef', sha256: null, blockId: null },
        { phash: null, sha256: 'a'.repeat(64), blockId: null },
        { phash: null, sha256: null, blockId: 'block-1' },
      ]),
    ).toHaveLength(3);
    expect(usableStrikePhotos(undefined)).toEqual([]);
  });
});

describe('photoRetryDecision (limite de novas tentativas com foto)', () => {
  const decide = (
    rows: PhotoAttemptRow[],
    options: {
      currentGenerationId?: string | null;
      openPhotoEvent?: boolean;
    } = {},
  ) =>
    photoRetryDecision(rows, {
      now: NOW,
      currentGenerationId: options.currentGenerationId ?? null,
      openPhotoEvent: options.openPhotoEvent ?? false,
    });

  it('sem bloqueio de foto: livre, por mais tentativas que haja', () => {
    const rows = Array.from({ length: 30 }, (_, index) => row(index));
    expect(decide(rows)).toMatchObject({ allowed: true, restricted: false });
  });

  it('bloqueio que só ficou registrado (sombra) não limita', () => {
    expect(
      decide([row(1, { verdict: 'BLOCK', enforced: false })]),
    ).toMatchObject({ allowed: true, restricted: false });
  });

  it('1 a cada 10 min depois do bloqueio (a bloqueada conta)', () => {
    const blocked = row(5, { verdict: 'BLOCK', enforced: true });
    expect(decide([blocked])).toMatchObject({
      allowed: false,
      restricted: true,
      attemptsLast10Min: 1,
    });
    const older = row(11, { verdict: 'BLOCK', enforced: true });
    expect(decide([older])).toMatchObject({ allowed: true, restricted: true });
  });

  it('5 em 24 h desde o bloqueio; tentativas de antes do bloqueio não contam', () => {
    const beforeBlock = Array.from({ length: 10 }, (_, index) =>
      row(600 + index),
    );
    const blocked = row(500, { verdict: 'HOLD', enforced: true });
    const after = [row(400), row(300), row(200)];
    expect(decide([...beforeBlock, blocked, ...after])).toMatchObject({
      allowed: true,
      attemptsCounted: 4,
    });
    expect(decide([...beforeBlock, blocked, ...after, row(100)])).toMatchObject(
      { allowed: false, attemptsCounted: 5 },
    );
  });

  it('a geração atual não conta contra ela mesma (nova tentativa da fila depois de indisponível)', () => {
    const blocked = row(30, { verdict: 'BLOCK', enforced: true });
    const current = row(2, {
      generationId: 'gen-atual',
      verdict: 'UNAVAILABLE',
    });
    expect(
      decide([blocked, current], { currentGenerationId: 'gen-atual' }),
    ).toMatchObject({ allowed: true });
    expect(decide([blocked, current])).toMatchObject({ allowed: false });
  });

  it('rota sem fila: cada rodada (sem geração) é uma tentativa pelo horário', () => {
    const blocked = row(60, {
      generationId: null,
      verdict: 'BLOCK',
      enforced: true,
    });
    const sameBatch = [
      row(3, { generationId: null }),
      row(3, { generationId: null }),
    ];
    expect(decide([blocked, ...sameBatch])).toMatchObject({
      attemptsLast10Min: 1,
      attemptsCounted: 2,
    });
  });

  it('evento de foto aberto (sem revisão) mantém o limite depois das 24 h', () => {
    expect(decide([row(5)], { openPhotoEvent: true })).toMatchObject({
      allowed: false,
      restricted: true,
    });
    expect(decide([], { openPhotoEvent: true })).toMatchObject({
      allowed: true,
      restricted: true,
    });
  });
});

describe('suspensionHoldRows', () => {
  it('uma linha HOLD agida por mídia, regra interna, versão das regras, sem hash', () => {
    const rows = suspensionHoldRows({
      generationId: 'gen-1',
      userId: 'user-1',
      mediaKeys: ['generations/gen-1/a.png', 'generations/gen-1/a.png', null],
      mode: 'shadow',
    });
    expect(rows).toEqual([
      expect.objectContaining({
        generationId: 'gen-1',
        stage: 'OUTPUT',
        mediaKey: 'generations/gen-1/a.png',
        verdict: 'HOLD',
        ruleId: 'ACCOUNT_SUSPENDED',
        strength: 'NONE',
        enforced: true,
        rulesVersion: RULES_VERSION,
        mode: 'shadow',
        sha256: null,
        phash: null,
      }),
    ]);
  });
});

describe('suspensionReasonOf', () => {
  it('motivo interno com causa, regra e ids; nunca passa de 300 caracteres', () => {
    const reason = suspensionReasonOf(['strong'], {
      layer: 'input',
      match: 'E2/STRONG',
      eventId: 'evt-1',
      generationId: 'gen-1',
    });
    expect(reason).toBe(
      'sinal forte · input:E2/STRONG · evento evt-1 · geração gen-1',
    );
    const long = suspensionReasonOf(['cross_account'], {
      layer: 'input',
      match: 'E1/STRONG',
      eventId: null,
      generationId: null,
      linkedAccounts: Array.from(
        { length: 40 },
        (_, index) => `conta-${index}-xxxxxxxx`,
      ),
    });
    expect(long.length).toBeLessThanOrEqual(300);
  });
});

describe('isUserId', () => {
  it('só aceita formato de id', () => {
    expect(isUserId('cmabc123def456ghi789jkl0')).toBe(true);
    expect(isUserId('curto')).toBe(false);
    expect(isUserId('user-1; DROP')).toBe(false);
    expect(isUserId(42)).toBe(false);
  });
});

describe('aviso de suspensão', () => {
  it('idioma pela conta (pt padrão)', () => {
    expect(noticeLocaleOf('pt-BR')).toBe('pt');
    expect(noticeLocaleOf('es-ES')).toBe('es');
    expect(noticeLocaleOf('en')).toBe('en');
    expect(noticeLocaleOf(null)).toBe('pt');
  });

  it('canal de revisão só e-mail ou https', () => {
    expect(reviewChannelOf('revisao@exemplo.com')).toEqual({
      kind: 'email',
      value: 'revisao@exemplo.com',
    });
    expect(reviewChannelOf('https://exemplo.com/revisao')).toEqual({
      kind: 'url',
      value: 'https://exemplo.com/revisao',
    });
    expect(reviewChannelOf('javascript:alert(1)')).toBeNull();
    expect(reviewChannelOf('http://exemplo.com')).toBeNull();
  });

  it('motivo genérico, decisão automática e canal de revisão (LGPD art. 20); sem sinal técnico nem marca', () => {
    const notice = buildSuspensionNotice({
      name: 'Ana <script>',
      locale: 'pt-BR',
      reviewContact: 'revisao@exemplo.com',
      siteUrl: null,
    });
    expect(notice.subject).toBe('Sua conta foi suspensa para revisão');
    expect(notice.html).toContain('forma automática');
    expect(notice.html).toContain('art. 20');
    expect(notice.html).toContain('mailto:revisao@exemplo.com');
    expect(notice.html).toContain('Ana &lt;script&gt;');
    expect(notice.html).not.toMatch(
      /E[1-7]|S[1-7]|idade|rosto|Rekognition|The AI Model Lab/i,
    );
  });

  it('sem canal próprio usa o site; sem nada, manda falar com o suporte', () => {
    const withSite = buildSuspensionNotice({
      name: null,
      locale: 'es',
      reviewContact: null,
      siteUrl: 'https://exemplo.com',
    });
    expect(withSite.subject).toContain('suspendida');
    expect(withSite.html).toContain('href="https://exemplo.com/"');
    const bare = buildSuspensionNotice({
      name: null,
      locale: 'en',
      reviewContact: null,
      siteUrl: 'http://localhost:5173',
    });
    expect(bare.html).toContain('contact support through the website');
    expect(bare.html).not.toContain('href=');
  });
});
