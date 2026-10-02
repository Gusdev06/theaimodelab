/**
 * Uso real por modelo (últimos N dias) — SOMENTE LEITURA.
 * Serve pra decidir quais modelos valem migrar pra worker próprio no RunPod.
 *
 *   npx ts-node scripts/usage-by-model.ts [dias=30]
 *
 * Custo de provedor estimado = créditos / 3333 (regra de 70% de margem,
 * prisma/update-credit-costs-70margin.sql). É aproximação: modelos com preço
 * hardcoded (Gemini Omni, Seedance 2.0) e o avatar HeyGen fogem da regra.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const CREDITS_PER_USD = 3333;

async function main() {
  const days = Number(process.argv[2] ?? 30);
  const since = new Date(Date.now() - days * 86_400_000);

  const rows = await prisma.generation.groupBy({
    by: ['modelUsed', 'type', 'resolution', 'hasAudio'],
    where: { createdAt: { gte: since }, status: 'COMPLETED' },
    _count: { _all: true },
    _sum: { creditsConsumed: true, durationSeconds: true },
  });

  const table = rows
    .map((r) => ({
      modelo: r.modelUsed,
      tipo: r.type,
      res: r.resolution,
      audio: r.hasAudio ? 'sim' : 'não',
      gerações: r._count._all,
      segundos: r._sum.durationSeconds ?? 0,
      créditos: r._sum.creditsConsumed ?? 0,
      'custo_est_USD': +((r._sum.creditsConsumed ?? 0) / CREDITS_PER_USD).toFixed(2),
    }))
    .sort((a, b) => b.créditos - a.créditos);

  const total = table.reduce((s, r) => s + r.créditos, 0);
  console.log(`\nÚltimos ${days} dias — gerações COMPLETED desde ${since.toISOString().slice(0, 10)}`);
  console.table(table);

  const porModelo = new Map<string, number>();
  for (const r of table) porModelo.set(r.modelo, (porModelo.get(r.modelo) ?? 0) + r.créditos);
  console.log('\nPor modelo (share de créditos ≈ share de custo):');
  console.table(
    [...porModelo.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([modelo, cr]) => ({ modelo, créditos: cr, 'custo_est_USD': +(cr / CREDITS_PER_USD).toFixed(2), share: `${((cr / total) * 100).toFixed(1)}%` })),
  );
  console.log(`\nTotal: ${total} créditos ≈ US$ ${(total / CREDITS_PER_USD).toFixed(2)} de provedor em ${days} dias`);

  const falhas = await prisma.generation.groupBy({
    by: ['modelUsed'],
    where: { createdAt: { gte: since }, status: 'FAILED' },
    _count: { _all: true },
  });
  if (falhas.length) {
    console.log('\nFalhas por modelo:');
    console.table(falhas.map((f) => ({ modelo: f.modelUsed, falhas: f._count._all })));
  }
}

main().finally(() => prisma.$disconnect());
