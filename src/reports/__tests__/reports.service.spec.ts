import { ContentReportCategory } from '@prisma/client';
import { ReportsService } from '../reports.service';

function setup(opts: { alertTo?: string; alertSends?: boolean } = {}) {
  const created: Record<string, unknown>[] = [];
  const prisma = {
    contentReport: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `rep-${created.length + 1}`, createdAt: new Date('2026-10-15T12:00:00Z'), ...data };
        created.push(row);
        return row;
      }),
    },
  };
  const email = { sendContentReportAlert: jest.fn().mockResolvedValue(opts.alertSends ?? true) };
  const config = { get: jest.fn((key: string) => (key === 'REPORTS_ALERT_EMAIL' ? opts.alertTo : undefined)) };
  const service = new ReportsService(prisma as never, email as never, config as never);
  return { service, prisma, email, created };
}

const base = { target: 'https://www.theaimodelab.com/p/abc', description: 'Esta imagem usa o meu rosto sem autorização.' };

describe('ReportsService', () => {
  it('denúncia urgente (imagem íntima sem consentimento) é gravada e avisa a equipe na hora', async () => {
    const { service, email, created } = setup({ alertTo: 'support@help.theaimodelab.com' });
    const out = await service.create({ ...base, category: ContentReportCategory.NON_CONSENSUAL, isDepictedPerson: true, reporterEmail: 'Pessoa@Exemplo.com' }, { ip: '203.0.113.9' });
    expect(out).toEqual({ ok: true, id: 'rep-1' });
    expect(created[0]).toMatchObject({ category: 'NON_CONSENSUAL', isDepictedPerson: true, reporterEmail: 'pessoa@exemplo.com' });
    expect(created[0].ipHash).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.stringify(created[0])).not.toContain('203.0.113.9');
    expect(email.sendContentReportAlert).toHaveBeenCalledWith('support@help.theaimodelab.com', expect.objectContaining({ urgent: true, category: 'NON_CONSENSUAL' }));
  });

  it('menor também é urgente; direito autoral não', async () => {
    const { service, email } = setup({ alertTo: 'x@y.com' });
    await service.create({ ...base, category: ContentReportCategory.MINOR }, {});
    await service.create({ ...base, category: ContentReportCategory.COPYRIGHT }, {});
    expect(email.sendContentReportAlert.mock.calls[0][1]).toMatchObject({ urgent: true });
    expect(email.sendContentReportAlert.mock.calls[1][1]).toMatchObject({ urgent: false });
  });

  it('isca preenchida (robô): responde ok mas não grava nem avisa', async () => {
    const { service, prisma, email } = setup({ alertTo: 'x@y.com' });
    const out = await service.create({ ...base, category: ContentReportCategory.OTHER, website: 'http://spam' }, {});
    expect(out).toEqual({ ok: true, id: null });
    expect(prisma.contentReport.create).not.toHaveBeenCalled();
    expect(email.sendContentReportAlert).not.toHaveBeenCalled();
  });

  it('aviso por e-mail que falha não perde a denúncia (fica no admin)', async () => {
    const { service, created } = setup({ alertTo: 'x@y.com', alertSends: false });
    const out = await service.create({ ...base, category: ContentReportCategory.MINOR }, {});
    expect(out.ok).toBe(true);
    expect(created).toHaveLength(1);
  });

  it('sem REPORTS_ALERT_EMAIL: grava e não tenta enviar', async () => {
    const { service, email, created } = setup({});
    await service.create({ ...base, category: ContentReportCategory.IMPERSONATION }, {});
    expect(created).toHaveLength(1);
    expect(email.sendContentReportAlert).not.toHaveBeenCalled();
  });
});
