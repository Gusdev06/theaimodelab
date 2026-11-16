import { Injectable, Logger } from '@nestjs/common';

/**
 * Gerações que rodam FORA da fila do BullMQ (Unlocked/sem-censura, avatar falante,
 * múltiplos ângulos, TTS) vivem só na memória do processo. Sem este registro, um
 * redeploy mata o trabalho no meio e a geração fica PROCESSING até o cron de presas
 * marcar timeout (16/11/2026: 4 imagens presas 35 min, TKT-306).
 *
 * O desligamento gracioso espera estas promessas terminarem antes de fechar a API.
 */
@Injectable()
export class InflightRunsService {
  private readonly logger = new Logger(InflightRunsService.name);
  private readonly runs = new Map<Promise<unknown>, string>();

  /** Registra uma execução direta; ela sai do registro sozinha quando termina (ok ou erro). */
  track<T>(label: string, run: Promise<T>): Promise<T> {
    this.runs.set(run, label);
    const release = () => {
      this.runs.delete(run);
    };
    run.then(release, release);
    return run;
  }

  get size(): number {
    return this.runs.size;
  }

  /**
   * Espera todas as execuções em andamento, inclusive as que começarem durante a
   * espera, até o prazo. Devolve quantas ainda estavam rodando quando o prazo venceu.
   */
  async drain(deadlineAt: number): Promise<number> {
    while (this.runs.size > 0) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) break;
      const snapshot = [...this.runs.keys()].map((run) => run.catch(() => undefined));
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remainingMs);
      });
      await Promise.race([Promise.all(snapshot), timeout]);
      if (timer) clearTimeout(timer);
    }
    if (this.runs.size > 0) {
      this.logger.warn(
        `[shutdown] prazo vencido com ${this.runs.size} execução(ões) direta(s) ainda rodando: ${[...this.runs.values()].join(', ')}`,
      );
    }
    return this.runs.size;
  }
}
