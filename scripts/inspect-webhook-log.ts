import * as dotenv from 'dotenv';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
const prisma = new PrismaClient();

(async () => {
  const logs = await prisma.webhookLog.findMany({
    where: { provider: 'asaas' },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  for (const l of logs) {
    console.log({
      id: l.id,
      eventType: l.eventType,
      externalId: l.externalId,
      processed: l.processed,
      error: l.error,
      createdAt: l.createdAt,
    });
  }
})().finally(() => prisma.$disconnect());
