import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const total = await prisma.pendingFreeGenerationGrant.count({
    where: { source: 'manual-bulk-default-v1' },
  });
  const consumed = await prisma.pendingFreeGenerationGrant.count({
    where: { source: 'manual-bulk-default-v1', consumedByUserId: { not: null } },
  });
  const pendingLater = total - consumed;
  console.log(
    JSON.stringify({ bulkGrantsTotal: total, creditedNow: consumed, pendingForFirstLogin: pendingLater }, null, 2),
  );
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
