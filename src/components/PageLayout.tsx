import { useRef, useEffect, useState, useCallback } from "react";
import {
  CreditCard, BarChart2, Receipt, Settings, X, RefreshCw, Search, Link2,
  Download, Upload, AlertTriangle,
} from "lucide-react";
import { getContext } from "../context";
import {
  exportData,
  getSettings,
  getSyncLogCount,
  importData,
  saveSettings,
  setStorageErrorHandler,
  todayISO,
  type AddonSettings,
  type ImportSummary,
} from "../lib/storage";
import { syncAll, type SyncResult } from "../lib/sync";
import type { Account } from "@wealthfolio/addon-sdk";
import type { ChangeEvent, ReactNode } from "react";

interface Tab {
  label: string;
  path: string;
  icon: ReactNode;
  settingKey?: keyof AddonSettings;
}

const ALL_TABS: Tab[] = [
  { label: "Summary",       path: "/addons/bills-and-subscriptions/summary",      icon: <BarChart2  className="h-3.5 w-3.5" /> },
  { label: "Subscriptions", path: "/addons/bills-and-subscriptions",              icon: <CreditCard className="h-3.5 w-3.5" /> },
  { label: "Bills",         path: "/addons/bills-and-subscriptions/bills",        icon: <Receipt    className="h-3.5 w-3.5" />, settingKey: "billsEnabled" },
  { label: "Suggestions",   path: "/addons/bills-and-subscriptions/suggestions",  icon: <Search     className="h-3.5 w-3.5" /> },
  { label: "Links",         path: "/addons/bills-and-subscriptions/links",        icon: <Link2      className="h-3.5 w-3.5" /> },
];

const LOG_PREFIX = "[bills-and-subscriptions]";

/** Turn anything throwable into one short line for a toast or a log entry. */
function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err.trim();
  return "unexpected error";
}

/**
 * One compact line describing a finished sync.
 *
 * "Already up to date" is reserved for a run that genuinely had nothing to do:
 * `skipped` is always reported, because an entity is now skipped for real,
 * fixable reasons (no start date, invalid date, no account) and reading that as
 * "up to date" hid the problem.
 */
function summariseSync(result: SyncResult): string {
  const parts: string[] = [];
  if (result.synced > 0) parts.push(`+${result.synced} new`);
  if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
  if (result.failed > 0) parts.push(`${result.failed} failed`);
  if (parts.length === 0) return "Already up to date";
  if (result.synced === 0) parts.unshift("Nothing new");
  return parts.join(" · ");
}

interface PendingImport {
  fileName: string;
  json: string;
}

interface StatusMessage {
  kind: "ok" | "error";
  text: string;
}

interface PageLayoutProps {
  children: ReactNode;
  activePath: string;
}

export function PageLayout({ children, activePath }: PageLayoutProps) {
  const ctx = getContext();
  const navRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });
  const [animated, setAnimated] = useState(false);
  const [settings, setSettings] = useState<AddonSettings>(getSettings);
  const [showSettings, setShowSettings] = useState(false);

  // Sync state
  const [accounts, setAccounts] = useState<Account[]>([]);
  /** Active accounts that exist but are not typed CASH — used to explain an
   *  empty dropdown instead of leaving the user to guess. */
  const [otherActiveCount, setOtherActiveCount] = useState(0);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsFailed, setAccountsFailed] = useState(false);
  const [syncRunning, setSyncRunning] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [syncTotal, setSyncTotal] = useState(getSyncLogCount);

  // Backup / restore state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [backupStatus, setBackupStatus] = useState<StatusMessage | null>(null);

  /** Pending tab navigation, so an unmount inside the 200ms window cancels it. */
  const navTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tabs = ALL_TABS.filter(
    (t) => !t.settingKey || settings[t.settingKey]
  );
  /** Identity of the *visible* tab set — the indicator has to be re-measured
   *  whenever this changes, not only when activePath does. */
  const tabKey = tabs.map((t) => t.path).join("|");

  // Storage failures are otherwise completely silent: a write that hits
  // QuotaExceededError looks saved and is gone. PageLayout wraps every page, so
  // registering here covers the whole addon exactly once.
  useEffect(() => {
    setStorageErrorHandler((err, key) => {
      ctx.api.toast.error(
        "Couldn't save your changes — this app's local storage is full. Export a backup, then delete a few old bills or subscriptions to free up space.",
      );
      ctx.api.logger.error(`${LOG_PREFIX} storage write failed for "${key}": ${errorMessage(err)}`);
    });
    // Unregister on cleanup so a remounted layout does not stack handlers (and
    // does not leave one bound to a stale ctx).
    return () => setStorageErrorHandler(null);
  }, [ctx]);

  // Load cash accounts when settings opens.
  useEffect(() => {
    if (!showSettings) return;
    setSyncResult(null);
    setSyncTotal(getSyncLogCount());
    setAccountsLoading(true);
    setAccountsFailed(false);

    // Closing the modal mid-fetch must not write to a dead component.
    let mounted = true;
    ctx.api.accounts.getAll()
      .then((all) => {
        if (!mounted) return;
        const active = all.filter((a) => a.isActive);
        const cash = active.filter((a) => a.accountType === "CASH");
        setAccounts(cash);
        setOtherActiveCount(active.length - cash.length);
      })
      .catch((err: unknown) => {
        // Was swallowed into an empty dropdown, which reads as "no accounts".
        ctx.api.toast.error("Couldn't load your accounts. Close Settings and try again.");
        ctx.api.logger.error(`${LOG_PREFIX} accounts.getAll failed: ${errorMessage(err)}`);
        if (!mounted) return;
        setAccounts([]);
        setOtherActiveCount(0);
        setAccountsFailed(true);
      })
      .finally(() => {
        if (mounted) setAccountsLoading(false);
      });

    return () => { mounted = false; };
  }, [showSettings, ctx]);

  // Cancel a queued navigation if we unmount before it fires.
  useEffect(() => {
    return () => {
      if (navTimer.current !== null) clearTimeout(navTimer.current);
    };
  }, []);

  useEffect(() => {
    const onHydrated = () => {
      setSettings(getSettings());
      setSyncTotal(getSyncLogCount());
    };
    window.addEventListener("ss:storage-hydrated", onHydrated);
    return () => window.removeEventListener("ss:storage-hydrated", onHydrated);
  }, []);

  const measureTab = useCallback((path: string) => {
    const container = navRef.current;
    if (!container) return null;
    const btn = container.querySelector<HTMLElement>(`[data-path="${path}"]`);
    if (!btn) return null;
    return { left: btn.offsetLeft, width: btn.offsetWidth };
  }, []);

  useEffect(() => {
    const pos = measureTab(activePath);
    if (!pos) return;
    setAnimated(false);
    setIndicator(pos);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setAnimated(true));
    });
    // tabKey: toggling Bills adds/removes a tab, which moves every tab after it.
  }, [activePath, tabKey, measureTab]);

  const handleTabClick = (tab: Tab) => {
    if (tab.path === activePath) return;
    const pos = measureTab(tab.path);
    if (pos) setIndicator(pos);
    if (navTimer.current !== null) clearTimeout(navTimer.current);
    navTimer.current = setTimeout(() => {
      navTimer.current = null;
      ctx.api.navigation.navigate(tab.path);
    }, 200);
  };

  const handleToggleSetting = (key: keyof AddonSettings) => {
    const next = { ...settings, [key]: !settings[key] };
    saveSettings(next);
    setSettings(next);

    if (key === "billsEnabled" && !next.billsEnabled && activePath === "/addons/bills-and-subscriptions/bills") {
      ctx.api.navigation.navigate("/addons/bills-and-subscriptions/summary");
    }
  };

  const handleSyncAccountChange = (accountId: string) => {
    const next = { ...settings, syncAccountId: accountId || null };
    saveSettings(next);
    setSettings(next);
    setSyncResult(null);
  };

  const handleSyncNow = async () => {
    if (!settings.syncAccountId || syncRunning) return;
    setSyncRunning(true);
    setSyncResult(null);
    try {
      const result = await syncAll(settings.syncAccountId);
      setSyncResult(result);
      setSyncTotal(getSyncLogCount());
    } catch (err) {
      // syncAll() is documented never to reject. Belt and braces: if that ever
      // regresses, the user gets a toast instead of a silent unhandled rejection.
      const message = errorMessage(err);
      ctx.api.toast.error(`Sync failed: ${message}`);
      ctx.api.logger.error(`${LOG_PREFIX} syncAll threw: ${message}`);
    } finally {
      setSyncRunning(false);
    }
  };

  const handleExport = async () => {
    setBackupStatus(null);
    try {
      // openSaveDialog resolves `unknown` and gives no way to tell "saved" from
      // "cancelled", so we deliberately do not claim success afterwards.
      await ctx.api.files.openSaveDialog(
        exportData(),
        `subscriptions-and-bills-${todayISO()}.json`,
      );
    } catch (err) {
      const message = errorMessage(err);
      ctx.api.toast.error(`Couldn't save the backup: ${message}`);
      ctx.api.logger.error(`${LOG_PREFIX} export failed: ${message}`);
    }
  };

  const handleFileChosen = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset immediately so picking the same file twice still fires onChange.
    e.target.value = "";
    if (!file) return;
    setBackupStatus(null);
    setPendingImport(null);
    try {
      // Read here, confirm later: if the file is unreadable the user finds out
      // before being asked to approve a destructive replace.
      const json = await file.text();
      setPendingImport({ fileName: file.name, json });
    } catch (err) {
      const message = errorMessage(err);
      setBackupStatus({ kind: "error", text: `Couldn't read that file: ${message}` });
      ctx.api.logger.error(`${LOG_PREFIX} could not read import file: ${message}`);
    }
  };

  const handleConfirmImport = () => {
    if (!pendingImport) return;
    try {
      const summary: ImportSummary = importData(pendingImport.json);
      setPendingImport(null);
      // importData may have replaced settings too, so re-read rather than trust
      // the copy in state (billsEnabled drives the tab set).
      setSettings(getSettings());
      setSyncTotal(getSyncLogCount());
      setSyncResult(null);
      setBackupStatus({
        kind: "ok",
        text: `Restored ${summary.subscriptions} subscription(s), ${summary.bills} bill(s) and ${summary.links} link(s). Switch tabs to reload them.`,
      });
      ctx.api.toast.success("Backup restored.");
    } catch (err) {
      // importData throws a short, user-facing message — show it as-is.
      setBackupStatus({ kind: "error", text: errorMessage(err) });
    }
  };

  return (
    <div className="bills-and-subscriptions-root flex flex-col min-h-screen bg-background text-foreground">

      {/* Header */}
      <div className="px-4 pt-4 pb-3 flex flex-col gap-3 border-b border-border">

        {/* Title */}
        <span className="text-xl font-bold text-foreground tracking-tight">
          Subscriptions & Bills
        </span>

        {/* Pill nav + gear */}
        <div className="flex items-center gap-2 self-start">
        <div
          ref={navRef}
          className="relative inline-flex items-center rounded-full p-1 bg-muted"
        >
          <span
            className="absolute top-1 bottom-1 rounded-full bg-background"
            style={{
              left: indicator.left,
              width: indicator.width,
              boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
              transition: animated
                ? "left 220ms cubic-bezier(0.4,0,0.2,1), width 220ms cubic-bezier(0.4,0,0.2,1)"
                : "none",
            }}
          />

          {tabs.map((tab) => {
            const isActive = activePath === tab.path;
            return (
              <button
                key={tab.path}
                data-path={tab.path}
                data-active={isActive}
                onClick={() => handleTabClick(tab)}
                className={`relative z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors duration-150 select-none ${
                  isActive
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            );
          })}
        </div>

        <button
          onClick={() => setShowSettings(true)}
          className="w-8 h-8 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
        </div>
      </div>

      {/* Page content */}
      <div className="flex-1 overflow-auto">
        {children}
      </div>

      {/* Settings modal */}
      {showSettings && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: "rgba(0,0,0,0.55)" }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowSettings(false); }}
        >
          {/* max-h + scroll: sync errors and the import confirmation can both
              add rows, and the modal must not grow past the viewport. */}
          <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm p-5 flex flex-col gap-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">Settings</h2>
              <button
                onClick={() => setShowSettings(false)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex flex-col gap-3">

              {/* Bills toggle */}
              <div className="flex items-center gap-4 py-2 border-b border-border">
                <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                  <span className="text-sm text-foreground">Bills tracking</span>
                  <span className="text-xs text-muted-foreground">Show the Bills tab and include bills in the summary</span>
                </div>
                <button
                  onClick={() => handleToggleSetting("billsEnabled")}
                  className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${
                    settings.billsEnabled ? "bg-primary" : "bg-muted"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-5 h-5 rounded-full bg-background shadow transition-[left] duration-200 ${
                      settings.billsEnabled ? "left-[18px]" : "left-0.5"
                    }`}
                  />
                </button>
              </div>

              {/* Wealthfolio Sync */}
              <div className="flex flex-col gap-3 py-2">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm text-foreground">Wealthfolio Sync</span>
                  <span className="text-xs text-muted-foreground">
                    Push subscription charges to a cash account as withdrawal transactions.
                    {syncTotal > 0 && ` ${syncTotal} charges synced so far.`}
                  </span>
                </div>

                <select
                  value={settings.syncAccountId ?? ""}
                  onChange={(e) => handleSyncAccountChange(e.target.value)}
                  className="text-xs rounded-lg border border-border bg-background px-2.5 py-1.5 text-foreground w-full"
                >
                  <option value="">— disabled —</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.currency})
                    </option>
                  ))}
                </select>

                {/* An empty dropdown used to look like a broken feature. */}
                {!accountsLoading && !accountsFailed && accounts.length === 0 && (
                  <span className="text-xs text-muted-foreground">
                    {otherActiveCount > 0
                      ? `No cash accounts to sync to. ${otherActiveCount} other active account(s) exist, but sync only offers accounts of type “Cash”.`
                      : "No active cash accounts yet. Add one in Wealthfolio to enable sync."}
                  </span>
                )}
                {accountsFailed && (
                  <span className="text-xs text-muted-foreground">
                    Couldn't load your accounts. Reopen Settings to retry.
                  </span>
                )}

                {settings.syncAccountId && (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleSyncNow}
                      disabled={syncRunning}
                      className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
                    >
                      <RefreshCw className={`h-3 w-3 ${syncRunning ? "animate-spin" : ""}`} />
                      {syncRunning ? "Syncing…" : "Sync Now"}
                    </button>
                    {syncResult && (
                      <span className="text-xs text-muted-foreground">
                        {summariseSync(syncResult)}
                      </span>
                    )}
                  </div>
                )}

                {/* Why charges were skipped or rejected. Capped at 10 by the lib;
                    scrolls in place so it can never stretch the modal. */}
                {syncResult && syncResult.errors.length > 0 && (
                  <ul className="flex flex-col gap-1 rounded-lg border border-border bg-muted/40 px-2.5 py-2 max-h-28 overflow-y-auto">
                    {syncResult.errors.map((message, i) => (
                      <li key={i} className="text-xs text-muted-foreground leading-snug break-words">
                        {message}
                      </li>
                    ))}
                  </ul>
                )}

                {settings.syncAccountId && (
                  <span className="text-xs text-muted-foreground/60">
                    Subscriptions without a start date are skipped.
                  </span>
                )}
              </div>

              {/* Backup — an export is the only copy of this data that lives outside Wealthfolio. */}
              <div className="flex flex-col gap-2 py-2 border-t border-border">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm text-foreground">Backup</span>
                  <span className="text-xs text-muted-foreground">
                    Save everything to a file, or restore a previous backup.
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleExport}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-border text-foreground hover:bg-muted transition-colors"
                  >
                    <Download className="h-3 w-3" />
                    Export
                  </button>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-border text-foreground hover:bg-muted transition-colors"
                  >
                    <Upload className="h-3 w-3" />
                    Import…
                  </button>
                </div>

                {/* The host has no file-read API (files.openCsvDialog returns a
                    path, not contents), so the webview's own file input reads it. */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={handleFileChosen}
                />

                {/* Import replaces everything, so it never happens on one click. */}
                {pendingImport && (
                  <div className="flex flex-col gap-2 rounded-lg border border-red-400/40 bg-red-400/10 px-2.5 py-2">
                    <div className="flex items-start gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 text-red-400 shrink-0 mt-0.5" />
                      <span className="text-xs text-foreground leading-snug break-words">
                        Restoring <span className="font-medium">{pendingImport.fileName}</span> deletes
                        every subscription, bill, linked transaction and sync record stored here and
                        replaces them with the file's contents. This can't be undone.
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleConfirmImport}
                        className="text-xs px-3 py-1.5 rounded-lg bg-red-400 text-background hover:opacity-90 transition-opacity"
                      >
                        Replace all data
                      </button>
                      <button
                        onClick={() => setPendingImport(null)}
                        className="text-xs px-3 py-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {backupStatus && (
                  <span
                    className={`text-xs leading-snug break-words ${
                      backupStatus.kind === "error" ? "text-red-400" : "text-muted-foreground"
                    }`}
                  >
                    {backupStatus.text}
                  </span>
                )}
              </div>

            </div>
          </div>
        </div>
      )}
    </div>
  );
}
