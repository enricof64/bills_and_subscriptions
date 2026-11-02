import { useState, useEffect, useMemo } from "react";
import { Plus } from "lucide-react";
import { PageLayout } from "../components/PageLayout";
import { LogoAvatar } from "../components/LogoAvatar";
import { getContext } from "../context";
import {
  type Subscription,
  type SubscriptionCategory,
  type Bill,
  type BillCategory,
  CATEGORY_COLORS,
  BILL_CATEGORY_COLORS,
  getSubscriptions,
  getBills,
  getSettings,
  saveSubscription,
  generateId,
  toMonthly,
  toYearly,
  formatCurrency,
  extractDomain,
  monthKey,
  formatMonthLabel,
  todayISO,
  isHydrated,
  saveLogo,
} from "../lib/storage";
import { useBaseCurrency } from "../lib/useBaseCurrency";
import { SubForm, blankSubForm, type SubFormState } from "../components/SubForm";

const CURRENT_PATH = "/addons/bills-and-subscriptions/summary";

interface SubCategoryTotal {
  category: SubscriptionCategory;
  monthly: number;
  yearly: number;
  currency: string;
  count: number;
}

interface BillCategoryTotal {
  category: BillCategory;
  total: number;
  currency: string;
  count: number;
}

const MONTH_KEY_RE = /^(\d{4})-(\d{2})$/;

/** Numeric parts of a "YYYY-MM" key, or null if malformed. */
function parseMonthKeyParts(key: string): { y: number; m: number } | null {
  const match = MONTH_KEY_RE.exec(key);
  return match ? { y: Number(match[1]), m: Number(match[2]) } : null;
}

/** Whole months from `fromKey` to `toKey`, counting both ends. 0 if malformed. */
function monthSpanInclusive(fromKey: string, toKey: string): number {
  const from = parseMonthKeyParts(fromKey);
  const to = parseMonthKeyParts(toKey);
  if (!from || !to) return 0;
  return to.y * 12 + to.m - (from.y * 12 + from.m) + 1;
}

/**
 * "2026-02" -> "Feb 26", built from numeric parts and rendered in UTC — the same
 * discipline as storage.formatMonthLabel, so no timezone can shift the month.
 * The chart's x-axis deliberately does NOT use formatMonthLabel: its full
 * "February 2026" is far too wide for six ticks in a 480px viewBox. The full
 * label is exposed to assistive tech via aria-label instead.
 */
function shortMonthLabel(key: string): string {
  const p = parseMonthKeyParts(key);
  if (!p) return key;
  return new Date(Date.UTC(p.y, p.m - 1, 1)).toLocaleDateString(undefined, {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
}

function fmtTick(v: number): string {
  if (v >= 10000) return `${(v / 1000).toFixed(0)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

export function SummaryPage() {
  const baseCurrency = useBaseCurrency();
  const [settings, setSettings] = useState(getSettings);
  const billsEnabled = settings.billsEnabled;
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [ready, setReady] = useState(isHydrated);

  useEffect(() => {
    const onSettingsChanged = () => {
      const next = getSettings();
      setSettings(next);
      if (!next.billsEnabled) setBills([]);
      else setBills(getBills());
    };
    window.addEventListener("ss:settings-changed", onSettingsChanged);
    return () => window.removeEventListener("ss:settings-changed", onSettingsChanged);
  }, []);

  useEffect(() => {
    setSubscriptions(getSubscriptions());
    if (billsEnabled) setBills(getBills());
  }, [billsEnabled]);

  // The add form needs the real account list, otherwise its account dropdown is
  // silently empty and every subscription added here is unassigned.
  useEffect(() => {
    let mounted = true;
    const ctx = getContext();
    ctx.api.accounts
      .getAll()
      .then((all) => {
        // Navigating away mid-fetch must not write into an unmounted component.
        if (!mounted) return;
        setAccounts(all.filter((a) => a.isActive).map((a) => ({ id: a.id, name: a.name })));
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        // The user needs to know the picker will be empty; the cause belongs in the log.
        ctx.api.toast.error("Couldn't load accounts. The account picker will be empty.");
        ctx.api.logger.error(
          `[bills-and-subscriptions] SummaryPage accounts.getAll failed: ${describeError(err)}`,
        );
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const onHydrated = () => {
      setReady(true);
      setSettings(getSettings());
      setSubscriptions(getSubscriptions());
      setBills(getBills());
    };
    window.addEventListener("ss:storage-hydrated", onHydrated);
    return () => window.removeEventListener("ss:storage-hydrated", onHydrated);
  }, []);

  const handleAddSub = async (form: SubFormState) => {
    if (!ready) return;
    // Persist every field the form collects — startDate in particular, because
    // Wealthfolio Sync skips subscriptions that have none.
    const id = generateId();
    saveSubscription({
      id,
      name: form.name.trim(),
      amount: parseFloat(form.amount) || 0,
      currency: form.currency,
      billingCycle: form.billingCycle,
      category: form.category,
      startDate: form.startDate || undefined,
      website: form.website.trim() || undefined,
      notes: form.notes.trim() || undefined,
      active: form.active,
      accountId: form.accountId || undefined,
    });
    setShowAddForm(false);
    if (form.logo) await saveLogo("sub", id, form.logo);
    setSubscriptions(getSubscriptions());
  };

  // ── Subscriptions ─────────────────────────────────────────────────────────
  const active = useMemo(() => subscriptions.filter((s) => s.active), [subscriptions]);

  const byCurrency = useMemo(
    () =>
      active.reduce<Record<string, Subscription[]>>((acc, s) => {
        if (!acc[s.currency]) acc[s.currency] = [];
        acc[s.currency].push(s);
        return acc;
      }, {}),
    [active],
  );

  const currencies = useMemo(() => Object.keys(byCurrency), [byCurrency]);
  const primaryCurrency = currencies[0] ?? "USD";
  const primarySubs = byCurrency[primaryCurrency] ?? [];

  const grandMonthly = useMemo(
    () => primarySubs.reduce((sum, s) => sum + toMonthly(s.amount, s.billingCycle), 0),
    [primarySubs],
  );
  const grandYearly = useMemo(
    () => primarySubs.reduce((sum, s) => sum + toYearly(s.amount, s.billingCycle), 0),
    [primarySubs],
  );

  const subCategoryTotals = useMemo(() => {
    const map = primarySubs.reduce<Record<string, SubCategoryTotal>>((acc, s) => {
      const cat = s.category;
      if (!acc[cat]) acc[cat] = { category: cat, monthly: 0, yearly: 0, currency: s.currency, count: 0 };
      acc[cat].monthly += toMonthly(s.amount, s.billingCycle);
      acc[cat].yearly  += toYearly(s.amount, s.billingCycle);
      acc[cat].count   += 1;
      return acc;
    }, {});
    return Object.values(map).sort((a, b) => b.monthly - a.monthly);
  }, [primarySubs]);

  const maxSubMonthly = subCategoryTotals[0]?.monthly ?? 1;

  const sortedSubs = useMemo(
    () =>
      [...primarySubs].sort(
        (a, b) => toMonthly(b.amount, b.billingCycle) - toMonthly(a.amount, a.billingCycle),
      ),
    [primarySubs],
  );

  // ── Bills ─────────────────────────────────────────────────────────────────
  // Everything below groups on the stable "YYYY-MM" key. Localised month labels
  // are produced only at render time: parsing "2026-02-01" with new Date() reads
  // as UTC midnight but renders in local time, so west of Greenwich every bill
  // dated the 1st fell into the previous month.
  const currentMonthKey = monthKey(todayISO());

  const thisMonthBills = useMemo(
    () => bills.filter((b) => monthKey(b.date) === currentMonthKey),
    [bills, currentMonthKey],
  );
  const billPrimaryCur = thisMonthBills[0]?.currency ?? bills[0]?.currency ?? primaryCurrency;

  // This-month totals
  const billMonthTotal = useMemo(
    () => thisMonthBills.reduce((sum, b) => sum + b.amount, 0),
    [thisMonthBills],
  );
  const unpaidThisMonth = useMemo(() => thisMonthBills.filter((b) => !b.paid), [thisMonthBills]);
  const billUnpaidTotal = useMemo(
    () => unpaidThisMonth.reduce((sum, b) => sum + b.amount, 0),
    [unpaidThisMonth],
  );
  const billUnpaidCount = unpaidThisMonth.length;

  // Category breakdown across all bills (not just this month)
  const billCategoryTotals = useMemo(() => {
    const map = bills.reduce<Record<string, BillCategoryTotal & { bills: Bill[] }>>((acc, b) => {
      const cat = b.category;
      if (!acc[cat]) acc[cat] = { category: cat, total: 0, currency: b.currency, count: 0, bills: [] };
      acc[cat].total += b.amount;
      acc[cat].count += 1;
      // Keep unique bills by name for logo display
      const isDuplicate = acc[cat].bills.some((existing) => {
        if (b.website && existing.website)
          return extractDomain(b.website) === extractDomain(existing.website);
        return existing.name.trim().toLowerCase() === b.name.trim().toLowerCase();
      });
      if (!isDuplicate) acc[cat].bills.push(b);
      return acc;
    }, {});
    return Object.values(map).sort((a, b) => b.total - a.total);
  }, [bills]);

  const maxBillTotal = billCategoryTotals[0]?.total ?? 1;

  // Bills keyed by month. Bills with an unparseable date have no month to belong
  // to, so they are left out of the history rather than bucketed under "".
  const billsByMonth = useMemo(
    () =>
      bills.reduce<Record<string, { total: number; currency: string }>>((acc, b) => {
        const key = monthKey(b.date);
        if (!key) return acc;
        if (!acc[key]) acc[key] = { total: 0, currency: b.currency };
        acc[key].total += b.amount;
        return acc;
      }, {}),
    [bills],
  );

  // Last 6 months bill history. Month keys sort chronologically as plain strings
  // ("2026-02" < "2026-10"), with no locale or Date parsing in the comparison.
  const billMonthHistory = useMemo(
    () =>
      Object.entries(billsByMonth)
        .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
        .slice(0, 6)
        .reverse(),
    [billsByMonth],
  );

  const maxMonthHistory = useMemo(
    () => Math.max(...billMonthHistory.map(([, v]) => v.total), 1),
    [billMonthHistory],
  );

  const hasSubscriptions = active.length > 0;
  const hasBills = billsEnabled && bills.length > 0;

  const billTotalAllTime = useMemo(() => bills.reduce((sum, b) => sum + b.amount, 0), [bills]);

  // Monthly average over the full calendar range the bills actually cover:
  // first recorded month → current month (or the last recorded month, if bills are
  // dated ahead), inclusive. Dividing by "months that have a bill" reported two
  // bills eight months apart as a 2-month average, roughly quadrupling the figure.
  const billMonthlyAvg = useMemo(() => {
    const keys = Object.keys(billsByMonth);
    if (keys.length === 0) return 0;
    let first = keys[0];
    let last = keys[0];
    for (const k of keys) {
      if (k < first) first = k;
      if (k > last) last = k;
    }
    const end = last > currentMonthKey ? last : currentMonthKey;
    const months = monthSpanInclusive(first, end);
    return months > 0 ? billTotalAllTime / months : 0;
  }, [billsByMonth, billTotalAllTime, currentMonthKey]);

  // Combined totals. There are no FX rates available here, so a single total is
  // only ever shown when subscriptions and bills are in the same currency.
  const currenciesMismatch = hasSubscriptions && hasBills && billPrimaryCur !== primaryCurrency;
  const combinedCurrency = hasSubscriptions ? primaryCurrency : billPrimaryCur;
  const combinedMonthly = grandMonthly + billMonthlyAvg;
  const combinedYearly = grandYearly + billMonthlyAvg * 12;

  // Chart geometry — memoised alongside the data it draws. null when there is
  // not enough history to plot (the JSX below renders nothing in that case).
  const chart = useMemo(() => {
    const n = billMonthHistory.length;
    if (n < 2) return null;

    const VIEW_W = 480;
    const VIEW_H = 180;
    const PAD_L = 44;
    const PAD_R = 44;
    const PAD_T = 12;
    const PAD_B = 22;
    const plotW = VIEW_W - PAD_L - PAD_R;
    const plotH = VIEW_H - PAD_T - PAD_B;
    const slotW = plotW / n;
    const barW = Math.max(slotW * 0.24, 3);

    const cumulativeTotals: number[] = [];
    let running = 0;
    for (const [, { total }] of billMonthHistory) {
      running += total;
      cumulativeTotals.push(running);
    }
    const maxCumulative = running || 1;
    const barYMax = maxMonthHistory || 1;

    const toX = (i: number) => PAD_L + slotW * i + slotW / 2;
    const toBarY = (v: number) => PAD_T + plotH - (v / barYMax) * plotH;
    const toLineY = (v: number) => PAD_T + plotH - (v / maxCumulative) * plotH;

    const TICK_COUNT = 4;
    const barTicks = Array.from({ length: TICK_COUNT + 1 }, (_, i) => Math.round((i / TICK_COUNT) * barYMax));
    const lineTicks = Array.from({ length: TICK_COUNT + 1 }, (_, i) => Math.round((i / TICK_COUNT) * maxCumulative));
    const linePoints = cumulativeTotals.map((v, i) => `${toX(i)},${toLineY(v)}`).join(' ');

    return {
      VIEW_W, VIEW_H, PAD_L, PAD_R, PAD_T, PAD_B, plotH, barW,
      cumulativeTotals, barYMax, toX, toBarY, toLineY, barTicks, lineTicks, linePoints,
    };
  }, [billMonthHistory, maxMonthHistory]);

  if (!hasSubscriptions && !hasBills) {
    return (
      <PageLayout activePath={CURRENT_PATH}>
        <div className="flex flex-col items-center justify-center py-20 gap-2 text-center px-4">
          <p className="text-sm text-muted-foreground">Nothing to summarise yet.</p>
          <p className="text-xs text-muted-foreground/60">Add subscriptions or bills to see your spending overview.</p>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout activePath={CURRENT_PATH}>
      <div className="px-4 py-4 flex flex-col gap-4">

        {/* ── TOP ROW: total spend ─────────────────────────────────────────── */}
        {(hasSubscriptions || hasBills) && (
          <div className="border rounded-xl p-5 w-[calc(50%-0.5rem)]" style={{ backgroundColor: "color-mix(in srgb, var(--chart-1) 8%, transparent)", borderColor: "color-mix(in srgb, var(--chart-1) 25%, transparent)" }}>
            <div className={`grid divide-x divide-border items-stretch ${hasBills ? "grid-cols-3" : "grid-cols-2"}`}>

              {/* 1/3: Monthly total */}
              <div className="flex flex-col justify-center gap-1 pr-5">
                <span className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">Total spend</span>
                {currenciesMismatch ? (
                  /* Summing across currencies without exchange rates would invent a
                     number, so the two components are shown instead of a total. */
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs text-muted-foreground">Subscriptions</span>
                      <span className="text-xl font-bold text-foreground tabular-nums leading-none">
                        {formatCurrency(grandMonthly, primaryCurrency)}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs text-muted-foreground">Bills</span>
                      <span className="text-xl font-bold text-foreground tabular-nums leading-none">
                        {formatCurrency(billMonthlyAvg, billPrimaryCur)}
                      </span>
                    </div>
                  </div>
                ) : (
                  <span className="text-3xl font-bold text-foreground tabular-nums leading-none">
                    {formatCurrency(combinedMonthly, combinedCurrency)}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">per month</span>
              </div>

              {/* 2/3: Yearly projection */}
              <div className="flex flex-col justify-center gap-1 px-5">
                <span className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">Yearly projection</span>
                {currenciesMismatch ? (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs text-muted-foreground">Subscriptions</span>
                      <span className="text-xl font-bold text-foreground tabular-nums leading-none">
                        {formatCurrency(grandYearly, primaryCurrency)}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs text-muted-foreground">Bills</span>
                      <span className="text-xl font-bold text-foreground tabular-nums leading-none">
                        {formatCurrency(billMonthlyAvg * 12, billPrimaryCur)}
                      </span>
                    </div>
                  </div>
                ) : (
                  <span className="text-3xl font-bold text-foreground tabular-nums leading-none">
                    {formatCurrency(combinedYearly, combinedCurrency)}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  {currenciesMismatch
                    ? "per year"
                    : `${formatCurrency(combinedYearly / 52, combinedCurrency)} / week`}
                </span>
              </div>

              {/* 3/3: Spend sources — a percentage split of a cross-currency sum
                     would be as meaningless as the sum itself, so it is hidden then. */}
              {hasSubscriptions && hasBills && !currenciesMismatch && combinedMonthly > 0 && (
                <div className="flex flex-col justify-center gap-3 pl-5">
                  {(() => {
                    const pct = Math.round((grandMonthly / combinedMonthly) * 100);
                    return (
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Subscriptions</span>
                          <span className="font-semibold text-foreground tabular-nums">{formatCurrency(grandMonthly, combinedCurrency)}</span>
                        </div>
                        <div className="relative h-3 rounded-full overflow-hidden" style={{ backgroundColor: "color-mix(in srgb, var(--chart-1) 20%, transparent)" }}>
                          <div className="h-full rounded-full flex items-center" style={{ width: `${pct}%`, backgroundColor: "color-mix(in srgb, var(--chart-1) 60%, var(--chart-2))" }}>
                            <span className="text-xs font-semibold text-white px-2 whitespace-nowrap">{pct}%</span>
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                  {(() => {
                    const pct = Math.round((billMonthlyAvg / combinedMonthly) * 100);
                    return (
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Bills</span>
                          <span className="font-semibold text-foreground tabular-nums">{formatCurrency(billMonthlyAvg, combinedCurrency)}</span>
                        </div>
                        <div className="relative h-3 rounded-full overflow-hidden" style={{ backgroundColor: "color-mix(in srgb, var(--chart-5) 20%, transparent)" }}>
                          <div className="h-full rounded-full flex items-center" style={{ width: `${pct}%`, backgroundColor: "color-mix(in srgb, var(--chart-5) 60%, var(--chart-6))" }}>
                            <span className="text-xs font-semibold text-white px-2 whitespace-nowrap">{pct}%</span>
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}

            </div>
            {currenciesMismatch && (
              <p className="text-xs text-muted-foreground/60 mt-3">
                Subscriptions are in {primaryCurrency} and bills in {billPrimaryCur}; shown separately, not converted.
              </p>
            )}
          </div>
        )}

        {/* ── SUBSCRIPTIONS + BILLS SIDE BY SIDE ──────────────────────────── */}
        <div className="grid grid-cols-2 gap-4 items-start">

          {/* ── SUBSCRIPTIONS ─────────────────────────────────────────────── */}
          {hasSubscriptions && (
            <div className="flex flex-col gap-3">
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Subscriptions</h2>

              <div className="grid grid-cols-2 gap-3">
                <div className="bg-card border border-border rounded-xl p-4 flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Monthly</span>
                  <span className="text-xl font-bold text-foreground tabular-nums">
                    {formatCurrency(grandMonthly, primaryCurrency)}
                  </span>
                  <span className="text-xs text-muted-foreground">{active.length} active</span>
                </div>
                <div className="bg-card border border-border rounded-xl p-4 flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Yearly</span>
                  <span className="text-xl font-bold text-foreground tabular-nums">
                    {formatCurrency(grandYearly, primaryCurrency)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatCurrency(grandYearly / 52, primaryCurrency)}/wk
                  </span>
                </div>
              </div>

              {currencies.length > 1 && (
                <p className="text-xs text-muted-foreground/70 px-1">
                  Showing {primaryCurrency} only. Also in {currencies.slice(1).join(", ")}.
                </p>
              )}

              {subCategoryTotals.length > 0 && (
                <div className="bg-card border border-border rounded-xl p-4 flex flex-col gap-4">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">By category</h3>
                  {subCategoryTotals.map((ct) => {
                    const colors = CATEGORY_COLORS[ct.category];
                    const barPct = Math.round((ct.monthly / maxSubMonthly) * 100);
                    return (
                      <div key={ct.category} className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: colors.bg, color: colors.color }}>
                              {ct.category}
                            </span>
                            <span className="text-xs text-muted-foreground/60">{ct.count} {ct.count === 1 ? "sub" : "subs"}</span>
                          </div>
                          <span className="text-sm font-semibold text-foreground tabular-nums">
                            {formatCurrency(ct.monthly, ct.currency)}<span className="text-xs font-normal text-muted-foreground">/mo</span>
                          </span>
                        </div>
                        <div className="h-1 bg-muted rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${barPct}%`, backgroundColor: colors.color, opacity: 0.7 }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="bg-card border border-border rounded-xl p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Stack</h3>
                  <button
                    onClick={() => ready && setShowAddForm(true)}
                    disabled={!ready}
                    className="w-5 h-5 rounded-full flex items-center justify-center bg-muted hover:bg-muted-foreground/20 transition-colors disabled:opacity-40"
                  >
                    <Plus className="w-3 h-3 text-muted-foreground" />
                  </button>
                </div>

                {sortedSubs.length === 0 ? (
                  <p className="text-xs text-muted-foreground/60 py-2">No active subscriptions.</p>
                ) : (
                  sortedSubs.map((sub, idx) => (
                    <div key={sub.id} className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground/50 w-4 text-right shrink-0 tabular-nums">{idx + 1}</span>
                      <LogoAvatar id={sub.id} kind="sub" name={sub.name} colors={CATEGORY_COLORS[sub.category]} size="sm" />
                      <span className="text-sm text-foreground flex-1 truncate">{sub.name}</span>
                      <span className="text-sm font-semibold text-foreground tabular-nums shrink-0">
                        {formatCurrency(toMonthly(sub.amount, sub.billingCycle), sub.currency)}
                        <span className="text-xs font-normal text-muted-foreground">/mo</span>
                      </span>
                    </div>
                  ))
                )}

              </div>
            </div>
          )}

          {/* ── BILLS ─────────────────────────────────────────────────────── */}
          {hasBills && (
            <div className="flex flex-col gap-3">
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Bills</h2>

              {thisMonthBills.length > 0 && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-card border border-border rounded-xl p-4 flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">This month</span>
                    <span className="text-xl font-bold text-foreground tabular-nums">
                      {formatCurrency(billMonthTotal, billPrimaryCur)}
                    </span>
                    <span className="text-xs text-muted-foreground">{thisMonthBills.length} bill{thisMonthBills.length !== 1 ? "s" : ""}</span>
                  </div>
                  <div className="bg-card border border-border rounded-xl p-4 flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">Unpaid</span>
                    <span className="text-xl font-bold text-foreground tabular-nums">
                      {formatCurrency(billUnpaidTotal, billPrimaryCur)}
                    </span>
                    <span className="text-xs text-muted-foreground">{billUnpaidCount} outstanding</span>
                  </div>
                </div>
              )}

              {billMonthHistory.length > 1 && (() => {
                if (!chart) return null;
                const {
                  VIEW_W, VIEW_H, PAD_L, PAD_R, PAD_T, plotH, barW,
                  cumulativeTotals, barYMax, toX, toBarY, toLineY, barTicks, lineTicks, linePoints,
                } = chart;

                return (
                  <div className="bg-card border border-border rounded-xl p-4 flex flex-col gap-2">
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Monthly history</h3>
                    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} width="100%" className="overflow-visible">
                      {/* Grid lines */}
                      {barTicks.map((tick, i) => (
                        <line key={i} x1={PAD_L} y1={toBarY(tick)} x2={VIEW_W - PAD_R} y2={toBarY(tick)}
                          stroke="currentColor" strokeOpacity={i === 0 ? 0 : 0.06} strokeWidth="1" />
                      ))}
                      {/* Baseline */}
                      <line x1={PAD_L} y1={toBarY(0)} x2={VIEW_W - PAD_R} y2={toBarY(0)}
                        style={{ stroke: "var(--chart-3)" }} strokeWidth="0.5" strokeDasharray="2 4" strokeLinecap="round" />
                      {/* Left Y-axis labels */}
                      {barTicks.filter((_, i) => i > 0).map((tick, i) => (
                        <text key={i} x={PAD_L - 6} y={toBarY(tick) + 3.5}
                          textAnchor="end" fontSize="9" fill="currentColor" fillOpacity="0.45">
                          {fmtTick(tick)}
                        </text>
                      ))}
                      {/* Right Y-axis labels (cumulative) */}
                      {lineTicks.filter((_, i) => i > 0).map((tick, i) => (
                        <text key={i} x={VIEW_W - PAD_R + 6} y={toLineY(tick) + 3.5}
                          textAnchor="start" fontSize="9" fill="var(--chart-2)" fillOpacity="0.8">
                          {fmtTick(tick)}
                        </text>
                      ))}
                      {/* Bars */}
                      {billMonthHistory.map(([month, { total }], i) => {
                        const isCurrentMonth = month === currentMonthKey;
                        const bH = Math.max((total / barYMax) * plotH, 1);
                        const x = toX(i) - barW / 2;
                        const y = PAD_T + plotH - bH;
                        const r = Math.min(5, barW / 2, bH);
                        const d = `M${x},${y + bH} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + barW - r},${y} Q${x + barW},${y} ${x + barW},${y + r} L${x + barW},${y + bH} Z`;
                        return (
                          <g key={month}>
                            <path d={d}
                              style={{ fill: isCurrentMonth ? "var(--chart-1)" : "color-mix(in srgb, var(--chart-3) 45%, transparent)" }} />
                            <text x={toX(i)} y={y - 4}
                              textAnchor="middle" fontSize="8" fill="currentColor" fillOpacity={isCurrentMonth ? 0.8 : 0.45}
                              fontWeight={isCurrentMonth ? "600" : "400"}>
                              {fmtTick(total)}
                            </text>
                          </g>
                        );
                      })}
                      {/* Cumulative line */}
                      <polyline points={linePoints} fill="none" style={{ stroke: "var(--chart-2)" }}
                        strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
                      {/* Line dots */}
                      {cumulativeTotals.map((v, i) => (
                        <circle key={i} cx={toX(i)} cy={toLineY(v)} r="2.5" style={{ fill: "var(--chart-2)" }} />
                      ))}
                      {/* X-axis labels */}
                      {billMonthHistory.map(([month], i) => {
                        const isCurrentMonth = month === currentMonthKey;
                        return (
                          <text key={month} x={toX(i)} y={VIEW_H - 4}
                            textAnchor="middle" fontSize="9"
                            fill="currentColor" fillOpacity={isCurrentMonth ? 0.8 : 0.4}
                            fontWeight={isCurrentMonth ? "600" : "400"}
                            aria-label={formatMonthLabel(month)}>
                            {shortMonthLabel(month)}
                          </text>
                        );
                      })}
                    </svg>
                    <div className="flex items-center gap-5 pt-1">
                      <div className="flex items-center gap-1.5">
                        <div className="w-3 h-2.5 rounded-sm" style={{ backgroundColor: "color-mix(in srgb, var(--chart-3) 50%, transparent)" }} />
                        <span className="text-xs text-muted-foreground">Monthly</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <svg width="16" height="10" viewBox="0 0 16 10">
                          <line x1="0" y1="5" x2="16" y2="5" style={{ stroke: "var(--chart-2)" }} strokeWidth="1.5" />
                          <circle cx="8" cy="5" r="2.5" style={{ fill: "var(--chart-2)" }} />
                        </svg>
                        <span className="text-xs text-muted-foreground">Cumulative</span>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {billCategoryTotals.length > 0 && (
                <div className="bg-card border border-border rounded-xl p-4 flex flex-col gap-4">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">By category</h3>
                  {billCategoryTotals.map((ct) => {
                    const colors = BILL_CATEGORY_COLORS[ct.category];
                    const barPct = Math.round((ct.total / maxBillTotal) * 100);
                    const uniqueBills = (ct as BillCategoryTotal & { bills: Bill[] }).bills;
                    const categoryBills = uniqueBills.slice(0, 4);
                    const overflow = uniqueBills.length - categoryBills.length;
                    return (
                      <div key={ct.category} className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-xs px-2 py-0.5 rounded-full font-medium shrink-0" style={{ backgroundColor: colors.bg, color: colors.color }}>
                              {ct.category}
                            </span>
                            {/* Bill logos */}
                            <div className="flex items-center gap-1">
                              {categoryBills.map((b) => (
                                <LogoAvatar key={b.id} id={b.id} kind="bill" name={b.name} colors={colors} size="sm" />
                              ))}
                              {overflow > 0 && (
                                <span className="text-xs text-muted-foreground/60 ml-1">+{overflow}</span>
                              )}
                            </div>
                          </div>
                          <span className="text-sm font-semibold text-foreground tabular-nums">{formatCurrency(ct.total, ct.currency)}</span>
                        </div>
                        <div className="h-1 bg-muted rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${barPct}%`, backgroundColor: colors.color, opacity: 0.7 }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

        </div>
      </div>
      {showAddForm && (
        <SubForm
          initial={blankSubForm(baseCurrency)}
          editingId={null}
          accounts={accounts}
          onSave={handleAddSub}
          onDelete={() => {}}
          onClose={() => setShowAddForm(false)}
        />
      )}
    </PageLayout>
  );
}
