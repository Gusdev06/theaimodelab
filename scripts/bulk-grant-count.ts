import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const totalUsers = await prisma.user.count();
  const activeUsers = await prisma.user.count({ where: { isActive: true } });
  const usersWithAnyFree = await prisma.userFreeGeneration.findMany({
    select: { userId: true },
    distinct: ['userId'],
  });
  const pendingUnconsumed = await prisma.pendingFreeGenerationGrant.count({
    where: { consumedByUserId: null },
  });
  console.log(
    JSON.stringify(
      {
        totalUsers,
        activeUsers,
        usersWithAnyFreeGeneration: usersWithAnyFree.length,
        pendingUnconsumedGrants: pendingUnconsumed,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
