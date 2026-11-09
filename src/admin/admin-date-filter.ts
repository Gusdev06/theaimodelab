import { BadRequestException } from '@nestjs/common';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Converte o par de datas dos filtros do admin num intervalo `createdAt` do Prisma.
 *
 * Aceita ISO 8601 completo ou só a data (`2026-11-06`, o que o `<input type="date">` manda). Data sem hora vale
 * o dia inteiro em UTC: `from` no começo do dia, `to` no último milissegundo dele. Sem nenhum dos dois devolve
 * `undefined` (a consulta fica como era). `from` depois de `to` = 400.
 */
export function buildCreatedAtRange(
  from?: string,
  to?: string,
): { gte?: Date; lte?: Date } | undefined {
  const gte = from ? toDate(from, 'start') : undefined;
  const lte = to ? toDate(to, 'end') : undefined;
  if (!gte && !lte) return undefined;
  if (gte && lte && gte.getTime() > lte.getTime()) {
    throw new BadRequestException('A data inicial é depois da data final');
  }
  return { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) };
}

function toDate(value: string, edge: 'start' | 'end'): Date {
  const iso = DATE_ONLY.test(value)
    ? `${value}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}Z`
    : value;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`Data inválida: ${value}`);
  }
  return date;
}
