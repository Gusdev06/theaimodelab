import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BlocklistEntryInput,
  BlocklistPort,
  HashMatch,
  SafetyProviderUnavailableError,
  Strength,
  STRENGTH_RANK,
} from './types';
import { hammingDistance, isValidPhash, PHASH_ALGORITHM } from './phash';

/**
 * Lista de bloqueio própria (content_hash_blocks), regras E1 e S6: toda entrada e toda saída bloqueadas com sinal
 * forte ou médio entram; o caso leve (criança em pedido não sexual) nunca entra. Linha revogada (falso positivo
 * liberado pelo revisor) não barra.
 *
 * A tabela é curta: o acerto por pHash é feito em memória, sobre um cache das linhas ativas recarregado a cada 60 s
 * e a cada `add`. Sem SQL cru.
 */

const CACHE_TTL_MS = 60_000;
/** Teto de linhas no cache (proteção; a lista própria fica muito abaixo disto). */
const CACHE_MAX_ROWS = 200_000;
/** Teto de linhas lidas na contagem de repetição (uma conta, uma janela de horas). */
const RECENT_SCANS_MAX_ROWS = 5_000;
const SHA256_FORMAT = /^[0-9a-f]{64}$/;
const ORIGINS: ReadonlySet<BlocklistEntryInput['origin']> = new Set([
  'input',
  'output',
  'report',
  'manual',
]);
/** Só forte e médio barram (e só eles podem entrar). */
const BLOCKING_STRENGTHS: Array<Extract<Strength, 'STRONG' | 'MEDIUM'>> = [
  'STRONG',
  'MEDIUM',
];

interface CachedBlock {
  id: string;
  phash: string;
  strength: Strength;
}

/** Hash em hexadecimal minúsculo (o formato gravado); vazio ou ausente = null. */
function normalizeHash(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

@Injectable()
export class BlocklistService implements BlocklistPort {
  private cache: CachedBlock[] = [];
  private cacheLoadedAt = 0;
  /** sobe a cada `add`: carga que começou antes do bloqueio novo não vale como cache fresco */
  private cacheVersion = 0;
  private loading: { version: number; rows: Promise<CachedBlock[]> } | null =
    null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Acerto exato por sha256 primeiro (índice); depois o pHash mais perto com distância ≤ maxDistance (empate: a
   * força maior). Banco fora do ar ou hash malformado = SafetyProviderUnavailableError (nunca "não está na lista").
   */
  async match(
    phash: string | null,
    sha256: string | null,
    maxDistance: number,
  ): Promise<HashMatch | null> {
    try {
      const normalizedSha = normalizeHash(sha256);
      const normalizedPhash = normalizeHash(phash);
      // hash que veio e não tem o formato é erro de quem chamou: fecha em vez de responder "não está na lista"
      if (normalizedSha !== null && !SHA256_FORMAT.test(normalizedSha)) {
        throw new Error('Lista de bloqueio: sha256 inválido');
      }
      if (normalizedPhash !== null && !isValidPhash(normalizedPhash)) {
        throw new Error('Lista de bloqueio: pHash inválido');
      }
      if (normalizedSha) {
        const exact = await this.prisma.contentHashBlock.findFirst({
          where: {
            sha256: normalizedSha,
            revokedAt: null,
            strength: { in: BLOCKING_STRENGTHS },
          },
          orderBy: { createdAt: 'asc' },
          select: { id: true, strength: true },
        });
        if (exact) {
          return {
            source: 'blocklist',
            matcher: 'sha256',
            distance: 0,
            blockId: exact.id,
            strength: exact.strength,
          };
        }
      }
      if (normalizedPhash === null) return null;

      const limit = Math.max(0, Math.floor(maxDistance));
      let best: { block: CachedBlock; distance: number } | null = null;
      for (const block of await this.activeBlocks()) {
        const distance = hammingDistance(normalizedPhash, block.phash);
        if (distance > limit) continue;
        if (
          !best ||
          distance < best.distance ||
          (distance === best.distance &&
            STRENGTH_RANK[block.strength] > STRENGTH_RANK[best.block.strength])
        ) {
          best = { block, distance };
        }
      }
      if (!best) return null;
      return {
        source: 'blocklist',
        matcher: PHASH_ALGORITHM,
        distance: best.distance,
        blockId: best.block.id,
        strength: best.block.strength,
      };
    } catch (error) {
      if (error instanceof SafetyProviderUnavailableError) throw error;
      throw new SafetyProviderUnavailableError('blocklist', 'server_error');
    }
  }

  /**
   * Grava um bloqueio. Recusa força leve ou nenhuma, pHash inválido e origem desconhecida (lança). Se o mesmo hash
   * já está ativo com força igual ou maior, devolve a linha existente (repetição não incha a tabela).
   */
  async add(entry: BlocklistEntryInput): Promise<string> {
    if (!BLOCKING_STRENGTHS.includes(entry.strength)) {
      throw new Error(
        'Lista de bloqueio: só sinal forte ou médio entra (o leve nunca)',
      );
    }
    const phash = normalizeHash(entry.phash);
    if (!isValidPhash(phash)) {
      throw new Error('Lista de bloqueio: pHash inválido');
    }
    if (!ORIGINS.has(entry.origin)) {
      throw new Error('Lista de bloqueio: origem inválida');
    }
    const sha256 = normalizeHash(entry.sha256);
    if (sha256 !== null && !SHA256_FORMAT.test(sha256)) {
      throw new Error('Lista de bloqueio: sha256 inválido');
    }

    const existing = await this.prisma.contentHashBlock.findFirst({
      where: { phash, sha256, revokedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, strength: true },
    });
    if (
      existing &&
      STRENGTH_RANK[existing.strength] >= STRENGTH_RANK[entry.strength]
    ) {
      return existing.id;
    }

    const created = await this.prisma.contentHashBlock.create({
      data: {
        phash,
        sha256,
        strength: entry.strength,
        origin: entry.origin,
        eventId: entry.eventId,
      },
      select: { id: true },
    });
    // a próxima checagem já enxerga o bloqueio novo
    this.cacheVersion += 1;
    this.cacheLoadedAt = 0;
    return created.id;
  }

  /**
   * Quantas tentativas com foto parecida esta conta teve barradas (HOLD/BLOCK de entrada) nas últimas `hours` horas:
   * camada 6 (3 em 24 h suspendem para revisão). Conta tentativas, não quadros: várias linhas da mesma geração (quadros
   * de um vídeo, nova tentativa da fila) contam uma vez.
   */
  async countRecent(
    userId: string,
    phash: string,
    hours: number,
    maxDistance: number,
  ): Promise<number> {
    const target = normalizeHash(phash);
    if (!isValidPhash(target)) {
      throw new Error('Lista de bloqueio: pHash inválido');
    }
    if (!userId || !(hours > 0)) return 0;
    const since = new Date(Date.now() - hours * 60 * 60_000);
    const scans = await this.prisma.contentSafetyScan.findMany({
      where: {
        userId,
        createdAt: { gte: since },
        stage: { in: ['INPUT', 'INPUT_FRAME'] },
        verdict: { in: ['HOLD', 'BLOCK'] },
        phash: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      take: RECENT_SCANS_MAX_ROWS,
      select: { id: true, generationId: true, phash: true },
    });
    const limit = Math.max(0, Math.floor(maxDistance));
    const attempts = new Set<string>();
    for (const scan of scans) {
      const scanPhash = normalizeHash(scan.phash);
      if (!isValidPhash(scanPhash)) continue;
      if (hammingDistance(target, scanPhash) > limit) continue;
      attempts.add(scan.generationId ?? `scan:${scan.id}`);
    }
    return attempts.size;
  }

  private async activeBlocks(): Promise<CachedBlock[]> {
    if (Date.now() - this.cacheLoadedAt < CACHE_TTL_MS) return this.cache;
    if (!this.loading || this.loading.version !== this.cacheVersion) {
      const version = this.cacheVersion;
      const rows = this.loadActiveBlocks(version).finally(() => {
        if (this.loading?.rows === rows) this.loading = null;
      });
      this.loading = { version, rows };
    }
    return this.loading.rows;
  }

  private async loadActiveBlocks(version: number): Promise<CachedBlock[]> {
    const startedAt = Date.now();
    const rows = await this.prisma.contentHashBlock.findMany({
      where: { revokedAt: null, strength: { in: BLOCKING_STRENGTHS } },
      orderBy: { createdAt: 'desc' },
      take: CACHE_MAX_ROWS,
      select: { id: true, phash: true, strength: true },
    });
    const blocks: CachedBlock[] = [];
    for (const row of rows) {
      const phash = normalizeHash(row.phash);
      if (isValidPhash(phash)) blocks.push({ ...row, phash });
    }
    // só vira cache fresco se nenhum bloqueio entrou durante a leitura
    if (version === this.cacheVersion) {
      this.cache = blocks;
      this.cacheLoadedAt = startedAt;
    }
    return blocks;
  }
}
