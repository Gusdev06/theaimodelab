import { ContentSafetyEventKind, type Prisma } from '@prisma/client';
import type { TerminalSafetyBlockError } from '../../generations/errors/content-safety.error';
import type { Strength } from '../image-safety/types';

/**
 * Contrato da camada 6 (pontos e suspensão). Arquivo sem dependência de serviço: o ImageSafetyService lê o token e os
 * tipos daqui sem import circular com o StrikesService (que depende da fila e do processor só pelos efeitos).
 */

/** Serviço de pontos (StrikesPort), injetado no ImageSafetyService. */
export const STRIKES = Symbol('STRIKES');
/** O que a suspensão aciona fora do banco (fila, encerramento com estorno, quarentena, aviso). */
export const SUSPENSION_EFFECTS = Symbol('SUSPENSION_EFFECTS');

/** Quem age na trilha (content_safety_access_log.actor_id) quando a decisão é automática. */
export const STRIKES_ACTOR_ID = 'system:strikes';
/** Ações da camada 6 na trilha de segurança (alvo `user`). */
export const STRIKE_ACCESS_ACTIONS = Object.freeze({
  /** conta suspensa pela regra (sinal forte, pontos, repetição) */
  suspend: 'suspend',
  /** a regra de repetição teria suspendido (sombra): só registro, para calibrar */
  suspendShadow: 'suspend_shadow',
  /** o revisor designado reativou a conta suspensa (o admin comum não reativa enquanto a última linha for suspend) */
  reactivate: 'reactivate',
  /** resultado do aviso de suspensão (prova do envio ou da falha); o motivo é um SuspendNoticeResult */
  suspendNotice: 'suspend_notice',
});
/**
 * Resultado do aviso de suspensão gravado na trilha (sem e-mail e sem texto do provedor):
 *  - sent: o serviço de e-mail aceitou;
 *  - failed:not_sent: e-mail desligado ou sem id de envio (avisar por outro canal);
 *  - failed:error: o provedor recusou ou a leitura da conta falhou;
 *  - skipped:no_email: conta sem e-mail.
 * A fila do suporte acha as contas suspensas cuja última linha suspend_notice não é sent.
 */
export type SuspendNoticeResult =
  | 'sent'
  | 'failed:not_sent'
  | 'failed:error'
  | 'skipped:no_email';
/** O que a leitura da suspensão aberta usa do banco (o PrismaService ou o cliente de uma transação). */
export type SafetySuspensionDb = Pick<Prisma.TransactionClient, 'contentSafetyAccessLog'>;

/**
 * A conta está suspensa pela camada 6 e ninguém do papel de revisor a reativou? Última linha da trilha da conta entre a
 * suspensão automática e a reativação pelo revisor. Conta desativada à mão pelo admin (sem linha suspend) dá false.
 * Erro de banco lança (quem chama fecha).
 */
export async function hasOpenSafetySuspension(
  db: SafetySuspensionDb,
  userId: string,
): Promise<boolean> {
  const last = await db.contentSafetyAccessLog.findFirst({
    where: {
      targetType: 'user',
      targetId: userId,
      OR: [
        { actorId: STRIKES_ACTOR_ID, action: STRIKE_ACCESS_ACTIONS.suspend },
        { action: STRIKE_ACCESS_ACTIONS.reactivate },
      ],
    },
    orderBy: { createdAt: 'desc' },
    select: { action: true },
  });
  return last?.action === STRIKE_ACCESS_ACTIONS.suspend;
}

/** Regra interna das checagens e erros da camada 6 (nunca chega à cliente: o código público é o genérico). */
export const ACCOUNT_SUSPENDED_RULE = 'ACCOUNT_SUSPENDED';
export const PHOTO_RETRY_LIMIT_RULE = 'PHOTO_RETRY_LIMIT';
/** Quem "leu" na linha de checagem que segura o resultado da conta suspensa. */
export const STRIKES_SCANNER = 'account-suspension';
/** Motivo gravado nos posts da comunidade tirados do ar pela suspensão (a linha fica, só sai do feed). */
export const SAFETY_SUSPENSION_POST_REJECTION_REASON = 'safety_suspension';

/**
 * Eventos que podem levar ponto: só os da checagem da plataforma, com a força no `match` ("regra/FORÇA"). O
 * MINOR_BLOCKED da trava de texto (camada 1) não entra aqui: a guarda legal da PR #4 já o conta por tentativa.
 */
export const STRIKE_EVENT_KINDS: readonly ContentSafetyEventKind[] = [
  ContentSafetyEventKind.IMAGE_MINOR_BLOCKED,
  ContentSafetyEventKind.INPUT_HELD,
  ContentSafetyEventKind.OUTPUT_HELD,
  ContentSafetyEventKind.OUTPUT_MINOR_BLOCKED,
  ContentSafetyEventKind.TEXT_CLASSIFIER_FLAGGED,
  ContentSafetyEventKind.REFINER_BLOCKED,
];

/**
 * Por que a conta foi (ou, na sombra, teria sido) suspensa:
 *  - strong: sinal forte (tolerância zero);
 *  - medium_points: 3 pontos médios em 90 dias;
 *  - repeat_hash: 3 bloqueios de foto parecida (pHash) em 24 h na mesma conta;
 *  - cross_account: a mesma foto bloqueada em outra conta (as duas vão para revisão).
 */
export type SuspensionCause =
  | 'strong'
  | 'medium_points'
  | 'repeat_hash'
  | 'cross_account';

/** Foto (ou quadro) de entrada barrada ou segurada com sinal forte ou médio. O caso leve nunca entra (LGPD art. 14). */
export interface StrikePhoto {
  phash: string | null;
  /** sha256 do arquivo inteiro (mesmo valor gravado nas checagens) */
  sha256: string | null;
  /** linha da lista de bloqueio própria que a foto acertou (E1), para achar a conta de origem */
  blockId: string | null;
}

/** Contexto do sinal. Nunca leva texto do pedido: só regra, força e ids. */
export interface StrikeSignalContext {
  /** camada que barrou */
  layer: 'input' | 'output' | 'text' | 'refiner';
  /** regra e força no formato do evento (ex.: "E2/STRONG") */
  match: string;
  generationId: string | null;
  /** fotos barradas ou seguradas desta tentativa (repetição na conta e entre contas) */
  photos?: readonly StrikePhoto[];
  /** relógio (testes) */
  now?: Date;
}

export interface StrikeOutcome {
  /** none: sem efeito; point: ponto médio contado; suspended: a conta está suspensa por este sinal */
  action: 'none' | 'point' | 'suspended';
  /** pontos médios da conta nos últimos 90 dias, contando este (0 quando o sinal não é médio) */
  points: number;
  /** o que suspendeu a conta agora */
  causes: SuspensionCause[];
  /** o que teria suspendido, mas ainda está na sombra (repetição por hash fora do enforce) */
  shadowCauses: SuspensionCause[];
  /** outras contas com a mesma foto barrada (para revisão) */
  linkedAccounts: string[];
}

/** Camada 6 vista pelo porteiro de imagem (ImageSafetyService). */
export interface StrikesPort {
  /** só roda com IMAGE_SAFETY_MODE diferente de off */
  readonly enabled: boolean;
  /** aplica o sinal de um bloqueio ou retenção que agiu. Nunca lança. */
  applySignal(
    userId: string | null,
    strength: Strength,
    eventId: string | null,
    ctx: StrikeSignalContext,
  ): Promise<StrikeOutcome>;
  /** a conta está suspensa (inativa)? Erro de banco lança (quem chama fecha: espera ou recusa). */
  isSuspended(userId: string | null): Promise<boolean>;
  /** depois de um bloqueio de foto: a conta pode tentar de novo com foto agora? Erro de banco lança. */
  photoRetryAllowed(
    userId: string | null,
    options: { currentGenerationId: string | null; now?: Date },
  ): Promise<boolean>;
}

/* ------------------------------------------------------------------ efeitos (trocáveis nos testes) */

/** O mínimo de um job do BullMQ que o cancelamento usa. */
export interface JobLike {
  id?: string;
  name: string;
  data: unknown;
  remove(): Promise<void>;
}

/** O mínimo de uma fila do BullMQ que o cancelamento usa. */
export interface QueueLike {
  getJobs(
    types: Array<'waiting' | 'delayed' | 'prioritized' | 'paused'>,
    start: number,
    end: number,
    asc?: boolean,
  ): Promise<Array<JobLike | undefined | null>>;
}

export interface GenerationQueueRef {
  name: string;
  queue: QueueLike;
  /** fila do ilimitado: o lock da conta sai junto com o job */
  unlimited: boolean;
}

export interface SuspensionEffects {
  /** filas de geração (as duas: normal e ilimitado); vazio quando o módulo de gerações não está montado */
  queues(): GenerationQueueRef[];
  /** encerra a geração aberta com estorno, SSE e entradas mantidas (GenerationProcessor.failForSafety) */
  failGeneration(
    generationId: string,
    error: TerminalSafetyBlockError,
  ): Promise<void>;
  /** solta o lock do ilimitado da conta (o job que esperava saiu da fila) */
  releaseUnlimitedLock(userId: string): Promise<void>;
  /** resultados da conta que esperam checagem na quarentena passam a esperar um revisor; devolve quantos */
  holdUncheckedOutputs(userId: string): Promise<number>;
  /** aviso de suspensão para a pessoa; true = o serviço de e-mail aceitou */
  sendNotice(message: {
    to: string;
    subject: string;
    html: string;
  }): Promise<boolean>;
}
