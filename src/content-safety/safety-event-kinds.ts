import { ContentSafetyEventKind } from '@prisma/client';

/**
 * Tipos de evento de segurança que seguram a conta e as gerações na guarda legal (exclusão LGPD e cron da galeria),
 * em qualquer data e sem o admin poder ignorar, como a recusa do provedor com mídia da conta (provider_minor):
 *  - IMAGE_MINOR_BLOCKED / OUTPUT_MINOR_BLOCKED: foto, quadro ou resultado com sinal forte ou médio de menor (a
 *    evidência foi para o bucket privado);
 *  - INPUT_HELD / OUTPUT_HELD: entrada ou resultado segurado para revisão, enquanto o revisor não decide (liberado =
 *    releasedAt preenchido).
 * REFINER_BLOCKED e TEXT_CLASSIFIER_FLAGGED não entram: são texto (o do refinador é escrito pela própria plataforma).
 * Arquivo sem dependência de serviço: a exclusão LGPD, o cron da galeria e a liberação leem daqui.
 */
export const IMAGE_EVIDENCE_EVENT_KINDS: readonly ContentSafetyEventKind[] = [
  ContentSafetyEventKind.IMAGE_MINOR_BLOCKED,
  ContentSafetyEventKind.OUTPUT_MINOR_BLOCKED,
  ContentSafetyEventKind.INPUT_HELD,
  ContentSafetyEventKind.OUTPUT_HELD,
];

/** O que o jurídico (ou o revisor) pode liberar: o bloqueio por menor de texto/provedor e os de imagem. */
export const RELEASABLE_SAFETY_EVENT_KINDS: ReadonlySet<ContentSafetyEventKind> =
  new Set<ContentSafetyEventKind>([
    ContentSafetyEventKind.MINOR_BLOCKED,
    ...IMAGE_EVIDENCE_EVENT_KINDS,
  ]);

/** Rota dos eventos gravados pela confirmação do revisor (`review:input`, `review:output`, `review:text`). */
export const REVIEW_EVENT_ROUTE_PREFIX = 'review:';

/** Mensagem única para quem não pode revisar (não diz se a rota existe nem quem pode). */
export const SAFETY_REVIEWER_FORBIDDEN =
  'Acesso restrito aos revisores de segurança designados.';

/** Camadas em que o revisor confirma um caso (o evento da confirmação leva `review:<camada>` na rota). */
export type ReviewConfirmedLayer = 'input' | 'output' | 'text';
const REVIEW_CONFIRMED_ROUTE = /^review:(input|output|text)$/;

/** Rota do evento gravado pela confirmação do revisor. */
export function reviewConfirmedRoute(layer: ReviewConfirmedLayer): string {
  return `${REVIEW_EVENT_ROUTE_PREFIX}${layer}`;
}

/** O evento é caso confirmado pelo revisor de segurança (vale em qualquer data e só o revisor libera)? */
export function isReviewConfirmedRoute(route: string | null | undefined): boolean {
  return typeof route === 'string' && REVIEW_CONFIRMED_ROUTE.test(route);
}

/**
 * Só o revisor designado (SAFETY_REVIEWER_IDS) libera: a evidência de imagem (foto ou resultado barrado, entrada ou
 * resultado segurado) e o caso confirmado pelo revisor. O bloqueio por menor de texto ou do provedor (PR #4) continua
 * com o jurídico, por qualquer ADMIN, como no cockpit.
 */
export function releaseNeedsReviewer(event: {
  kind: ContentSafetyEventKind;
  route: string | null | undefined;
}): boolean {
  return (
    IMAGE_EVIDENCE_EVENT_KINDS.includes(event.kind) ||
    isReviewConfirmedRoute(event.route)
  );
}
