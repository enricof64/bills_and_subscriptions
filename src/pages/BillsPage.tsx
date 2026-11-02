import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useBaseCurrency } from "../lib/useBaseCurrency";
import { Plus, Pencil, Trash2, Zap, ChevronDown, RefreshCw, Link2, Loader2, Search, X, Upload } from "lucide-react";
import { PageLayout } from "../components/PageLayout";
import { LogoAvatar } from "../components/LogoAvatar";
import { TransactionPickerModal } from "../components/TransactionPickerModal";
import {
  type Bill,
  type BillCategory,
  type BillingCycle,
  type Currency,
  BILL_CATEGORIES,
  BILL_CATEGORY_COLORS,
  CURRENCIES,
  getBills,
  saveBill,
  deleteBill,
  generateId,
  formatCurrency,
  advanceDateByCycle,
  todayISO,
  monthKey,
  formatMonthLabel,
  formatDayLabel,
  isHydrated,
  getLogo,
  saveLogo,
  deleteLogo,
} from "../lib/storage";
import {
  loadExpenseActivities,
  matchAgainst,
  MIN_SUGGEST_CONFIDENCE,
  type ExpenseTx,
  type MatchTarget,
  type TransactionMatch,
} from "../lib/linker";
import {
  saveLink,
  removeLinksForEntity,
  getLinkKeys,
  getLinkedActivityIds,
  linkKey,
} from "../lib/linker-storage";
import { prepareLogoUpload } from "../lib/image";
import { getContext } from "../context";

const CURRENT_PATH = "/addons/bills-and-subscriptions/bills";

const BILL_CYCLES: { value: BillingCycle; label: string }[] = [
  { value: "monthly",   label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly",    label: "Yearly" },
];

const BLANK_FORM = {
  name: "",
  amount: "",
  currency: "EUR" as Currency,
  category: "Electricity" as BillCategory,
  date: todayISO(),
  website: "",
  notes: "",
  paid: false,
  recurring: false,
  billingCycle: "monthly" as BillingCycle,
  accountId: "",
  logo: undefined as string | undefined,
};

type FormState = typeof BLANK_FORM;

interface BillFormProps {
  initial: FormState;
  editingId: string | null;
  accounts: { id: string; name: string }[];
  onSave: (form: FormState) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

function BillForm({ initial, editingId, accounts, onSave, onDelete, onClose }: BillFormProps) {
  const [form, setForm] = useState<FormState>(initial);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const set = (field: keyof FormState, value: unknown) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const handleLogoPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const dataUri = await prepareLogoUpload(file);
    if (!dataUri) {
      getContext().api.toast.error("Couldn't use that image — try a smaller or simpler one.");
      return;
    }
    set("logo", dataUri);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.55)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md p-5 flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-foreground">
          {editingId ? "Edit bill" : "Add bill"}
        </h2>

        {/* Logo */}
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-lg overflow-hidden shrink-0 bg-muted flex items-center justify-center">
            {form.logo ? (
              <img src={form.logo} alt="" className="w-full h-full object-cover" />
            ) : (
              <Upload className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
          <div className="flex flex-col gap-1">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="absolute w-px h-px p-0 -m-px overflow-hidden opacity-0"
              style={{ clip: "rect(0,0,0,0)" }}
              onChange={handleLogoPick}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-xs font-medium text-foreground hover:underline w-fit"
            >
              {form.logo ? "Change logo" : "Upload logo"}
            </button>
            {form.logo && (
              <button
                type="button"
                onClick={() => set("logo", undefined)}
                className="text-xs text-muted-foreground hover:text-red-400 w-fit"
              >
                Remove
              </button>
            )}
          </div>
        </div>

        {/* Name */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-muted-foreground">Name</label>
          <input
            type="text"
            placeholder="e.g. Water Q1, January electricity…"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            className="bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        {/* Website */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-muted-foreground">Website <span className="text-muted-foreground/50">(optional)</span></label>
          <input
            type="text"
            placeholder="e.g. edf.fr, voo.be…"
            value={form.website}
            onChange={(e) => set("website", e.target.value)}
            className="bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        {/* Amount + Currency */}
        <div className="flex gap-2">
          <div className="flex flex-col gap-1.5 flex-1">
            <label className="text-xs text-muted-foreground">Amount</label>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={form.amount}
              onChange={(e) => set("amount", e.target.value)}
              className="bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="flex flex-col gap-1.5 w-28">
            <label className="text-xs text-muted-foreground">Currency</label>
            <select
              value={form.currency}
              onChange={(e) => set("currency", e.target.value as Currency)}
              className="bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        {/* Category */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-muted-foreground">Category</label>
          <select
            value={form.category}
            onChange={(e) => set("category", e.target.value as BillCategory)}
            className="bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {BILL_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        {/* Date */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-muted-foreground">Date received</label>
          <input
            type="date"
            value={form.date}
            onChange={(e) => set("date", e.target.value)}
            className="bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        {/* Recurring toggle */}
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <label className="text-xs text-muted-foreground">Recurring</label>
            {form.recurring && (
              <span className="text-xs text-muted-foreground/60">
                Next bill created automatically when paid
              </span>
            )}
          </div>
          <button
            onClick={() => set("recurring", !form.recurring)}
            className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${form.recurring ? "bg-primary" : "bg-muted"}`}
          >
            <span
              className="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all"
              style={{ left: form.recurring ? "calc(100% - 18px)" : "2px" }}
            />
          </button>
        </div>

        {/* Billing cycle — only when recurring */}
        {form.recurring && (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-muted-foreground">Billing cycle</label>
            <div className="flex gap-2">
              {BILL_CYCLES.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => set("billingCycle", value)}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    form.billingCycle === value
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Paid toggle */}
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">Mark as paid</label>
          <button
            onClick={() => set("paid", !form.paid)}
            className={`w-9 h-5 rounded-full transition-colors relative ${form.paid ? "bg-primary" : "bg-muted"}`}
          >
            <span
              className="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all"
              style={{ left: form.paid ? "calc(100% - 18px)" : "2px" }}
            />
          </button>
        </div>

        {/* Account */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-muted-foreground">
            Account <span className="text-muted-foreground/50">(optional — narrows transaction search)</span>
          </label>
          <select
            value={form.accountId}
            onChange={(e) => set("accountId", e.target.value)}
            className="bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">— any account —</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>

        {/* Notes */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-muted-foreground">Notes <span className="text-muted-foreground/50">(optional)</span></label>
          <input
            type="text"
            placeholder="e.g. Higher than usual due to winter…"
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            className="bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1 border-t border-border mt-1">
          {editingId && (
            <button
              onClick={() => onDelete(editingId)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-red-400 hover:bg-red-400/10 transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => { if (form.name.trim() && form.amount) onSave(form); }}
            disabled={!form.name.trim() || !form.amount}
            className="px-4 py-1.5 rounded-lg text-sm font-semibold disabled:opacity-40 transition-opacity bg-primary text-primary-foreground"
          >
            {editingId ? "Save" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Everything about a bill that can change WHICH transaction matches it. The
 * scan cache is keyed on this, so an edit to the name/amount/currency/date/
 * account re-scans while an unrelated re-render (or flipping `paid`) does not.
 */
function scanSignature(bill: Bill): string {
  return [bill.id, bill.name, bill.amount, bill.currency, bill.date, bill.accountId ?? ""].join("|");
}

/** Day-of-month from a "YYYY-MM-DD" string, without going through Date. */
function dayOfMonth(dateStr: string): number | null {
  const day = Number(dateStr.slice(8, 10));
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : null;
}

/** Same recurring series: what the user would call "the same bill, next cycle". */
function isSameSeries(a: Bill, b: Bill): boolean {
  return a.name === b.name && a.category === b.category && a.currency === b.currency;
}

/**
 * The day-of-month this recurring series is anchored to, so a bill due on the
 * 31st does not walk backwards (31 Jan -> 28 Feb -> 28 Mar -> …).
 *
 * Clamping only ever pulls a date EARLIER, and only in months shorter than the
 * anchor — so a day of 27 or less was never clamped and needs no recovery.
 * When the day could be a clamp result, the largest day seen elsewhere in the
 * series is the closest thing we have to the original anchor. Returns undefined
 * to let advanceDateByCycle default to the bill's own day.
 */
function seriesAnchorDay(bill: Bill, all: Bill[]): number | undefined {
  const day = dayOfMonth(bill.date);
  if (day === null || day < 28) return undefined;
  let anchor = day;
  for (const other of all) {
    if (other.id === bill.id || !other.recurring || !isSameSeries(bill, other)) continue;
    const d = dayOfMonth(other.date);
    if (d !== null && d > anchor) anchor = d;
  }
  return anchor > day ? anchor : undefined;
}

/**
 * Activities already linked to a DIFFERENT entity — those must not be offered
 * again. Activities linked to this bill are deliberately kept: the row's
 * "already linked" state is what renders them.
 */
function excludeForBill(billId: string, linkedIds: Set<string>, keys: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const activityId of linkedIds) {
    if (!keys.has(linkKey(billId, activityId))) out.add(activityId);
  }
  return out;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

/** Report through the host: a toast for the user, detail for the log. */
function reportError(userMessage: string, err: unknown): void {
  try {
    const { api } = getContext();
    api.logger.error(`[bills] ${userMessage} — ${describeError(err)}`);
    api.toast.error(userMessage);
  } catch {
    // Host channels unavailable (no context yet); nothing better to do than drop it.
  }
}

interface MonthGroup {
  key: string;    // "2026-02" — stable, locale- and timezone-independent
  label: string;  // "February 2026"
  items: Bill[];
  currencies: string[];
  byCurrency: Record<string, number>;
}

export function BillsPage() {
  const baseCurrency = useBaseCurrency();
  const [bills, setBills] = useState<Bill[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formInitial, setFormInitial] = useState<FormState>(() => ({ ...BLANK_FORM, currency: baseCurrency }));
  const [collapsedMonths, setCollapsedMonths] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(isHydrated);

  // Accounts
  const [accounts, setAccounts] = useState<{ id: string; name: string; isActive: boolean }[]>([]);
  const [accountIds, setAccountIds] = useState<string[]>([]);

  // Inline payment matching
  const [suggestions, setSuggestions] = useState<Record<string, TransactionMatch | null>>({});
  const [scanStatus, setScanStatus] = useState<Record<string, 'scanning' | 'done'>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [pickerBill, setPickerBill] = useState<Bill | null>(null);
  // Scan cache, keyed on scanSignature(bill) — see D3 note on that helper.
  const scannedRef = useRef<Set<string>>(new Set());
  // Bumped on every link write so the memoised link-key set below rebuilds.
  const [linkVersion, setLinkVersion] = useState(0);

  // Declared first so it is armed before any effect that resolves async work.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(() => setBills(getBills()), []);
  useEffect(() => { refresh(); }, [refresh]);

  /**
   * One parse of the links array per link write, instead of one per rendered
   * row: isLinked() re-reads and re-parses the links on every call.
   */
  const linkKeys = useMemo(() => getLinkKeys(), [linkVersion]);

  // Fetch active accounts once on mount
  useEffect(() => {
    getContext().api.accounts.getAll()
      .then((all: { id: string; name: string; isActive: boolean }[]) => {
        if (!mountedRef.current) return;
        const active = all.filter(a => a.isActive);
        setAccounts(active);
        setAccountIds(active.map(a => a.id));
      })
      .catch((err: unknown) => {
        // Silently failing here leaves matching permanently dead with no clue why.
        reportError("Couldn't load accounts, so payment matching is unavailable.", err);
      });
  }, []);

  /**
   * Auto-scan unpaid bills. ONE activity fetch for the union of accounts, then
   * a pure in-memory match per bill — N bills cost 1 request, not N × accounts.
   */
  useEffect(() => {
    if (accountIds.length === 0 || bills.length === 0) return;

    const pending = bills.filter(b => !b.paid && !scannedRef.current.has(scanSignature(b)));
    if (pending.length === 0) return;
    for (const bill of pending) scannedRef.current.add(scanSignature(bill));

    setScanStatus(prev => {
      const next = { ...prev };
      for (const bill of pending) next[bill.id] = 'scanning';
      return next;
    });
    // A re-scan means the bill changed, so it is a different question from the
    // one the user dismissed.
    setDismissed(prev => {
      if (!pending.some(b => prev.has(b.id))) return prev;
      const next = new Set(prev);
      for (const bill of pending) next.delete(bill.id);
      return next;
    });

    const settle = () => setScanStatus(prev => {
      const next = { ...prev };
      for (const bill of pending) next[bill.id] = 'done';
      return next;
    });

    // Not cancelled on re-render: bills changes on every save, and cancelling
    // would orphan bills whose signature is already marked as scanned. The
    // mounted guard is what keeps us from writing to a dead component.
    loadExpenseActivities(accountIds)
      .then((activities: ExpenseTx[]) => {
        if (!mountedRef.current) return;
        const linkedIds = getLinkedActivityIds();
        const keys = getLinkKeys();
        const found: Record<string, TransactionMatch | null> = {};
        for (const bill of pending) {
          // A bill pinned to an account filters the shared snapshot in memory;
          // fetching the narrower account set would be a second cache key and
          // therefore a second full download.
          const pool = bill.accountId
            ? activities.filter(a => a.accountId === bill.accountId)
            : activities;
          const target: MatchTarget = {
            name: bill.name,
            amount: bill.amount,
            currency: bill.currency,
            date: bill.date,   // without this, date proximity stays neutral
          };
          const top = matchAgainst(target, pool, {
            excludeActivityIds: excludeForBill(bill.id, linkedIds, keys),
            limit: 1,
          })[0];
          found[bill.id] = top && top.confidence >= MIN_SUGGEST_CONFIDENCE ? top : null;
        }
        setSuggestions(prev => ({ ...prev, ...found }));
        settle();
      })
      .catch((err: unknown) => {
        // Let a failed scan be retried rather than cached as "done forever".
        for (const bill of pending) scannedRef.current.delete(scanSignature(bill));
        if (!mountedRef.current) return;
        settle();
        reportError("Couldn't scan transactions for matching payments.", err);
      });
  }, [bills, accountIds, linkVersion]);

  const accountMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of accounts) map[a.id] = a.name;
    return map;
  }, [accounts]);

  const activeAccounts = useMemo(
    () => accounts.map(a => ({ id: a.id, name: a.name })),
    [accounts],
  );
  useEffect(() => {
    const onHydrated = () => { setReady(true); refresh(); };
    window.addEventListener("ss:storage-hydrated", onHydrated);
    return () => window.removeEventListener("ss:storage-hydrated", onHydrated);
  }, [refresh]);

  const openAdd = () => {
    if (!ready) return;
    setEditingId(null);
    setFormInitial({ ...BLANK_FORM, currency: baseCurrency, date: todayISO() });
    setShowForm(true);
  };

  const openEdit = (bill: Bill) => {
    setEditingId(bill.id);
    setFormInitial({
      name: bill.name,
      amount: String(bill.amount),
      currency: bill.currency,
      category: bill.category,
      date: bill.date,
      website: bill.website ?? "",
      notes: bill.notes ?? "",
      paid: bill.paid,
      recurring: bill.recurring,
      billingCycle: bill.billingCycle ?? "monthly",
      accountId: bill.accountId ?? "",
      logo: getLogo("bill", bill.id) ?? undefined,
    });
    setShowForm(true);
  };

  const handleSave = async (form: FormState) => {
    if (!ready) return;
    const id = editingId ?? generateId();
    saveBill({
      id,
      name: form.name.trim(),
      amount: parseFloat(form.amount) || 0,
      currency: form.currency,
      category: form.category,
      date: form.date,
      website: form.website.trim() || undefined,
      notes: form.notes.trim() || undefined,
      paid: form.paid,
      recurring: form.recurring,
      billingCycle: form.recurring ? form.billingCycle : undefined,
      accountId: form.accountId || undefined,
    });
    setShowForm(false);
    if (form.logo) {
      await saveLogo("bill", id, form.logo);
    } else {
      deleteLogo("bill", id);
    }
    refresh();
  };

  const handleDelete = (id: string) => {
    deleteBill(id);
    // Otherwise the links outlive the bill and keep its activities excluded
    // from every other bill's suggestions forever.
    removeLinksForEntity(id);
    setLinkVersion(v => v + 1);
    deleteLogo("bill", id);
    refresh();
    setShowForm(false);
  };

  const togglePaid = (bill: Bill) => {
    const markingPaid = !bill.paid;
    saveBill({ ...bill, paid: markingPaid });

    if (markingPaid && bill.recurring && bill.billingCycle) {
      const all = getBills();
      // advanceDateByCycle is UTC-safe and clamps to the month length
      // (31 Jan + 1 month = 28 Feb); anchorDay stops the series drifting.
      const nextDate = advanceDateByCycle(bill.date, bill.billingCycle, seriesAnchorDay(bill, all));
      // Name alone collides between two same-named bills in one cycle, so the
      // guard is the whole identity of the occurrence we are about to create.
      const alreadyExists = nextDate === "" || all.some(
        (b) => b.date === nextDate && !b.paid && isSameSeries(bill, b),
      );
      if (!alreadyExists) {
        saveBill({
          id: generateId(),
          name: bill.name,
          amount: bill.amount,
          currency: bill.currency,
          category: bill.category,
          date: nextDate,
          website: bill.website,
          notes: bill.notes,
          paid: false,
          recurring: true,
          billingCycle: bill.billingCycle,
          accountId: bill.accountId,
        });
      }
    }

    refresh();
  };

  const confirmPayment = (bill: Bill, match: TransactionMatch) => {
    saveLink({
      entityId: bill.id,
      entityType: 'bill',
      activityId: match.activityId,
      activityDate: match.activityDate,
      amount: match.amount,
      currency: match.currency,
      description: match.comment,
      accountName: match.accountName,
      linkedAt: new Date().toISOString(),
    });
    setLinkVersion(v => v + 1);

    // This activity is now spoken for. Any other bill still suggesting it must
    // drop it and re-scan with it excluded.
    const stale = Object.keys(suggestions).filter(
      (id) => id !== bill.id && suggestions[id]?.activityId === match.activityId,
    );
    if (stale.length > 0) {
      for (const id of stale) {
        const other = bills.find(b => b.id === id);
        if (other) scannedRef.current.delete(scanSignature(other));
      }
      setSuggestions(prev => {
        const next = { ...prev };
        for (const id of stale) next[id] = null;
        return next;
      });
    }

    togglePaid(bill);
  };

  const toggleMonth = (monthKeyValue: string) => {
    setCollapsedMonths((prev) => {
      const next = new Set(prev);
      next.has(monthKeyValue) ? next.delete(monthKeyValue) : next.add(monthKeyValue);
      return next;
    });
  };

  /**
   * Sort newest first, group by month, total each group. Grouping is keyed on
   * monthKey ("2026-02"), not on a localised label: `new Date("2026-02-01")`
   * parses as UTC midnight and renders in local time, so west of Greenwich a
   * bill dated the 1st landed in the previous month's group.
   */
  const grouped = useMemo<MonthGroup[]>(() => {
    const sorted = [...bills].sort((a, b) => b.date.localeCompare(a.date));
    const groups: MonthGroup[] = [];
    const byKey = new Map<string, MonthGroup>();
    for (const bill of sorted) {
      const key = monthKey(bill.date);
      let group = byKey.get(key);
      if (!group) {
        group = { key, label: formatMonthLabel(key), items: [], currencies: [], byCurrency: {} };
        byKey.set(key, group);
        groups.push(group);
      }
      group.items.push(bill);
      group.byCurrency[bill.currency] = (group.byCurrency[bill.currency] ?? 0) + bill.amount;
    }
    for (const group of groups) group.currencies = Object.keys(group.byCurrency);
    return groups;
  }, [bills]);

  // Current month banner stats. todayISO() only changes at midnight; a remount
  // picks that up, which is what the previous render-time call did too.
  const currentMonth = useMemo(() => {
    const items = grouped.find((g) => g.key === monthKey(todayISO()))?.items ?? [];
    return {
      items,
      unpaidCount: items.filter((b) => !b.paid).length,
      byCurrency: items.reduce<Record<string, number>>((acc, b) => {
        acc[b.currency] = (acc[b.currency] ?? 0) + b.amount;
        return acc;
      }, {}),
    };
  }, [grouped]);
  const currentMonthBills = currentMonth.items;
  const unpaidCount = currentMonth.unpaidCount;
  const currentByCurrency = currentMonth.byCurrency;
  const currentCurrencies = Object.keys(currentByCurrency);

  return (
    <PageLayout activePath={CURRENT_PATH}>
      <div className="px-4 py-4 flex flex-col gap-3 max-w-2xl">

        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-base font-semibold text-foreground">Bills</h1>
          <button
            onClick={openAdd}
            disabled={!ready}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary text-primary-foreground disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </button>
        </div>

        {/* This month banner */}
        {currentMonthBills.length > 0 && (
          <div className="bg-card border border-border rounded-xl p-6">
            <div className="flex items-center gap-6">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">This month</span>
                {currentCurrencies.length === 1 ? (
                  <span className="text-4xl font-bold text-foreground tabular-nums">
                    {formatCurrency(currentByCurrency[currentCurrencies[0]], currentCurrencies[0])}
                  </span>
                ) : (
                  <div className="flex flex-wrap gap-3">
                    {currentCurrencies.map((cur) => (
                      <span key={cur} className="text-2xl font-bold text-foreground tabular-nums">
                        {formatCurrency(currentByCurrency[cur], cur)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="w-px bg-border self-stretch" />
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Unpaid</span>
                <span className="text-xl font-semibold text-foreground tabular-nums">
                  {unpaidCount} bill{unpaidCount !== 1 ? "s" : ""}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Empty state */}
        {bills.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
            <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center">
              <Zap className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">{ready ? "No bills yet." : "Loading…"}</p>
            <button
              onClick={openAdd}
              disabled={!ready}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold mt-1 bg-primary text-primary-foreground disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
              Add your first bill
            </button>
          </div>
        )}

        {/* Grouped list */}
        {grouped.map(({ key, label, items, currencies: monthCurrencies, byCurrency: monthByCurrency }) => {
          // Collapsed state is keyed on the month key, not its localised label.
          const isOpen = !collapsedMonths.has(key);

          return (
            <div key={key} className="flex flex-col gap-1.5">
              {/* Month header */}
              <button
                onClick={() => toggleMonth(key)}
                className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors py-1 select-none w-full"
              >
                <ChevronDown
                  className="h-3.5 w-3.5 transition-transform duration-200"
                  style={{ transform: isOpen ? "rotate(0deg)" : "rotate(-90deg)" }}
                />
                <span>{label}</span>
                <span className="flex-1" />
                <span className="tabular-nums">
                  {monthCurrencies.map((cur) => formatCurrency(monthByCurrency[cur], cur)).join(" + ")}
                </span>
              </button>

              {/* Animated rows */}
              <div
                className="grid transition-all duration-200"
                style={{ gridTemplateRows: isOpen ? "1fr" : "0fr" }}
              >
                <div className="overflow-hidden">
                  <div className="flex flex-col gap-1.5">
                    {items.map((bill) => {
                      const colors = BILL_CATEGORY_COLORS[bill.category];
                      const suggestion = suggestions[bill.id];
                      const scanSt = scanStatus[bill.id];
                      const bannerShown = !bill.paid
                        && suggestion != null
                        && !dismissed.has(bill.id)
                        // Set lookup against the memoised keys — no re-parse
                        // read or JSON.parse per row, per render.
                        && !linkKeys.has(linkKey(bill.id, suggestion.activityId));
                      const showSpinner = !bill.paid && scanSt === 'scanning';
                      const showSearchBtn = !bill.paid && !showSpinner && !bannerShown;

                      return (
                        <div
                          key={bill.id}
                          className={`bg-card border border-border rounded-xl overflow-hidden transition-opacity ${bill.paid ? "opacity-50" : ""}`}
                        >
                          {/* Main row */}
                          <div className="px-3 py-2.5 flex items-center gap-3">
                            {/* Logo / category avatar */}
                            <LogoAvatar id={bill.id} kind="bill" name={bill.name} colors={colors} />

                            {/* Name + badges + date */}
                            <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-sm font-medium text-foreground truncate">{bill.name}</span>
                                <span
                                  className="text-xs px-2 py-0.5 rounded-full font-medium shrink-0"
                                  style={{ backgroundColor: colors.bg, color: colors.color }}
                                >
                                  {bill.category}
                                </span>
                                {bill.recurring && (
                                  <span className="flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded-full font-medium shrink-0 bg-muted text-muted-foreground">
                                    <RefreshCw className="h-2.5 w-2.5" />
                                    {bill.billingCycle}
                                  </span>
                                )}
                                {bill.accountId && accountMap[bill.accountId] && (
                                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground shrink-0">
                                    {accountMap[bill.accountId]}
                                  </span>
                                )}
                              </div>
                              <span className="text-xs text-muted-foreground">
                                {formatDayLabel(bill.date)}
                              </span>
                            </div>

                            {/* Amount */}
                            <span className="text-sm font-semibold text-foreground tabular-nums shrink-0">
                              {formatCurrency(bill.amount, bill.currency)}
                            </span>

                            {/* Paid toggle */}
                            <button
                              onClick={() => togglePaid(bill)}
                              title={bill.paid ? "Mark unpaid" : "Mark paid"}
                              className={`w-7 h-3.5 rounded-full transition-colors shrink-0 relative ${bill.paid ? "bg-primary" : "bg-muted"}`}
                            >
                              <span
                                className="absolute top-0.5 w-2.5 h-2.5 bg-white rounded-full shadow transition-all"
                                style={{ left: bill.paid ? "calc(100% - 12px)" : "2px" }}
                              />
                            </button>

                            {/* Scan spinner / 🔍 search button */}
                            {showSpinner && (
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />
                            )}
                            {showSearchBtn && (
                              <button
                                onClick={() => setPickerBill(bill)}
                                title="Find matching transaction"
                                className="text-muted-foreground hover:text-foreground transition-colors shrink-0 p-1 rounded-lg hover:bg-muted"
                              >
                                <Search className="h-3.5 w-3.5" />
                              </button>
                            )}

                            {/* Edit */}
                            <button
                              onClick={() => openEdit(bill)}
                              className="text-muted-foreground hover:text-foreground transition-colors shrink-0 p-1 rounded-lg hover:bg-muted"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          </div>

                          {/* Suggestion banner */}
                          {bannerShown && suggestion && (
                            <div className="flex items-center gap-2 px-3 py-2 bg-primary/5 border-t border-primary/20 text-xs">
                              <Link2 className="h-3 w-3 text-primary shrink-0" />
                              <span className="flex-1 truncate text-foreground">
                                <span className="font-medium">{suggestion.comment || '—'}</span>
                                <span className="text-muted-foreground">
                                  {" · "}{suggestion.activityDate}{" · "}{formatCurrency(suggestion.amount, suggestion.currency)}
                                </span>
                              </span>
                              <button
                                onClick={() => confirmPayment(bill, suggestion)}
                                className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-md font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
                              >
                                ✓ Confirm
                              </button>
                              <button
                                onClick={() => setPickerBill(bill)}
                                title="Show all matches"
                                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors px-1"
                              >
                                ▾
                              </button>
                              <button
                                onClick={() => setDismissed(prev => new Set([...prev, bill.id]))}
                                title="Dismiss"
                                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {showForm && (
        <BillForm
          initial={formInitial}
          editingId={editingId}
          accounts={activeAccounts}
          onSave={handleSave}
          onDelete={handleDelete}
          onClose={() => setShowForm(false)}
        />
      )}

      {/* The picker still fetches its own activities. Once it accepts a
          pre-loaded snapshot, hand it the one this page already cached — for an
          account-pinned bill the narrower accountIds below is a different cache
          key, so it costs one extra download today. */}
      {pickerBill && (
        <TransactionPickerModal
          entityName={pickerBill.name}
          entityAmount={pickerBill.amount}
          entityCurrency={pickerBill.currency}
          accountIds={pickerBill.accountId ? [pickerBill.accountId] : accountIds}
          onSelect={(match) => {
            confirmPayment(pickerBill, match);
            setPickerBill(null);
          }}
          onClose={() => setPickerBill(null)}
        />
      )}
    </PageLayout>
  );
}
