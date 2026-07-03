import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('\n=== PLANOS ATIVOS ===');
  const plans = await prisma.plan.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: { slug: true, name: true, priceCents: true, creditsPerMonth: true, hasWatermark: true, sortOrder: true },
  });
  console.table(plans);

  console.log('\n=== PLANOS INATIVOS ===');
  const inactive = await prisma.plan.findMany({
    where: { isActive: false },
    select: { slug: true, name: true, priceCents: true, creditsPerMonth: true, sortOrder: true },
  });
  console.table(inactive);

  console.log('\n=== BOOST PACKAGES ATIVOS ===');
  const pkgs = await prisma.creditPackage.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: { name: true, credits: true, priceCents: true, stripePriceId: true, sortOrder: true },
  });
  console.table(pkgs.map((p) => ({ ...p, stripePriceId: p.stripePriceId ? p.stripePriceId.slice(0, 20) + '...' : null })));

  console.log('\n=== PLAN PRICES (v5) ===');
  const prices = await prisma.planPrice.findMany({
    where: { plan: { slug: { in: ['ultra-basic', 'basic', 'advanced'] } } },
    include: { plan: { select: { slug: true } } },
    orderBy: [{ plan: { sortOrder: 'asc' } }, { currency: 'asc' }],
  });
  console.table(
    prices.map((p) => ({
      slug: p.plan.slug,
      currency: p.currency,
      priceCents: p.priceCents,
      stripe: p.stripePriceId ? p.stripePriceId.slice(0, 20) + '...' : '(vazio)',
    })),
  );

  console.log('\n=== PACKAGE PRICES (Boost P + XG + XXG) ===');
  const pkgPrices = await prisma.creditPackagePrice.findMany({
    where: { creditPackage: { name: { in: ['Boost P', 'Boost XG', 'Boost XXG'] } } },
    include: { creditPackage: { select: { name: true } } },
    orderBy: [{ creditPackage: { sortOrder: 'asc' } }, { currency: 'asc' }],
  });
  console.table(
    pkgPrices.map((p) => ({
      name: p.creditPackage.name,
      currency: p.currency,
      priceCents: p.priceCents,
      stripe: p.stripePriceId ? p.stripePriceId.slice(0, 20) + '...' : '(vazio)',
    })),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
