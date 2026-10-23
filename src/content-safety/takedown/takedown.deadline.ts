import { ContentReportCategory, ContentReportStatus } from '@prisma/client';

/**
 * Prazo da remoção pedida pela própria pessoa retratada (camada 8): o TAKE IT DOWN Act dá 48 h a partir do pedido
 * válido para tirar do ar a imagem íntima e as cópias idênticas conhecidas. Regras puras, sem banco nem relógio
 * escondido (o `now` vem de quem chama).
 */

/** 48 h contadas da gravação da denúncia. */
export const VICTIM_TAKEDOWN_WINDOW_MS = 48 * 60 * 60_000;
/** Faixa de atenção do cockpit: vence nas próximas 6 h. */
export const TAKEDOWN_DUE_SOON_MS = 6 * 60 * 60_000;

/**
 * A denúncia é o pedido de remoção da própria pessoa retratada? O tipo "sou a pessoa da imagem" (SELF_DEPICTED) e a
 * íntima sem consentimento com a caixa "sou a pessoa" marcada (formulário da PR #4, antes do tipo novo).
 */
export function isVictimTakedownRequest(input: {
  category: ContentReportCategory;
  isDepictedPerson?: boolean | null;
}): boolean {
  if (input.category === ContentReportCategory.SELF_DEPICTED) return true;
  return (
    input.category === ContentReportCategory.NON_CONSENSUAL &&
    input.isDepictedPerson === true
  );
}

/** Prazo legal da remoção, gravado na denúncia; null quando a denúncia não é pedido da vítima. */
export function takedownDueAtFor(
  input: { category: ContentReportCategory; isDepictedPerson?: boolean | null },
  receivedAt: Date,
): Date | null {
  if (!isVictimTakedownRequest(input)) return null;
  return new Date(receivedAt.getTime() + VICTIM_TAKEDOWN_WINDOW_MS);
}

/**
 * Situação do prazo para o cockpit:
 * - pending: aberto, mais de 6 h para vencer;
 * - due_soon: aberto, vence em até 6 h;
 * - overdue: aberto e vencido;
 * - done: arquivos fora do ar dentro do prazo; done_late: fora do ar depois do prazo;
 * - dismissed: denúncia descartada sem remoção (o relógio para).
 */
export type TakedownState =
  | 'pending'
  | 'due_soon'
  | 'overdue'
  | 'done'
  | 'done_late'
  | 'dismissed';

export interface TakedownClock {
  dueAt: string;
  doneAt: string | null;
  /** ms até o prazo (negativo = vencido há tanto); null quando o relógio parou (feito ou descartado) */
  remainingMs: number | null;
  state: TakedownState;
}

/** Relógio da remoção de uma denúncia; null quando ela não tem prazo de vítima. */
export function takedownClock(
  report: {
    takedownDueAt: Date | null;
    takedownDoneAt: Date | null;
    status: ContentReportStatus;
  },
  now: Date,
): TakedownClock | null {
  if (!report.takedownDueAt) return null;
  const due = report.takedownDueAt.getTime();
  const dueAt = report.takedownDueAt.toISOString();
  if (report.takedownDoneAt) {
    return {
      dueAt,
      doneAt: report.takedownDoneAt.toISOString(),
      remainingMs: null,
      state: report.takedownDoneAt.getTime() <= due ? 'done' : 'done_late',
    };
  }
  if (report.status === ContentReportStatus.DISMISSED) {
    return { dueAt, doneAt: null, remainingMs: null, state: 'dismissed' };
  }
  const remainingMs = due - now.getTime();
  const state: TakedownState =
    remainingMs < 0
      ? 'overdue'
      : remainingMs <= TAKEDOWN_DUE_SOON_MS
        ? 'due_soon'
        : 'pending';
  return { dueAt, doneAt: null, remainingMs, state };
}
