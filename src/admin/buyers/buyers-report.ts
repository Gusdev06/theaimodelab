/**
 * Raio-X de compradores (GET /api/v1/admin/stats/buyers): de que país vêm os clientes, que plano fecha, quanto tempo
 * a pessoa leva da isca (curso/pack vendido no gateway, que vira um PendingFreeGenerationGrant) até a primeira compra
 * na plataforma, e que campanha traz quem paga.
 *
 * Só agregados: nenhum e-mail, nome, telefone ou id sai daqui. A parte pura (este arquivo) não toca no banco para
 * poder ser testada; o AdminBuyersService só lê e entrega os registros.
 *
 * "Pagamento real" segue a mesma regra do resto do admin (REAL_PAYMENTS_CTE): COMPLETED nos gateways de venda
 * (perfectpay, cakto, stripe). Cortesia e ajuste manual não contam como compra.
 */

export const REAL_PAYMENT_PROVIDERS = [
  'perfectpay',
  'cakto',
  'stripe',
] as const;

const HOUR = 3_600_000;

export type PurchaseKind = 'subscription' | 'credits';

export interface BuyerUserRow {
  id: string;
  email: string;
  country: string | null;
  locale: string | null;
  phone: string | null;
  utmSource: string | null;
  utmCampaign: string | null;
  createdAt: Date;
}

export interface BuyerPaymentRow {
  id: string;
  userId: string;
  type: 'SUBSCRIPTION' | 'CREDIT_PURCHASE';
  amountCents: number;
  currency: string;
  createdAt: Date;
  planSlug: string | null;
  planName: string | null;
  billingInterval: string | null;
  packageName: string | null;
  packageCredits: number | null;
}

export interface BuyerGrantRow {
  email: string;
  source: string;
  /** id do evento do gateway (Perfect Pay: perfectpay-sale-<código>-<status>) */
  externalEventId: string | null;
  consumedByUserId: string | null;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface BuyersReportInput {
  days: number;
  now: Date;
  /** cadastros dentro da janela */
  signups: BuyerUserRow[];
  /** pagamentos reais dentro da janela */
  windowPayments: BuyerPaymentRow[];
  /** usuários citados em windowPayments, nos grants ou em allPaymentsOfKnownUsers (para país e campanha) */
  users: BuyerUserRow[];
  /** TODO pagamento real (qualquer data) de quem pagou na janela ou tem grant: decide quem é cliente novo */
  allPaymentsOfKnownUsers: BuyerPaymentRow[];
  /** grants criados na janela (coorte da isca) */
  windowGrants: BuyerGrantRow[];
  /** todo grant (qualquer data) de quem virou cliente na janela: diz se o cliente novo veio da isca */
  grantsOfNewBuyers: BuyerGrantRow[];
}

export interface IscaSale {
  /** códigos de venda do gateway desta compradora (venda principal + order bump/upsell) */
  refs: string[];
  source: string;
  signedUp: boolean;
  paid: boolean;
  alreadyCustomer: boolean;
  hoursToPurchase: number | null;
  firstKind: PurchaseKind | null;
  firstPlan: string | null;
}

/** perfectpay-sale-PPCPMTB58C2SA-2 → PPCPMTB58C2SA; outro gateway volta como veio. */
export function saleRefOf(externalEventId: string | null): string | null {
  if (!externalEventId) return null;
  const pp = /^perfectpay-sale-(.+)-[^-]+$/.exec(externalEventId);
  return pp ? pp[1] : externalEventId;
}

/** Teto de linhas por compradora na resposta (1 ano de isca cabe com folga). */
const MAX_ISCA_SALES = 20_000;

export interface DurationStats {
  count: number;
  meanHours: number;
  medianHours: number;
  p25Hours: number;
  p75Hours: number;
  p90Hours: number;
}
export interface HistogramBucket {
  key: string;
  label: string;
  count: number;
}
export interface MoneySplit {
  usdCents: number;
  brlCents: number;
}

export interface BuyersReport {
  days: number;
  since: string;
  generatedAt: string;
  totals: {
    signups: number;
    newBuyers: number;
    payments: number;
    repeatPayments: number;
    revenue: MoneySplit;
    newBuyersFromIsca: number;
    firstPurchase: { subscription: number; credits: number };
  };
  countries: {
    country: string | null;
    signups: number;
    newBuyers: number;
    payments: number;
    revenue: MoneySplit;
  }[];
  countryCoverage: { ip: number; phone: number; unknown: number };
  languages: { locale: string | null; signups: number; newBuyers: number }[];
  plans: {
    kind: PurchaseKind;
    key: string;
    name: string;
    interval: 'month' | 'year' | null;
    credits: number | null;
    firstPurchases: number;
    payments: number;
    repeatPayments: number;
    revenue: MoneySplit;
  }[];
  isca: {
    grants: number;
    buyers: number;
    signedUp: number;
    paidAfter: number;
    paidSubscription: number;
    paidCredits: number;
    alreadyCustomer: number;
    conversionPct: number | null;
    hoursToPurchase: DurationStats | null;
    hoursToSignup: DurationStats | null;
    histogram: HistogramBucket[];
    bySource: { source: string; buyers: number; paid: number }[];
    firstPlans: {
      kind: PurchaseKind;
      key: string;
      name: string;
      count: number;
    }[];
    /**
     * Uma linha por compradora da isca, só com o código da venda no gateway (nunca e-mail): o cockpit cruza com a
     * venda da Perfect Pay, que tem a campanha (utm_campaign), e mostra que campanha da isca vira cliente.
     */
    sales: IscaSale[];
  };
  signupToPurchase: {
    stats: DurationStats | null;
    histogram: HistogramBucket[];
  };
  campaigns: {
    campaign: string | null;
    source: string | null;
    signups: number;
    newBuyers: number;
    fromIsca: number;
    payments: number;
    revenue: MoneySplit;
  }[];
  sources: {
    source: string | null;
    signups: number;
    newBuyers: number;
    revenue: MoneySplit;
  }[];
  daily: {
    date: string;
    signups: number;
    newBuyers: number;
    payments: number;
  }[];
}

/* ---------------------------------------------------------------- país ---------------------------------------------------------------- */

/** DDI → país, só para quem não tem o país do IP do cadastro. Os prefixos mais longos vêm primeiro. */
const DIAL_CODES: [string, string][] = [
  ['1809', 'DO'],
  ['1829', 'DO'],
  ['1849', 'DO'],
  ['1787', 'PR'],
  ['1939', 'PR'],
  ['351', 'PT'],
  ['352', 'LU'],
  ['353', 'IE'],
  ['354', 'IS'],
  ['356', 'MT'],
  ['357', 'CY'],
  ['358', 'FI'],
  ['359', 'BG'],
  ['370', 'LT'],
  ['371', 'LV'],
  ['372', 'EE'],
  ['380', 'UA'],
  ['385', 'HR'],
  ['386', 'SI'],
  ['420', 'CZ'],
  ['421', 'SK'],
  ['502', 'GT'],
  ['503', 'SV'],
  ['504', 'HN'],
  ['505', 'NI'],
  ['506', 'CR'],
  ['507', 'PA'],
  ['509', 'HT'],
  ['591', 'BO'],
  ['593', 'EC'],
  ['595', 'PY'],
  ['598', 'UY'],
  ['234', 'NG'],
  ['254', 'KE'],
  ['212', 'MA'],
  ['213', 'DZ'],
  ['216', 'TN'],
  ['233', 'GH'],
  ['244', 'AO'],
  ['258', 'MZ'],
  ['880', 'BD'],
  ['886', 'TW'],
  ['852', 'HK'],
  ['971', 'AE'],
  ['972', 'IL'],
  ['966', 'SA'],
  ['974', 'QA'],
  ['965', 'KW'],
  ['55', 'BR'],
  ['54', 'AR'],
  ['56', 'CL'],
  ['57', 'CO'],
  ['58', 'VE'],
  ['51', 'PE'],
  ['52', 'MX'],
  ['53', 'CU'],
  ['34', 'ES'],
  ['33', 'FR'],
  ['39', 'IT'],
  ['44', 'GB'],
  ['49', 'DE'],
  ['31', 'NL'],
  ['32', 'BE'],
  ['41', 'CH'],
  ['43', 'AT'],
  ['45', 'DK'],
  ['46', 'SE'],
  ['47', 'NO'],
  ['48', 'PL'],
  ['40', 'RO'],
  ['36', 'HU'],
  ['30', 'GR'],
  ['90', 'TR'],
  ['91', 'IN'],
  ['92', 'PK'],
  ['62', 'ID'],
  ['63', 'PH'],
  ['60', 'MY'],
  ['65', 'SG'],
  ['66', 'TH'],
  ['84', 'VN'],
  ['81', 'JP'],
  ['82', 'KR'],
  ['86', 'CN'],
  ['61', 'AU'],
  ['64', 'NZ'],
  ['27', 'ZA'],
  ['20', 'EG'],
  ['7', 'RU'],
  ['1', 'US'],
];

export function countryFromPhone(
  phone: string | null | undefined,
): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  // sem "+" o número pode ser nacional (ex.: 11 9...): não dá para afirmar o país
  if (!trimmed.startsWith('+') && !trimmed.startsWith('00')) return null;
  const digits = trimmed.replace(/\D/g, '').replace(/^00/, '');
  if (digits.length < 8) return null;
  for (const [code, country] of DIAL_CODES)
    if (digits.startsWith(code)) return country;
  return null;
}

export function resolveCountry(user: Pick<BuyerUserRow, 'country' | 'phone'>): {
  country: string | null;
  source: 'ip' | 'phone' | 'unknown';
} {
  const ip = user.country?.trim().toUpperCase();
  if (ip && /^[A-Z]{2}$/.test(ip) && ip !== 'XX' && ip !== 'T1')
    return { country: ip, source: 'ip' };
  const byPhone = countryFromPhone(user.phone);
  if (byPhone) return { country: byPhone, source: 'phone' };
  return { country: null, source: 'unknown' };
}

/* ---------------------------------------------------------------- utilitários ---------------------------------------------------------------- */

function emptyMoney(): MoneySplit {
  return { usdCents: 0, brlCents: 0 };
}

function addMoney(
  target: MoneySplit,
  payment: Pick<BuyerPaymentRow, 'amountCents' | 'currency'>,
): void {
  if (payment.currency?.toUpperCase() === 'USD')
    target.usdCents += payment.amountCents;
  else target.brlCents += payment.amountCents;
}

function normKey(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

function normEmail(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function kindOf(payment: BuyerPaymentRow): PurchaseKind {
  return payment.type === 'SUBSCRIPTION' ? 'subscription' : 'credits';
}

function planKeyOf(payment: BuyerPaymentRow): {
  kind: PurchaseKind;
  key: string;
  name: string;
  interval: 'month' | 'year' | null;
  credits: number | null;
} {
  if (payment.type === 'SUBSCRIPTION') {
    const key = payment.planSlug ?? 'assinatura-sem-plano';
    return {
      kind: 'subscription',
      key,
      name: payment.planName ?? key,
      interval: payment.billingInterval === 'year' ? 'year' : 'month',
      credits: null,
    };
  }
  const name = payment.packageName ?? 'Pacote de créditos';
  return {
    kind: 'credits',
    key: `pack:${name}`,
    name,
    interval: null,
    credits: payment.packageCredits,
  };
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function durationStats(hours: number[]): DurationStats | null {
  if (!hours.length) return null;
  const sorted = [...hours].sort((a, b) => a - b);
  const mean = sorted.reduce((s, h) => s + h, 0) / sorted.length;
  return {
    count: sorted.length,
    meanHours: round1(mean),
    medianHours: round1(quantile(sorted, 0.5)),
    p25Hours: round1(quantile(sorted, 0.25)),
    p75Hours: round1(quantile(sorted, 0.75)),
    p90Hours: round1(quantile(sorted, 0.9)),
  };
}

const BUCKETS: { key: string; label: string; maxHours: number }[] = [
  { key: 'lt1h', label: '< 1 h', maxHours: 1 },
  { key: 'lt24h', label: '1–24 h', maxHours: 24 },
  { key: 'lt3d', label: '1–3 dias', maxHours: 72 },
  { key: 'lt7d', label: '3–7 dias', maxHours: 168 },
  { key: 'lt14d', label: '1–2 semanas', maxHours: 336 },
  { key: 'lt30d', label: '2–4 semanas', maxHours: 720 },
  { key: 'gte30d', label: '30+ dias', maxHours: Number.POSITIVE_INFINITY },
];

export function histogram(hours: number[]): HistogramBucket[] {
  const out = BUCKETS.map((b) => ({ key: b.key, label: b.label, count: 0 }));
  for (const h of hours) {
    const index = BUCKETS.findIndex((b) => h < b.maxHours);
    out[index === -1 ? out.length - 1 : index].count += 1;
  }
  return out;
}

function brtDay(at: Date): string {
  return new Date(at.getTime() - 3 * HOUR).toISOString().slice(0, 10);
}

/* ---------------------------------------------------------------- relatório ---------------------------------------------------------------- */

/** Tolerância entre a venda no gateway e o registro do grant (o webhook pode chegar depois do pagamento). */
const GRANT_CLOCK_SKEW_MS = 2 * HOUR;

export function buildBuyersReport(input: BuyersReportInput): BuyersReport {
  const since = new Date(input.now.getTime() - input.days * 24 * HOUR);
  const userById = new Map<string, BuyerUserRow>();
  for (const u of [...input.users, ...input.signups]) userById.set(u.id, u);
  const userByEmail = new Map<string, BuyerUserRow>();
  for (const u of userById.values())
    if (u.email) userByEmail.set(normEmail(u.email), u);

  // primeira compra real de cada usuário (qualquer data) → cliente novo = primeira compra dentro da janela
  const paymentsByUser = new Map<string, BuyerPaymentRow[]>();
  const seenPayments = new Set<string>();
  for (const p of [...input.windowPayments, ...input.allPaymentsOfKnownUsers]) {
    if (seenPayments.has(p.id)) continue;
    seenPayments.add(p.id);
    const list = paymentsByUser.get(p.userId) ?? [];
    list.push(p);
    paymentsByUser.set(p.userId, list);
  }
  const firstPaymentOf = new Map<string, BuyerPaymentRow>();
  for (const [userId, list] of paymentsByUser) {
    const first = list.reduce((a, b) =>
      b.createdAt.getTime() < a.createdAt.getTime() ||
      (b.createdAt.getTime() === a.createdAt.getTime() && b.id < a.id)
        ? b
        : a,
    );
    firstPaymentOf.set(userId, first);
  }
  const newBuyerIds = new Set<string>();
  for (const [userId, first] of firstPaymentOf)
    if (first.createdAt >= since && first.createdAt <= input.now)
      newBuyerIds.add(userId);

  // cliente novo que veio da isca: tem grant (qualquer data) anterior à primeira compra
  const grantsByUser = new Map<string, BuyerGrantRow[]>();
  for (const g of [...input.grantsOfNewBuyers, ...input.windowGrants]) {
    const owner =
      g.consumedByUserId ?? userByEmail.get(normEmail(g.email))?.id ?? null;
    if (!owner) continue;
    const list = grantsByUser.get(owner) ?? [];
    list.push(g);
    grantsByUser.set(owner, list);
  }
  const fromIsca = new Set<string>();
  for (const id of newBuyerIds) {
    const first = firstPaymentOf.get(id)!;
    if (
      (grantsByUser.get(id) ?? []).some(
        (g) =>
          g.createdAt.getTime() <=
          first.createdAt.getTime() + GRANT_CLOCK_SKEW_MS,
      )
    )
      fromIsca.add(id);
  }

  /* ---------- totais ---------- */
  const revenue = emptyMoney();
  let repeatPayments = 0;
  for (const p of input.windowPayments) {
    addMoney(revenue, p);
    if (firstPaymentOf.get(p.userId)?.id !== p.id) repeatPayments += 1;
  }
  const firstPurchase = { subscription: 0, credits: 0 };
  for (const id of newBuyerIds)
    firstPurchase[kindOf(firstPaymentOf.get(id)!)] += 1;

  /* ---------- país e idioma ---------- */
  const countryMap = new Map<string, BuyersReport['countries'][number]>();
  const countryRow = (country: string | null) => {
    const key = country ?? '';
    let row = countryMap.get(key);
    if (!row) {
      row = {
        country,
        signups: 0,
        newBuyers: 0,
        payments: 0,
        revenue: emptyMoney(),
      };
      countryMap.set(key, row);
    }
    return row;
  };
  const coverage = { ip: 0, phone: 0, unknown: 0 };
  for (const u of input.signups)
    countryRow(resolveCountry(u).country).signups += 1;
  for (const id of newBuyerIds) {
    const user = userById.get(id);
    const resolved = user
      ? resolveCountry(user)
      : { country: null, source: 'unknown' as const };
    countryRow(resolved.country).newBuyers += 1;
    coverage[resolved.source] += 1;
  }
  for (const p of input.windowPayments) {
    const user = userById.get(p.userId);
    const row = countryRow(user ? resolveCountry(user).country : null);
    row.payments += 1;
    addMoney(row.revenue, p);
  }
  const countries = [...countryMap.values()].sort(
    (a, b) =>
      b.newBuyers - a.newBuyers ||
      b.payments - a.payments ||
      b.signups - a.signups,
  );

  const langMap = new Map<string, BuyersReport['languages'][number]>();
  const langRow = (locale: string | null) => {
    const key = locale ?? '';
    let row = langMap.get(key);
    if (!row) {
      row = { locale, signups: 0, newBuyers: 0 };
      langMap.set(key, row);
    }
    return row;
  };
  for (const u of input.signups) langRow(normKey(u.locale)).signups += 1;
  for (const id of newBuyerIds)
    langRow(normKey(userById.get(id)?.locale)).newBuyers += 1;
  const languages = [...langMap.values()].sort(
    (a, b) => b.newBuyers - a.newBuyers || b.signups - a.signups,
  );

  /* ---------- planos ---------- */
  const planMap = new Map<string, BuyersReport['plans'][number]>();
  for (const p of input.windowPayments) {
    const meta = planKeyOf(p);
    let row = planMap.get(meta.key);
    if (!row) {
      row = {
        ...meta,
        firstPurchases: 0,
        payments: 0,
        repeatPayments: 0,
        revenue: emptyMoney(),
      };
      planMap.set(meta.key, row);
    }
    row.payments += 1;
    addMoney(row.revenue, p);
    if (firstPaymentOf.get(p.userId)?.id === p.id && newBuyerIds.has(p.userId))
      row.firstPurchases += 1;
    else row.repeatPayments += 1;
  }
  const plans = [...planMap.values()].sort(
    (a, b) => b.firstPurchases - a.firstPurchases || b.payments - a.payments,
  );

  /* ---------- isca → compra (coorte: grants criados na janela) ---------- */
  const earliestGrantByEmail = new Map<string, BuyerGrantRow>();
  const refsByEmail = new Map<string, Set<string>>();
  for (const g of input.windowGrants) {
    const key = normEmail(g.email);
    if (!key) continue;
    const ref = saleRefOf(g.externalEventId);
    if (ref) refsByEmail.set(key, (refsByEmail.get(key) ?? new Set()).add(ref));
    const prev = earliestGrantByEmail.get(key);
    if (!prev || g.createdAt < prev.createdAt) {
      // guarda o vínculo com a conta de qualquer grant do mesmo e-mail
      earliestGrantByEmail.set(key, {
        ...g,
        consumedByUserId: g.consumedByUserId ?? prev?.consumedByUserId ?? null,
        consumedAt: g.consumedAt ?? prev?.consumedAt ?? null,
      });
    } else if (!prev.consumedByUserId && g.consumedByUserId) {
      earliestGrantByEmail.set(key, {
        ...prev,
        consumedByUserId: g.consumedByUserId,
        consumedAt: g.consumedAt,
      });
    }
  }
  const iscaHoursToPurchase: number[] = [];
  const iscaHoursToSignup: number[] = [];
  const bySource = new Map<
    string,
    { source: string; buyers: number; paid: number }
  >();
  const iscaFirstPlans = new Map<
    string,
    { kind: PurchaseKind; key: string; name: string; count: number }
  >();
  let signedUp = 0;
  let paidAfter = 0;
  let paidSubscription = 0;
  let paidCredits = 0;
  let alreadyCustomer = 0;
  const iscaSales: IscaSale[] = [];
  for (const [email, grant] of earliestGrantByEmail) {
    const source = grant.source || 'desconhecido';
    const src = bySource.get(source) ?? { source, buyers: 0, paid: 0 };
    src.buyers += 1;
    bySource.set(source, src);
    const sale: IscaSale = {
      refs: [...(refsByEmail.get(email) ?? [])],
      source,
      signedUp: false,
      paid: false,
      alreadyCustomer: false,
      hoursToPurchase: null,
      firstKind: null,
      firstPlan: null,
    };
    if (sale.refs.length && iscaSales.length < MAX_ISCA_SALES)
      iscaSales.push(sale);

    const user =
      (grant.consumedByUserId
        ? userById.get(grant.consumedByUserId)
        : undefined) ?? userByEmail.get(email);
    if (!user) continue;
    signedUp += 1;
    sale.signedUp = true;
    const signupAt =
      grant.consumedAt && grant.consumedByUserId === user.id
        ? grant.consumedAt
        : user.createdAt;
    if (signupAt.getTime() >= grant.createdAt.getTime())
      iscaHoursToSignup.push(
        (signupAt.getTime() - grant.createdAt.getTime()) / HOUR,
      );

    const payments = (paymentsByUser.get(user.id) ?? [])
      .slice()
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    if (
      payments.some(
        (p) =>
          p.createdAt.getTime() <
          grant.createdAt.getTime() - GRANT_CLOCK_SKEW_MS,
      )
    ) {
      alreadyCustomer += 1;
      sale.alreadyCustomer = true;
      continue;
    }
    const first = payments.find(
      (p) =>
        p.createdAt.getTime() >=
        grant.createdAt.getTime() - GRANT_CLOCK_SKEW_MS,
    );
    if (!first) continue;
    paidAfter += 1;
    src.paid += 1;
    if (first.type === 'SUBSCRIPTION') paidSubscription += 1;
    else paidCredits += 1;
    const hours =
      Math.max(0, first.createdAt.getTime() - grant.createdAt.getTime()) / HOUR;
    iscaHoursToPurchase.push(hours);
    const meta = planKeyOf(first);
    sale.paid = true;
    sale.hoursToPurchase = round1(hours);
    sale.firstKind = meta.kind;
    sale.firstPlan = meta.name;
    const fp = iscaFirstPlans.get(meta.key) ?? {
      kind: meta.kind,
      key: meta.key,
      name: meta.name,
      count: 0,
    };
    fp.count += 1;
    iscaFirstPlans.set(meta.key, fp);
  }
  const iscaBuyers = earliestGrantByEmail.size;
  const eligible = iscaBuyers - alreadyCustomer;

  /* ---------- cadastro → primeira compra (todo cliente novo) ---------- */
  const signupHours: number[] = [];
  for (const id of newBuyerIds) {
    const user = userById.get(id);
    const first = firstPaymentOf.get(id)!;
    if (user && first.createdAt >= user.createdAt)
      signupHours.push(
        (first.createdAt.getTime() - user.createdAt.getTime()) / HOUR,
      );
  }

  /* ---------- campanhas e origens ---------- */
  const campaignMap = new Map<string, BuyersReport['campaigns'][number]>();
  const campaignRow = (u: BuyerUserRow | undefined) => {
    const campaign = normKey(u?.utmCampaign);
    const source = normKey(u?.utmSource);
    const key = `${campaign ?? ''}\u0000${campaign ? '' : (source ?? '')}`;
    let row = campaignMap.get(key);
    if (!row) {
      row = {
        campaign,
        source: campaign ? null : source,
        signups: 0,
        newBuyers: 0,
        fromIsca: 0,
        payments: 0,
        revenue: emptyMoney(),
      };
      campaignMap.set(key, row);
    }
    if (campaign && source && !row.source) row.source = source;
    return row;
  };
  const sourceMap = new Map<string, BuyersReport['sources'][number]>();
  const sourceRow = (u: BuyerUserRow | undefined) => {
    const source = normKey(u?.utmSource);
    const key = source ?? '';
    let row = sourceMap.get(key);
    if (!row) {
      row = { source, signups: 0, newBuyers: 0, revenue: emptyMoney() };
      sourceMap.set(key, row);
    }
    return row;
  };
  for (const u of input.signups) {
    campaignRow(u).signups += 1;
    sourceRow(u).signups += 1;
  }
  for (const id of newBuyerIds) {
    const u = userById.get(id);
    const row = campaignRow(u);
    row.newBuyers += 1;
    if (fromIsca.has(id)) row.fromIsca += 1;
    sourceRow(u).newBuyers += 1;
  }
  for (const p of input.windowPayments) {
    const u = userById.get(p.userId);
    const row = campaignRow(u);
    row.payments += 1;
    addMoney(row.revenue, p);
    addMoney(sourceRow(u).revenue, p);
  }
  const campaigns = [...campaignMap.values()]
    .sort(
      (a, b) =>
        b.newBuyers - a.newBuyers ||
        b.revenue.usdCents +
          b.revenue.brlCents -
          (a.revenue.usdCents + a.revenue.brlCents) ||
        b.signups - a.signups,
    )
    .slice(0, 60);
  const sources = [...sourceMap.values()]
    .sort((a, b) => b.newBuyers - a.newBuyers || b.signups - a.signups)
    .slice(0, 30);

  /* ---------- dia a dia ---------- */
  const dayMap = new Map<string, BuyersReport['daily'][number]>();
  for (let t = since.getTime(); t <= input.now.getTime(); t += 24 * HOUR) {
    const date = brtDay(new Date(t));
    dayMap.set(date, { date, signups: 0, newBuyers: 0, payments: 0 });
  }
  const dayRow = (at: Date) => {
    const date = brtDay(at);
    let row = dayMap.get(date);
    if (!row) {
      row = { date, signups: 0, newBuyers: 0, payments: 0 };
      dayMap.set(date, row);
    }
    return row;
  };
  for (const u of input.signups) dayRow(u.createdAt).signups += 1;
  for (const p of input.windowPayments) dayRow(p.createdAt).payments += 1;
  for (const id of newBuyerIds)
    dayRow(firstPaymentOf.get(id)!.createdAt).newBuyers += 1;
  const daily = [...dayMap.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  return {
    days: input.days,
    since: since.toISOString(),
    generatedAt: input.now.toISOString(),
    totals: {
      signups: input.signups.length,
      newBuyers: newBuyerIds.size,
      payments: input.windowPayments.length,
      repeatPayments,
      revenue,
      newBuyersFromIsca: fromIsca.size,
      firstPurchase,
    },
    countries,
    countryCoverage: coverage,
    languages,
    plans,
    isca: {
      grants: input.windowGrants.length,
      buyers: iscaBuyers,
      signedUp,
      paidAfter,
      paidSubscription,
      paidCredits,
      alreadyCustomer,
      conversionPct: eligible > 0 ? round1((paidAfter / eligible) * 100) : null,
      hoursToPurchase: durationStats(iscaHoursToPurchase),
      hoursToSignup: durationStats(iscaHoursToSignup),
      histogram: histogram(iscaHoursToPurchase),
      bySource: [...bySource.values()].sort((a, b) => b.buyers - a.buyers),
      firstPlans: [...iscaFirstPlans.values()].sort(
        (a, b) => b.count - a.count,
      ),
      sales: iscaSales,
    },
    signupToPurchase: {
      stats: durationStats(signupHours),
      histogram: histogram(signupHours),
    },
    campaigns,
    sources,
    daily,
  };
}
