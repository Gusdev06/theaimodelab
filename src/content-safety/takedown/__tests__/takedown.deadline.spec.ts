import { ContentReportCategory, ContentReportStatus } from '@prisma/client';
import {
  isVictimTakedownRequest,
  TAKEDOWN_DUE_SOON_MS,
  takedownClock,
  takedownDueAtFor,
  VICTIM_TAKEDOWN_WINDOW_MS,
} from '../takedown.deadline';

const HOUR = 60 * 60_000;
const RECEIVED = new Date('2026-10-22T12:00:00Z');

describe('prazo da remoção pedida pela vítima (48 h)', () => {
  it('o prazo é de 48 h', () => {
    expect(VICTIM_TAKEDOWN_WINDOW_MS).toBe(48 * HOUR);
  });

  it.each([
    ['sou a pessoa da imagem', ContentReportCategory.SELF_DEPICTED, false, true],
    ['sou a pessoa da imagem (caixa marcada)', ContentReportCategory.SELF_DEPICTED, true, true],
    ['íntima sem consentimento pela própria pessoa', ContentReportCategory.NON_CONSENSUAL, true, true],
    ['íntima sem consentimento por terceiro', ContentReportCategory.NON_CONSENSUAL, false, false],
    ['uso de imagem pela própria pessoa', ContentReportCategory.IMPERSONATION, true, false],
    ['menor de idade', ContentReportCategory.MINOR, false, false],
    ['direito autoral', ContentReportCategory.COPYRIGHT, true, false],
  ])('%s → pedido da vítima: %s', (_label, category, isDepictedPerson, expected) => {
    expect(isVictimTakedownRequest({ category, isDepictedPerson })).toBe(expected);
    const due = takedownDueAtFor({ category, isDepictedPerson }, RECEIVED);
    expect(due?.toISOString() ?? null).toBe(
      expected ? new Date(RECEIVED.getTime() + 48 * HOUR).toISOString() : null,
    );
  });

  describe('relógio', () => {
    const dueAt = new Date(RECEIVED.getTime() + VICTIM_TAKEDOWN_WINDOW_MS);
    const open = { takedownDueAt: dueAt, takedownDoneAt: null, status: ContentReportStatus.OPEN };

    it('sem prazo (denúncia comum) = sem relógio', () => {
      expect(takedownClock({ ...open, takedownDueAt: null }, RECEIVED)).toBeNull();
    });

    it('recém-chegada: pending com 48 h pela frente', () => {
      expect(takedownClock(open, RECEIVED)).toEqual({
        dueAt: dueAt.toISOString(),
        doneAt: null,
        remainingMs: 48 * HOUR,
        state: 'pending',
      });
    });

    it('a 6 h do fim: due_soon; 1 ms depois do prazo: overdue com tempo negativo', () => {
      const soon = new Date(dueAt.getTime() - TAKEDOWN_DUE_SOON_MS);
      expect(takedownClock(open, soon)).toMatchObject({ state: 'due_soon', remainingMs: TAKEDOWN_DUE_SOON_MS });
      const late = new Date(dueAt.getTime() + 1);
      expect(takedownClock(open, late)).toMatchObject({ state: 'overdue', remainingMs: -1 });
      // em análise não para o relógio
      expect(takedownClock({ ...open, status: ContentReportStatus.IN_REVIEW }, late)).toMatchObject({ state: 'overdue' });
    });

    it('feita no prazo: done; feita depois: done_late; o relógio para', () => {
      const inTime = new Date(dueAt.getTime() - HOUR);
      expect(
        takedownClock({ ...open, takedownDoneAt: inTime, status: ContentReportStatus.ACTIONED }, new Date(dueAt.getTime() + 10 * HOUR)),
      ).toEqual({ dueAt: dueAt.toISOString(), doneAt: inTime.toISOString(), remainingMs: null, state: 'done' });
      const late = new Date(dueAt.getTime() + HOUR);
      expect(takedownClock({ ...open, takedownDoneAt: late, status: ContentReportStatus.ACTIONED }, late)).toMatchObject({
        state: 'done_late',
        remainingMs: null,
      });
    });

    it('descartada sem remoção: dismissed, sem contagem', () => {
      expect(takedownClock({ ...open, status: ContentReportStatus.DISMISSED }, new Date(dueAt.getTime() + HOUR))).toMatchObject({
        state: 'dismissed',
        remainingMs: null,
      });
    });

    it('marcar removido no PATCH (ACTIONED) sem a remoção não fecha o prazo', () => {
      expect(takedownClock({ ...open, status: ContentReportStatus.ACTIONED }, new Date(dueAt.getTime() + 1))).toMatchObject({
        state: 'overdue',
      });
    });
  });
});
