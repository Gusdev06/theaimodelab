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
