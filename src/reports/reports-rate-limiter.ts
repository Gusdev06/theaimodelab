import { HttpException, HttpStatus } from '@nestjs/common';

export interface RateWindow {
  limit: number;
  windowMs: number;
}

/**
 * Faixa do pedido no limite:
 * - `priority`: denúncia urgente (menor de idade, imagem íntima sem consentimento, a própria pessoa retratada ou texto
 *   que cita menor). Nunca é recusada por enxurrada comum: só o teto global alto, que protege o banco, recusa. Acima do
 *   limite por cliente ela é gravada assim mesmo, marcada (`overClientLimit`) para ir no resumo em vez do aviso avulso;
 * - `standard`: as demais denúncias de humano;
 * - `bot`: isca anti-robô preenchida. Janelas próprias (por cliente e global): robô nunca gasta o limite de humano.
 */
export type ReportLane = 'priority' | 'standard' | 'bot';
export const REPORT_LANES: readonly ReportLane[] = ['priority', 'standard', 'bot'];

/** Por cliente: 5 denúncias a cada 10 minutos (humano: urgentes e comuns somadas; robô: janela à parte). */
export const REPORTS_PER_CLIENT: RateWindow = { limit: 5, windowMs: 10 * 60_000 };
/** Teto global das denúncias comuns (fora menor e íntima sem consentimento): 120 por hora somando todo mundo. */
export const REPORTS_GLOBAL: RateWindow = { limit: 120, windowMs: 60 * 60_000 };
/**
 * Teto global das urgentes: 5.000 por hora. Não é limite de uso, é a proteção do banco: abaixo dele toda denúncia
 * urgente é gravada (quem quiser calar a de menor com IP inventado teria de passar de 5.000 por hora). Quem segura o
 * e-mail da equipe é o teto de avisos (REPORTS_ALERT_EMAILS), não este.
 */
export const REPORTS_GLOBAL_PRIORITY: RateWindow = { limit: 5_000, windowMs: 60 * 60_000 };
/** Teto global da isca preenchida: 120 por hora, separado dos de humano. */
export const REPORTS_GLOBAL_BOT: RateWindow = { limit: 120, windowMs: 60 * 60_000 };
/**
 * Avisos avulsos por e-mail à equipe: no máximo 30 por hora. Passou disso, as urgentes vão juntas no resumo da
 * varredura (um e-mail a cada 10 min): a enxurrada não enterra a caixa da equipe nem a cota do provedor de e-mail.
 */
export const REPORTS_ALERT_EMAILS: RateWindow = { limit: 30, windowMs: 60 * 60_000 };

/** Caixa de denúncia por e-mail (pública, a mesma das páginas legais): a alternativa quando o canal recusa. */
export const REPORTS_CONTACT_EMAIL = 'report@help.theaimodelab.com';

export interface ReportsLimits {
  perClient: RateWindow;
  global: Record<ReportLane, RateWindow>;
  alertEmails: RateWindow;
}

export const REPORTS_LIMITS: ReportsLimits = {
  perClient: REPORTS_PER_CLIENT,
  global: { priority: REPORTS_GLOBAL_PRIORITY, standard: REPORTS_GLOBAL, bot: REPORTS_GLOBAL_BOT },
  alertEmails: REPORTS_ALERT_EMAILS,
};

/** Resultado de um pedido aceito: `overClientLimit` só acontece na faixa urgente (as outras recusam com 429). */
export interface ReportAdmission {
  overClientLimit: boolean;
}

/** Chave de quem não manda IP nenhum: todos esses dividem uma janela só. */
const UNKNOWN_CLIENT = 'desconhecido';
const MAX_KEY_LENGTH = 64;

/** 429 com o corpo que o site lê: { code: 'REPORTS_RATE_LIMITED', message }. */
export class ReportsRateLimitedException extends HttpException {
  constructor(message: string) {
    super({ code: 'REPORTS_RATE_LIMITED', message }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/** Mantém só os instantes dentro da janela (a lista está em ordem de chegada). */
function withinWindow(hits: readonly number[], now: number, windowMs: number): number[] {
  const from = now - windowMs;
  let start = 0;
  while (start < hits.length && hits[start] <= from) start += 1;
  return hits.slice(start);
}

/**
 * Limite do canal público de denúncia, em memória (por processo da API).
 *
 * Por que não o throttler global: a API fica atrás do rewrite da Vercel, então o `req.ip` é o do proxy e o limite
 * "por IP" virava um limite só, dividido por todo mundo. Aqui o cliente é o 1º IP do x-forwarded-for
 * (reportClientIp, no controller). Esse 1º salto só é confiável para quem passa pela Vercel, que reescreve o
 * cabeçalho com o IP real do visitante; quem chama o VPS direto escreve o que quiser nele. Por isso o limite por
 * cliente é só o freio do visitante comum, e quem segura a enxurrada (IP inventado a cada pedido) são os tetos
 * globais, um por faixa: a isca preenchida tem janelas próprias, a enxurrada de denúncia comum não alcança o teto
 * das urgentes, e o teto das urgentes é alto o bastante para só proteger o banco (5.000/h).
 *
 * Denúncia urgente acima do limite por cliente não é recusada: é aceita com `overClientLimit` (o serviço grava e manda
 * no resumo, sem aviso avulso). Recusar a 6ª denúncia de menor de quem está atrás do mesmo IP (rede da escola, 4G com
 * NAT, a vítima denunciando várias imagens dela) era pior que gravar uma a mais.
 *
 * Também guarda o teto de avisos avulsos por e-mail (takeAlertSlot), por processo como o resto.
 *
 * Só pedido aceito conta: a memória fica limitada pelos tetos globais (no máximo ~5.240 clientes na janela de
 * 10 min), e uma enxurrada de pedidos recusados com IPs inventados não cria entrada nova.
 */
export class ReportsRateLimiter {
  /** janelas por cliente: humano (urgentes e comuns somadas) e robô (isca) separados */
  private readonly perClient = { human: new Map<string, number[]>(), bot: new Map<string, number[]>() };
  private readonly globalHits: Record<ReportLane, number[]> = { priority: [], standard: [], bot: [] };
  /** avisos avulsos por e-mail já mandados (ou tentados) na janela */
  private alertHits: number[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limits: ReportsLimits = REPORTS_LIMITS,
  ) {}

  /**
   * Conta a denúncia do cliente na faixa ou lança 429 (ReportsRateLimitedException) sem contar. Na faixa urgente, o
   * limite por cliente não recusa: a denúncia conta e volta com `overClientLimit: true`.
   */
  consume(clientKey: string | null | undefined, lane: ReportLane): ReportAdmission {
    const now = this.now();
    const key = (clientKey ?? '').trim().slice(0, MAX_KEY_LENGTH) || UNKNOWN_CLIENT;
    const clients = lane === 'bot' ? this.perClient.bot : this.perClient.human;
    const global = this.limits.global[lane];
    const globalHits = withinWindow(this.globalHits[lane], now, global.windowMs);
    this.globalHits[lane] = globalHits;
    const hits = withinWindow(clients.get(key) ?? [], now, this.limits.perClient.windowMs);
    const overClientLimit = hits.length >= this.limits.perClient.limit;

    if (overClientLimit && lane !== 'priority') {
      clients.set(key, hits);
      throw new ReportsRateLimitedException('Você enviou muitas denúncias em pouco tempo. Tente de novo em alguns minutos.');
    }
    if (globalHits.length >= global.limit) {
      if (hits.length) clients.set(key, hits);
      else clients.delete(key);
      throw new ReportsRateLimitedException(
        lane === 'priority'
          ? `O canal de denúncias recebeu envios demais agora. Mande a denúncia por e-mail para ${REPORTS_CONTACT_EMAIL}: ela é lida pela equipe.`
          : 'O canal de denúncias recebeu muitos envios agora. Tente de novo em alguns minutos.',
      );
    }

    // a urgente acima do limite também conta: quem insiste continua marcado enquanto insistir
    hits.push(now);
    clients.set(key, hits);
    globalHits.push(now);
    this.sweep(now);
    return { overClientLimit };
  }

  /**
   * Reserva um aviso avulso por e-mail na janela (true) ou diz que o teto da hora acabou (false: a denúncia vai no
   * resumo). Quem reserva e não manda (e-mail fora) não devolve: o teto conta tentativa, não entrega.
   */
  takeAlertSlot(at: number = this.now()): boolean {
    const window = this.limits.alertEmails;
    // filtro (e não corte do começo): a varredura passa o relógio dela, que pode vir fora de ordem com o do pedido
    this.alertHits = this.alertHits.filter((hit) => hit > at - window.windowMs);
    if (this.alertHits.length >= window.limit) return false;
    this.alertHits.push(at);
    return true;
  }

  /** Tira da memória os clientes sem denúncia na janela. */
  private sweep(now: number): void {
    const from = now - this.limits.perClient.windowMs;
    for (const clients of [this.perClient.human, this.perClient.bot]) {
      for (const [key, hits] of clients) {
        if (!hits.length || hits[hits.length - 1] <= from) clients.delete(key);
      }
    }
  }

  /** Quantos clientes estão na memória (para teste e diagnóstico). */
  get trackedClients(): number {
    return this.perClient.human.size + this.perClient.bot.size;
  }
}
