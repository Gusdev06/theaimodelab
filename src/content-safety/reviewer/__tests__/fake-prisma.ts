/**
 * Prisma em memória para as suítes do revisor: só os operadores que o código do revisor e da máscara usam (igual,
 * null, in, not, gte/gt/lt/lte, startsWith, contains, OR). Sem banco e sem rede.
 */

export type Row = Record<string, any>;

function compare(left: unknown, right: unknown): number {
  const a = left instanceof Date ? left.getTime() : left;
  const b = right instanceof Date ? right.getTime() : right;
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return (a as number) < (b as number) ? -1 : 1;
}

function sameValue(value: unknown, expected: unknown): boolean {
  if (expected instanceof Date) {
    return value instanceof Date && value.getTime() === expected.getTime();
  }
  return value === expected;
}

export function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return (condition as Row[]).some((part) => matches(row, part));
    if (key === 'AND') return (condition as Row[]).every((part) => matches(row, part));
    const value = row[key];
    if (condition === null) return value === null || value === undefined;
    if (condition === undefined) return true;
    if (
      typeof condition === 'object' &&
      !(condition instanceof Date) &&
      !Array.isArray(condition)
    ) {
      return Object.entries(condition as Row).every(([op, arg]) => {
        switch (op) {
          case 'in':
            return (arg as unknown[]).some((item) => sameValue(value, item));
          case 'not':
            return arg === null
              ? value !== null && value !== undefined
              : !sameValue(value, arg);
          case 'gte':
            return value !== null && value !== undefined && compare(value, arg) >= 0;
          case 'gt':
            return value !== null && value !== undefined && compare(value, arg) > 0;
          case 'lt':
            return value !== null && value !== undefined && compare(value, arg) < 0;
          case 'lte':
            return value !== null && value !== undefined && compare(value, arg) <= 0;
          case 'startsWith':
            return typeof value === 'string' && value.startsWith(arg as string);
          case 'contains':
            return typeof value === 'string' && value.includes(arg as string);
          case 'equals':
            return sameValue(value, arg);
          default:
            throw new Error(`operador não simulado: ${op}`);
        }
      });
    }
    return sameValue(value, condition);
  });
}

function ordered(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
  if (!orderBy) return rows;
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((part) =>
    Object.entries(part),
  );
  return [...rows].sort((left, right) => {
    for (const [field, direction] of keys) {
      const result = compare(left[field], right[field]);
      if (result !== 0) return direction === 'desc' ? -result : result;
    }
    return 0;
  });
}

let sequence = 0;

export function createTable(name: string, seed: Row[] = [], defaults: Row = {}) {
  const rows: Row[] = seed.map((row) => ({ ...defaults, ...row }));
  const table = {
    rows,
    findMany: jest.fn(async (args: Row = {}) => {
      const found = ordered(
        rows.filter((row) => matches(row, args.where)),
        args.orderBy,
      );
      const skip = args.skip ?? 0;
      const take = args.take ?? found.length;
      return found.slice(skip, skip + take).map((row) => ({ ...row }));
    }),
    findUnique: jest.fn(async (args: Row) => {
      const row = rows.find((item) => matches(item, args.where));
      return row ? { ...row } : null;
    }),
    findFirst: jest.fn(async (args: Row = {}) => {
      const found = ordered(
        rows.filter((row) => matches(row, args.where)),
        args.orderBy,
      );
      return found[0] ? { ...found[0] } : null;
    }),
    count: jest.fn(
      async (args: Row = {}) => rows.filter((row) => matches(row, args.where)).length,
    ),
    create: jest.fn(async (args: Row) => {
      const row = {
        ...defaults,
        id: `${name}-${++sequence}`,
        createdAt: new Date(),
        ...args.data,
      };
      rows.push(row);
      return { ...row };
    }),
    updateMany: jest.fn(async (args: Row) => {
      const found = rows.filter((row) => matches(row, args.where));
      found.forEach((row) => Object.assign(row, args.data));
      return { count: found.length };
    }),
    update: jest.fn(async (args: Row) => {
      const row = rows.find((item) => matches(item, args.where));
      if (!row) throw new Error(`${name}: registro não encontrado`);
      Object.assign(row, args.data);
      return { ...row };
    }),
    groupBy: jest.fn(async (args: Row) => {
      const groups = new Map<string, { key: Row; count: number }>();
      for (const row of rows.filter((item) => matches(item, args.where))) {
        const key: Row = {};
        for (const field of args.by as string[]) key[field] = row[field];
        const id = JSON.stringify(key);
        const group = groups.get(id) ?? { key, count: 0 };
        group.count++;
        groups.set(id, group);
      }
      return [...groups.values()].map((group) => ({
        ...group.key,
        _count: { _all: group.count },
      }));
    }),
  };
  return table;
}

export type FakeTable = ReturnType<typeof createTable>;
