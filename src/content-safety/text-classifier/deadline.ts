/** Prazo de uma chamada externa estourado (ou cancelado por quem chamou). */
export class CallDeadlineError extends Error {
  constructor(readonly cancelled: boolean) {
    super(cancelled ? 'chamada cancelada' : 'prazo da chamada estourado');
    this.name = 'CallDeadlineError';
  }
}

/**
 * Roda `call` com um AbortSignal que dispara no prazo ou quando `parent` cancela. Não confia só no cliente para
 * respeitar o sinal: o prazo também corre por fora, então um cliente que nunca responde não segura a fila.
 */
export async function withDeadline<T>(
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  if (parent?.aborted) throw new CallDeadlineError(true);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onParentAbort: (() => void) | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        controller.abort();
        reject(new CallDeadlineError(false));
      },
      Math.max(0, timeoutMs),
    );
    if (parent) {
      onParentAbort = () => {
        controller.abort();
        reject(new CallDeadlineError(true));
      };
      parent.addEventListener('abort', onParentAbort, { once: true });
    }
  });
  try {
    return await Promise.race([call(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
    if (parent && onParentAbort) {
      parent.removeEventListener('abort', onParentAbort);
    }
  }
}
