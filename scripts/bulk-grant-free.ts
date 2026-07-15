/**
 * Bulk-grant the DEFAULT free-generation bundle (1 of each) to all members-area
 * emails. Idempotent: each email gets ONE pending grant tagged with a unique
 * externalEventId, so re-running never double-grants.
 *
 * - Users who already have a platform account are credited immediately.
 * - Emails without an account get a pending grant that the platform's own
 *   consumeForUser() applies automatically on their first signup/login.
 *
 * Usage:
 *   npx ts-node scripts/bulk-grant-free.ts                 -> dry run (no writes)
 *   npx ts-node scripts/bulk-grant-free.ts --apply         -> writes to the DB
 *   npx ts-node scripts/bulk-grant-free.ts --apply <file>  -> custom emails json
 */
import { readFileSync } from 'node:fs';
import { PrismaClient, FreeGenerationType, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const fileArg = process.argv.find((a) => a.endsWith('.json'));
const EMAILS_FILE = fileArg || '/tmp/member-emails.json';

// Mirrors DEFAULT_HUBLA_BUNDLE in src/pending-grants/pending-grants.service.ts
const BUNDLE: Partial<Record<FreeGenerationType, number>> = {
  NB2: 1,
  NB_PRO: 1,
  FACE_SWAP: 1,
  VIRTUAL_TRY_ON: 1,
  THEAIMODELAB_FAST: 1,
  UPSCALE: 1,
};

const SOURCE = 'manual-bulk-default-v1';
const eidFor = (email: string) => `bulk-grant-default-v1:${email}`;

async function main() {
  const emails: string[] = JSON.parse(readFileSync(EMAILS_FILE, 'utf8')).map(
    (e: string) => e.trim().toLowerCase(),
  );
  const unique = [...new Set(emails)];
  console.log(`Loaded ${unique.length} unique emails from ${EMAILS_FILE}`);
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}`);
  console.log(`Bundle: ${JSON.stringify(BUNDLE)}\n`);

  const users = await prisma.user.findMany({
    where: { email: { in: unique } },
    select: { id: true, email: true },
  });
  const userByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));
  console.log(`Matched ${userByEmail.size} existing platform accounts.\n`);

  let newPending = 0;
  let existingPending = 0;
  let creditedNow = 0;
  let alreadyCredited = 0;
  let pendingForLater = 0;

  for (const email of unique) {
    const eid = eidFor(email);
    let pending = await prisma.pendingFreeGenerationGrant.findUnique({
      where: { externalEventId: eid },
    });

    if (!pending) {
      newPending++;
      if (APPLY) {
        pending = await prisma.pendingFreeGenerationGrant.create({
          data: {
            email,
            bundle: BUNDLE as Prisma.InputJsonValue,
            source: SOURCE,
            externalEventId: eid,
          },
        });
      }
    } else {
      existingPending++;
    }

    const userId = userByEmail.get(email);
    if (!userId) {
      pendingForLater++;
      continue; // consumed automatically on first signup/login
    }

    if (pending?.consumedByUserId) {
      alreadyCredited++;
      continue;
    }

    creditedNow++;
    if (APPLY) {
      await prisma.$transaction(async (tx) => {
        for (const [type, amount] of Object.entries(BUNDLE)) {
          if (!amount) continue;
          await tx.userFreeGeneration.upsert({
            where: { userId_type: { userId, type: type as FreeGenerationType } },
            create: { userId, type: type as FreeGenerationType, remaining: amount },
            update: { remaining: { increment: amount } },
          });
        }
        await tx.pendingFreeGenerationGrant.update({
          where: { externalEventId: eid },
          data: { consumedByUserId: userId, consumedAt: new Date() },
        });
      });
    }
  }

  console.log('--- summary ---');
  console.log(
    JSON.stringify(
      {
        emails: unique.length,
        newPendingGrants: newPending,
        existingPendingGrants: existingPending,
        creditedNow_existingUsers: creditedNow,
        alreadyCredited_skipped: alreadyCredited,
        pendingForFirstLogin: pendingForLater,
      },
      null,
      2,
    ),
  );
  if (!APPLY) console.log('\nDRY RUN — nothing was written. Re-run with --apply.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
