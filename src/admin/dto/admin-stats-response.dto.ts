import { ApiProperty } from '@nestjs/swagger';

export class GenerationsByStatusDto {
  @ApiProperty()
  pending: number;

  @ApiProperty()
  processing: number;

  @ApiProperty()
  completed: number;

  @ApiProperty()
  failed: number;
}

export class KieBreakdownDto {
  @ApiProperty({ description: 'Generations using Nano Banana 2' })
  nanoBanana2: number;

  @ApiProperty({ description: 'Generations using Nano Banana Pro' })
  nanoBananaPro: number;

  @ApiProperty({ description: 'Generations using Kling 2.6 Motion Control' })
  kling: number;
}

export class GenerationsByProviderDto {
  @ApiProperty({ description: 'Generations via The AI Model Lab provider (Gemini/Veo)' })
  theaimodelab: number;

  @ApiProperty({ description: 'Generations via KIE API (Nano Banana/Kling)' })
  kie: number;

  @ApiProperty({ description: 'Breakdown of KIE API generations by model' })
  kieBreakdown: KieBreakdownDto;
}


// ---------------------------------------------------------------------------
// Regras de dinheiro/assinatura: projects/theaimodelab/admin-metricas-CONTRATO.md
// Moedas nunca se somam cruas: tudo sai em usdCents + brlCents; o consolidado
// em BRL é brlCents + round(usdCents * fxUsdBrl).
// ---------------------------------------------------------------------------

export class SubscriptionsBreakdownDto {
  @ApiProperty({ description: 'Paid active subscriptions via Perfect Pay' })
  perfectpay: number;

  @ApiProperty({ description: 'Paid active subscriptions via Cakto' })
  cakto: number;

  @ApiProperty({ description: 'Paid active subscriptions via Stripe' })
  stripe: number;

  @ApiProperty({ description: 'Active courtesy subscriptions (provider admin)' })
  courtesy: number;

  @ApiProperty({ description: 'Active subscriptions on the free plan' })
  free: number;
}

export class MoneySplitDto {
  @ApiProperty()
  usdCents: number;

  @ApiProperty()
  brlCents: number;

  @ApiProperty({ description: 'brlCents + round(usdCents * fxUsdBrl)' })
  consolidatedBrlCents: number;
}

export class RevenueWithFxDto extends MoneySplitDto {
  @ApiProperty()
  fxUsdBrl: number;
}

export class MrrBucketDto extends MoneySplitDto {
  @ApiProperty({ description: 'Subscriptions whose last real payment is in USD' })
  subsUsd: number;

  @ApiProperty({ description: 'Subscriptions whose last real payment is in BRL' })
  subsBrl: number;
}

export class MrrDto {
  @ApiProperty({ description: 'All paid active subscriptions (last real payment, annual ÷ 12)' })
  contracted: MrrBucketDto;

  @ApiProperty({ description: 'Only subscriptions with ≥ 2 real payments (already renewed)' })
  recurring: MrrBucketDto;
}

export class DailyRevenueDto {
  @ApiProperty()
  date: string;

  @ApiProperty()
  usdCents: number;

  @ApiProperty()
  brlCents: number;

  @ApiProperty({ description: 'Consolidated in BRL' })
  revenueCents: number;
}

export class RevenueByPlanDto {
  @ApiProperty()
  planName: string;

  @ApiProperty()
  planSlug: string;

  @ApiProperty({ enum: ['USD', 'BRL'] })
  currency: 'USD' | 'BRL';

  @ApiProperty()
  revenueCents: number;

  @ApiProperty()
  paymentCount: number;
}

export class BoostSaleDto {
  @ApiProperty()
  name: string;

  @ApiProperty()
  credits: number;

  @ApiProperty({ enum: ['USD', 'BRL'] })
  currency: 'USD' | 'BRL';

  @ApiProperty({ description: 'Average paid ticket in cents' })
  priceCents: number;

  @ApiProperty()
  soldCount: number;

  @ApiProperty()
  totalRevenueCents: number;
}

export class FinancialStatsResponseDto {
  @ApiProperty()
  fxUsdBrl: number;

  @ApiProperty({ description: '= mrr.contracted.consolidatedBrlCents (compat)' })
  mrrCents: number;

  @ApiProperty()
  mrr: MrrDto;

  @ApiProperty({ description: '= revenue.consolidatedBrlCents for the period (compat)' })
  totalRevenueCents: number;

  @ApiProperty({ description: 'Real revenue in the period' })
  revenue: MoneySplitDto;

  @ApiProperty({ type: [DailyRevenueDto] })
  dailyRevenue: DailyRevenueDto[];

  @ApiProperty({ type: [RevenueByPlanDto] })
  revenueByPlan: RevenueByPlanDto[];

  @ApiProperty({ type: [BoostSaleDto] })
  boostSales: BoostSaleDto[];

  @ApiProperty({ description: 'Consolidated BRL revenue ÷ customers who paid in the period (ARPPU)' })
  arpuCents: number;

  @ApiProperty()
  payingCustomersPeriod: number;

  @ApiProperty({ description: 'Estimated API cost in BRL cents' })
  totalApiCostCents: number;

  @ApiProperty({ description: 'Margin over consolidated BRL revenue' })
  marginPercent: number;
}

export class DailyNewUsersDto {
  @ApiProperty()
  date: string;

  @ApiProperty()
  count: number;
}

export class PlanDistributionDto {
  @ApiProperty()
  planName: string;

  @ApiProperty()
  planSlug: string;

  @ApiProperty()
  userCount: number;
}

export class TopConsumerDto {
  @ApiProperty()
  userId: string;

  @ApiProperty()
  email: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  totalCredits: number;
}

export class UserStatsResponseDto {
  @ApiProperty()
  newUsersToday: number;

  @ApiProperty()
  newUsersWeek: number;

  @ApiProperty()
  newUsersMonth: number;

  @ApiProperty({ type: [DailyNewUsersDto] })
  dailyNewUsers: DailyNewUsersDto[];

  @ApiProperty({ type: [PlanDistributionDto] })
  planDistribution: PlanDistributionDto[];

  @ApiProperty({ description: 'Users with a paid active subscription' })
  paidUsers: number;

  @ApiProperty({ description: 'Paid subscriptions canceled in the period' })
  canceledRecently: number;

  @ApiProperty({ type: [TopConsumerDto] })
  topConsumers: TopConsumerDto[];

  @ApiProperty()
  inactiveUsers: number;

  @ApiProperty()
  totalUsers: number;

  @ApiProperty({ description: 'Paying customers ÷ total users (%)' })
  conversionRate: number;

  @ApiProperty({ description: 'Paid cancellations ÷ (paid active + paid cancellations) (%)' })
  churnRate: number;

  @ApiProperty({ description: 'Users with ≥ 1 real payment (all time)' })
  payingCustomers: number;
}

export class AdminStatsResponseDto {
  @ApiProperty()
  totalUsers: number;

  @ApiProperty({ description: 'Paid active subscriptions (excludes free and courtesy)' })
  activeSubscriptions: number;

  @ApiProperty()
  subscriptionsBreakdown: SubscriptionsBreakdownDto;

  @ApiProperty({ description: '= revenue.consolidatedBrlCents (compat)' })
  totalRevenueCents: number;

  @ApiProperty({ description: 'All-time real revenue split by currency' })
  revenue: RevenueWithFxDto;

  @ApiProperty({ description: 'Users with ≥ 1 real payment (all time)' })
  payingCustomers: number;

  @ApiProperty()
  totalGenerations: number;

  @ApiProperty()
  generationsByStatus: GenerationsByStatusDto;

  @ApiProperty()
  generationsByProvider: GenerationsByProviderDto;
}
