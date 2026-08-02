import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAnalyticsEventDto } from './dto/create-analytics-event.dto';

/** Limite de tamanho do payload serializado (proteção contra abuso). */
const MAX_PAYLOAD_BYTES = 8 * 1024; // 8 KB

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persiste um evento de analytics. `eventName`/`action` vão para colunas; o
   * restante do corpo (campos conhecidos + extras) vai para o `payload` JSON.
   * `userId` só é preenchido quando há JWT válido (auth opcional).
   */
  async record(
    dto: CreateAnalyticsEventDto,
    userId: string | null,
  ): Promise<void> {
    const { eventName, action, ...rest } = dto;

    // Remove chaves undefined para um payload limpo.
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) payload[key] = value;
    }

    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new BadRequestException(
        `Payload de analytics muito grande (máx ${MAX_PAYLOAD_BYTES} bytes)`,
      );
    }

    try {
      await this.prisma.analyticsEvent.create({
        data: {
          userId: userId ?? null,
          eventName,
          action: action ?? null,
          payload: payload as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      // Analytics nunca deve quebrar o fluxo do usuário: loga e engole o erro.
      this.logger.warn(
        `Falha ao gravar analytics event "${eventName}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
