import { useState, useEffect, useCallback, useRef } from "react";
import { Search, Link2, ChevronDown, ChevronUp, Loader2, Unlink, AlertCircle } from "lucide-react";
import { PageLayout } from "../components/PageLayout";
import {
  getSubscriptions,
  formatCurrency,
  formatFullDate,
  describeError,
  type Subscription,
} from "../lib/storage";
import {
  loadExpenseActivities,
  matchAgainst,
  type ExpenseTx,
  type TransactionMatch,
} from "../lib/linker";
import {
  saveLink,
  removeLink,
  getLinksForEntity,
  getLinkedActivityIds,
  getLinkKeys,
  linkKey,
  confidenceColor,
  type LinkedTransaction,
} from "../lib/linker-storage";
import { getContext } from "../context";

interface MatchState {
  loading: boolean;
  done: boolean;
  matches: TransactionMatch[];
  error?: string;
}

/**
 * Accounts are fetched once on mount. "loaded but empty" and "still loading"
 * look identical if all we track is accountIds.length, which is what used to
 * leave a permanent "Loading accounts…" spinner in front of anyone without an
 * active account.
 */
type AccountsStatus = "loading" | "ready" | "error";

/**
 * Activities linked to a *different* bill or subscription must not be offered
 * again, but the ones linked to *this* subscription have to stay in the list —
 * they are what renders the "Unlink" state. Built once per subscription from
 * two storage reads shared across the whole scan, never per candidate.
 */
function exclusionsForEntity(
  entityId: string,
  allLinkedIds: Set<string>,
  allLinkKeys: Set<string>,
): Set<string> {
  const exclude = new Set<string>();
  for (const activityId of allLinkedIds) {
    if (!allLinkKeys.has(linkKey(entityId, activityId))) exclude.add(activityId);
  }
  return exclude;
}

/**
 * Score one subscription against an already-loaded activity snapshot.
 * matchAgainst() is pure and synchronous, so this does no IO at all.
 */
function computeMatches(
  sub: Subscription,
  activities: ExpenseTx[],
  exclude: Set<string>,
): TransactionMatch[] {
  return matchAgainst(
    // No `date` on purpose: a subscription recurs, so every historical charge
    // is a legitimate match and there is no single date to be close to. The lib
    // scores a missing target date as a neutral 0.5. Do NOT "fix" this by
    // passing nextBillingDate — it would penalise older charges of the very
    // same subscription for no reason.
    { name: sub.name, amount: sub.amount, currency: sub.currency },
    activities,
    { excludeActivityIds: exclude },
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = confidenceColor(value);
  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-xs tabular-nums" style={{ color }}>{pct}%</span>
    </div>
  );
}

interface MatchRowProps {
  match: TransactionMatch;
  onToggle: (match: TransactionMatch, linked: boolean) => void;
  linked: boolean;
}

function MatchRow({ match, onToggle, linked }: MatchRowProps) {
  const dateLabel = formatFullDate(match.activityDate);
  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-muted/50 transition-colors text-sm">
      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
        <span className="truncate text-foreground font-medium">{match.comment || "—"}</span>
        <span className="text-xs text-muted-foreground">
          {/* An unparseable date must not leave a dangling separator behind. */}
          {[dateLabel, match.accountName].filter(Boolean).join(" · ")}
        </span>
      </div>
      <span className="shrink-0 tabular-nums text-foreground">{formatCurrency(match.amount, match.currency)}</span>
      <ConfidenceBar value={match.confidence} />
      <button
        onClick={() => onToggle(match, linked)}
        title={linked ? "Unlink" : "Link this transaction"}
        className={`shrink-0 flex items-center gap-1 text-xs px-2.5 py-1 rounded-md font-medium transition-colors ${
          linked
            ? "bg-primary/10 text-primary hover:bg-destructive/10 hover:text-destructive"
            : "bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary"
        }`}
      >
        {linked ? <Unlink className="h-3 w-3" /> : <Link2 className="h-3 w-3" />}
        {linked ? "Unlink" : "Link"}
      </button>
    </div>
  );
}

interface SubCardProps {
  sub: Subscription;
  matchState: MatchState | undefined;
  onScan: (sub: Subscription) => void;
  onToggleLink: (subId: string, match: TransactionMatch, linked: boolean) => void;
  linkSet: Set<string>;
}

function SubCard({ sub, matchState, onScan, onToggleLink, linkSet }: SubCardProps) {
  const [open, setOpen] = useState(false);
  const linkedCount = matchState?.matches.filter(m => linkSet.has(m.activityId)).length ?? 0;
  const totalCount = matchState?.matches.length ?? 0;

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => {
          if (!matchState?.done) onScan(sub);
          setOpen(o => !o);
        }}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm text-foreground truncate">{sub.name}</span>
            {linkedCount > 0 && (
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                {linkedCount} linked
              </span>
            )}
          </div>
          <span className="text-xs text-muted-foreground">
            {formatCurrency(sub.amount, sub.currency)} · {sub.billingCycle}
          </span>
        </div>
        {matchState?.loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : matchState?.done ? (
          <span className="text-xs text-muted-foreground shrink-0">{totalCount} match{totalCount !== 1 ? "es" : ""}</span>
        ) : (
          <span className="text-xs text-primary shrink-0">Scan</span>
        )}
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
      </div>

      {open && matchState && (
        <div className="border-t border-border bg-muted/20 px-3 py-2">
          {matchState.loading && (
            <div className="flex items-center gap-2 py-4 justify-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Scanning transactions…
            </div>
          )}
          {matchState.error && (
            <div className="flex items-center gap-2 py-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" /> {matchState.error}
            </div>
          )}
          {matchState.done && !matchState.loading && matchState.matches.length === 0 && (
            <p className="text-sm text-muted-foreground py-3 text-center">
              No matching transactions found. Check if the name and amount match your bank data.
            </p>
          )}
          {matchState.done && matchState.matches.map(m => (
            <MatchRow
              key={m.activityId}
              match={m}
              linked={linkSet.has(m.activityId)}
              onToggle={(match, linked) => onToggleLink(sub.id, match, linked)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const SCAN_ERROR_COPY = "Couldn't load your transactions. Check Wealthfolio and try again.";

export function SuggestionsPage() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [accountsStatus, setAccountsStatus] = useState<AccountsStatus>("loading");
  const [matchStates, setMatchStates] = useState<Record<string, MatchState>>({});
  const [linkSets, setLinkSets] = useState<Record<string, Set<string>>>({});
  const [scanning, setScanning] = useState(false);
  // Fetches outlive the page (navigating away mid-scan is normal), so every
  // setState reached from a promise callback is gated on this.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const subs = getSubscriptions().filter(s => s.active);
    setSubscriptions(subs);

    // Init linkSets from stored links
    const initial: Record<string, Set<string>> = {};
    for (const sub of subs) {
      const links = getLinksForEntity(sub.id);
      initial[sub.id] = new Set(links.map(l => l.activityId));
    }
    setLinkSets(initial);

    const ctx = getContext();
    ctx.api.accounts.getAll()
      .then(accounts => {
        if (!mounted.current) return;
        setAccountIds(accounts.filter(a => a.isActive).map(a => a.id));
        setAccountsStatus("ready");
      })
      .catch(err => {
        // Log even when unmounted: the failure happened and is worth a trace.
        ctx.api.logger.error(`[bills-and-subscriptions] accounts.getAll failed: ${describeError(err)}`);
        if (!mounted.current) return;
        ctx.api.toast.error("Couldn't load your accounts, so transactions can't be matched.");
        setAccountsStatus("error");
      });

    return () => { mounted.current = false; };
  }, []);

  const scanSub = useCallback(async (sub: Subscription) => {
    setMatchStates(prev => ({ ...prev, [sub.id]: { loading: true, done: false, matches: [] } }));
    try {
      // The lib caches per account set, so once anything has loaded this is a
      // cache hit plus one in-memory pass — the per-card "Scan" is instant.
      const activities = await loadExpenseActivities(accountIds);
      if (!mounted.current) return;
      const exclude = exclusionsForEntity(sub.id, getLinkedActivityIds(), getLinkKeys());
      const matches = computeMatches(sub, activities, exclude);
      setMatchStates(prev => ({ ...prev, [sub.id]: { loading: false, done: true, matches } }));
    } catch (err) {
      getContext().api.logger.error(
        `[bills-and-subscriptions] scan failed for "${sub.name}": ${describeError(err)}`,
      );
      if (!mounted.current) return;
      // The card shows the failure; the cause went to the host log above.
      setMatchStates(prev => ({
        ...prev,
        [sub.id]: { loading: false, done: true, matches: [], error: SCAN_ERROR_COPY },
      }));
    }
  }, [accountIds]);

  const scanAll = useCallback(async () => {
    if (subscriptions.length === 0) return;
    setScanning(true);
    setMatchStates(prev => {
      const next = { ...prev };
      for (const sub of subscriptions) next[sub.id] = { loading: true, done: false, matches: [] };
      return next;
    });
    try {
      // ONE fetch for the whole page: history is loaded once here, then each
      // subscription is scored against that snapshot in memory. This used to be
      // N sequential full-history fetches (await per subscription in a loop).
      const activities = await loadExpenseActivities(accountIds);
      if (!mounted.current) return;
      // Link bookkeeping is read once for the whole pass too, not per candidate.
      const allLinkedIds = getLinkedActivityIds();
      const allLinkKeys = getLinkKeys();
      const next: Record<string, MatchState> = {};
      for (const sub of subscriptions) {
        const exclude = exclusionsForEntity(sub.id, allLinkedIds, allLinkKeys);
        next[sub.id] = { loading: false, done: true, matches: computeMatches(sub, activities, exclude) };
      }
      setMatchStates(prev => ({ ...prev, ...next }));
    } catch (err) {
      const ctx = getContext();
      ctx.api.logger.error(`[bills-and-subscriptions] Scan All failed: ${describeError(err)}`);
      if (!mounted.current) return;
      // Cards can be collapsed, so this one needs to reach the user directly.
      ctx.api.toast.error(SCAN_ERROR_COPY);
      setMatchStates(prev => {
        const next = { ...prev };
        for (const sub of subscriptions) {
          next[sub.id] = { loading: false, done: true, matches: [], error: SCAN_ERROR_COPY };
        }
        return next;
      });
    } finally {
      if (mounted.current) setScanning(false);
    }
  }, [subscriptions, accountIds]);

  const handleToggleLink = useCallback((subId: string, match: TransactionMatch, currentlyLinked: boolean) => {
    if (currentlyLinked) {
      removeLink(subId, match.activityId);
      setLinkSets(prev => {
        const next = new Set(prev[subId] ?? []);
        next.delete(match.activityId);
        return { ...prev, [subId]: next };
      });
    } else {
      const link: LinkedTransaction = {
        entityId: subId,
        entityType: "subscription",
        activityId: match.activityId,
        activityDate: match.activityDate,
        amount: match.amount,
        currency: match.currency,
        description: match.comment,
        accountName: match.accountName,
        linkedAt: new Date().toISOString(),
      };
      saveLink(link);
      setLinkSets(prev => {
        const next = new Set(prev[subId] ?? []);
        next.add(match.activityId);
        return { ...prev, [subId]: next };
      });
    }
  }, []);

  const canScan = accountsStatus === "ready" && accountIds.length > 0;

  return (
    <PageLayout activePath="/addons/bills-and-subscriptions/suggestions">
      <div className="p-4 flex flex-col gap-4">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold text-foreground">Transaction Suggestions</span>
            <span className="text-xs text-muted-foreground">
              Match subscriptions to their real Wealthfolio transactions
            </span>
          </div>
          <button
            onClick={scanAll}
            disabled={scanning || !canScan}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {scanning
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Search className="h-3.5 w-3.5" />}
            {scanning ? "Scanning…" : "Scan All"}
          </button>
        </div>

        {accountsStatus === "loading" && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/40 rounded-lg px-3 py-2.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading accounts…
          </div>
        )}

        {accountsStatus === "ready" && accountIds.length === 0 && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/40 rounded-lg px-3 py-2.5">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            No active accounts. Add or re-activate an account in Wealthfolio to match transactions.
          </div>
        )}

        {accountsStatus === "error" && (
          <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2.5">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            Couldn't load your accounts. Reload the page to try again.
          </div>
        )}

        {subscriptions.length === 0 ? (
          <div className="text-center py-12 text-sm text-muted-foreground">
            No active subscriptions yet. Add some in the Subscriptions tab first.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {subscriptions.map(sub => (
              <SubCard
                key={sub.id}
                sub={sub}
                matchState={matchStates[sub.id]}
                onScan={scanSub}
                onToggleLink={handleToggleLink}
                linkSet={linkSets[sub.id] ?? new Set()}
              />
            ))}
          </div>
        )}

      </div>
    </PageLayout>
  );
}
