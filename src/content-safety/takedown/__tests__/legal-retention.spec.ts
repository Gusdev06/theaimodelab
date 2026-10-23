import { Logger } from '@nestjs/common';
import { LegalRetentionReader } from '../legal-retention';

/*
 * A régua da guarda é a da exclusão LGPD (PR #4), lida de verdade (readHoldAccount, scanReportsCitingAccount,
 * loadLegalHold, minorBlockedGenerationIds) sobre um banco simulado.
 */

type Row = Record<string, unknown>;

const GENERATION = `cgen${'0'.repeat(20)}1`;
const OTHER_GENERATION = `cgen${'0'.repeat(20)}2`;

function report(extra: Row): Row {
  return {
    id: 'rep-1',
    category: 'SELF_DEPICTED',
    status: 'OPEN',
    target: `https://www.theaimodelab.com/g/${GENERATION}`,
    description: 'Sou eu nessa imagem e não autorizei.',
    isDepictedPerson: true,
    urgent: false,
    reporterUserId: null,
    reporterEmail: 'vitima@exemplo.com',
    evidenceReleasedAt: null,
    createdAt: new Date('2026-10-20T00:00:00Z'),
    updatedAt: new Date('2026-10-20T00:00:00Z'),
    ...extra,
  };
}

function setup(opts: { reports?: Row[]; events?: Row[]; scans?: Row[]; failUser?: boolean } = {}) {
  const reports = opts.reports ?? [];
  const events = opts.events ?? [];
  const kindMatches = (row: Row, kind: unknown) =>
    kind === undefined || (typeof kind === 'string' ? row.kind === kind : (kind as { in: unknown[] }).in.includes(row.kind));
  const prisma = {
    user: {
      findUnique: jest.fn(async () => {
        if (opts.failUser) throw new Error('banco fora do ar');
        return { id: 'dona-1', email: 'dona@exemplo.com' };
      }),
    },
    generation: {
      findMany: jest.fn(async () => [
        { id: GENERATION, userAvatarId: null, voiceProfileId: null, parameters: null },
        { id: OTHER_GENERATION, userAvatarId: null, voiceProfileId: null, parameters: null },
      ]),
    },
    generationInputImage: { findMany: jest.fn(async () => []) },
    communityPost: { findMany: jest.fn(async () => []) },
    userAvatar: { findMany: jest.fn(async () => []) },
    voiceProfile: { findMany: jest.fn(async () => []) },
    contentReport: {
      findMany: jest.fn(async ({ where }: { where: { status?: { not?: string }; id?: { in?: string[]; gt?: string } } }) =>
        reports.filter(
          (row) =>
            (!where.status?.not || row.status !== where.status.not) &&
            (!where.id?.in || where.id.in.includes(row.id as string)) &&
            (!where.id?.gt || (row.id as string) > where.id.gt),
        ),
      ),
    },
    contentSafetyEvent: {
      findMany: jest.fn(async ({ where }: { where: { kind?: unknown; generationId?: { in: string[] }; userId?: string } }) =>
        events.filter(
          (row) =>
            kindMatches(row, where.kind) &&
            row.releasedAt == null &&
            (!where.generationId || where.generationId.in.includes(row.generationId as string)) &&
            (!where.userId || row.userId === where.userId),
        ),
      ),
    },
    contentSafetyScan: {
      findMany: jest.fn(async ({ where }: { where: { generationId: { in: string[] } } }) =>
        (opts.scans ?? []).filter((row) => where.generationId.in.includes(row.generationId as string) && row.evidenceKey),
      ),
    },
  };
  return { reader: new LegalRetentionReader(prisma as never), prisma };
}

const subject = [{ id: GENERATION, userId: 'dona-1' }];

describe('LegalRetentionReader (guarda legal na remoção)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('"sou a pessoa da imagem" aberta citando a geração: guarda (a evidência fica, como a íntima sem consentimento)', async () => {
    const { reader } = setup({ reports: [report({})] });
    const reasons = await reader.reasonsFor(subject);
    expect(reasons.get(GENERATION)).toMatch(/guarda legal da conta \(report\)/);
  });

  it('direito autoral citando a geração: sem guarda (o arquivo pode ser apagado)', async () => {
    const { reader } = setup({ reports: [report({ category: 'COPYRIGHT', isDepictedPerson: false })] });
    expect((await reader.reasonsFor(subject)).get(GENERATION)).toBeNull();
  });

  it('denúncia descartada, ou confirmada com a evidência liberada: sem guarda', async () => {
    const dismissed = setup({ reports: [report({ status: 'DISMISSED' })] });
    expect((await dismissed.reader.reasonsFor(subject)).get(GENERATION)).toBeNull();
    const released = setup({ reports: [report({ status: 'ACTIONED', evidenceReleasedAt: new Date('2026-10-21T00:00:00Z') })] });
    expect((await released.reader.reasonsFor(subject)).get(GENERATION)).toBeNull();
  });

  it('bloqueio por menor ligado à geração (sem liberação do jurídico): guarda', async () => {
    const { reader } = setup({
      events: [{ kind: 'MINOR_BLOCKED', generationId: GENERATION, userId: 'outra', route: 'generate', releasedAt: null }],
    });
    expect((await reader.reasonsFor(subject)).get(GENERATION)).toMatch(/bloqueio por menor/);
  });

  it('checagem da geração com evidência guardada: guarda', async () => {
    const { reader } = setup({ scans: [{ generationId: GENERATION, evidenceKey: 'evidence/abc/x/out.png' }] });
    expect((await reader.reasonsFor(subject)).get(GENERATION)).toBe('checagem com evidência guardada');
  });

  it('o revisor pede para preservar: guarda mesmo sem motivo legal', async () => {
    const { reader } = setup();
    expect((await reader.reasonsFor(subject, { preserveEvidence: true })).get(GENERATION)).toBe('o revisor pediu para preservar');
    expect((await reader.reasonsFor(subject)).get(GENERATION)).toBeNull();
  });

  it('erro ao ler a guarda: preserva (nunca apaga sem conferir)', async () => {
    const { reader } = setup({ failUser: true });
    expect((await reader.reasonsFor(subject)).get(GENERATION)).toMatch(/guarda não conferida/);
  });
});
