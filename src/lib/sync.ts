// Wealthfolio Sync — pushes every subscription charge and bill occurrence into a
// Wealthfolio cash account as a WITHDRAWAL activity, so recurring spend shows up
// in the user's portfolio.
//
// Four invariants hold throughout this file:
//   1. syncAll() never rejects. Its only caller is a React click handler with
//      try/finally and no catch, so a rejection becomes an unhandled rejection
//      with zero user feedback. Everything is funnelled into SyncResult instead.
//   2. Writes are idempotent. "${entityKey}:${date}" -> activityId in the
//      ss:sync-log map is the dedup ledger. It is persisted right after every
//      successful chunk, so an interrupted sync never re-pushes what it wrote.
//   3. No date arithmetic lives here. Every occurrence series comes from
//      cycleSeries(), which is UTC-safe, drift-free, bounded and never throws.
//      Hand-rolled `new Date(str)` walks used to throw RangeError on a malformed
//      startDate and to drift Jan 31 -> Mar 3.
//   4. Every activity we create is stamped with metadata.source = ADDON_SOURCE
//      so the transaction matcher can exclude our own synthetic rows instead of
//      offering to link a bill to the row this addon wrote.

import { QueryKeys } from "@wealthfolio/addon-sdk";
import type {
  Activity,
  ActivityBulkMutationResult,
  ActivityCreate,
  AddonContext,
} from "@wealthfolio/addon-sdk";
import { getContext } from "../context";
import { invalidateActivityCache } from "./linker";
import {
  ADDON_SOURCE,
  cycleSeries,
  generateId,
  getBills,
  getSubscriptions,
  getSyncLog,
  isValidISODate,
  todayISO,
  updateSyncLog,
} from "./storage";
import type { Bill, Subscription } from "./storage";

// ─── Public contract ──────────────────────────────────────────────────────────

export interface SyncResult {
  synced: number;
  failed: number;
  skipped: number;
  /** Short, user-facing reasons. Capped — see MAX_ERRORS. */
  errors: string[];
}

// ─── Tuning ───────────────────────────────────────────────────────────────────

/**
 * Activities per saveMany() call.
 *
 * 100 is a deliberate middle ground:
 *   - It collapses the old one-IPC-per-charge behaviour: five years of a monthly
 *     subscription (60 charges) is now a single round-trip instead of 60.
 *   - A 100-activity payload is a few tens of KB — far below any practical IPC
 *     limit, and small enough that serialising it does not stall the UI thread.
 *   - It bounds the blast radius: if one chunk is rejected, at most 100 charges
 *     need a retry, and because the sync log is persisted per chunk the earlier
 *     chunks are never re-pushed.
 */
const CHUNK_SIZE = 100;

/** Hard ceiling on occurrences per entity, so a far-past (or absurd) start date
 *  can never generate an unbounded series. 1000 covers ~19 years weekly and
 *  ~83 years monthly. */
const MAX_OCCURRENCES = 1000;

/** The UI renders `errors` verbatim, so it must never be flooded. */
const MAX_ERRORS = 10;

/**
 * Caches invalidated after a successful write. Nothing invalidated these before,
 * so portfolio views kept showing pre-sync numbers until a manual refresh.
 * Keys come from the SDK's QueryKeys so they stay in step with the host.
 */
const INVALIDATE_AFTER_WRITE: string[] = [
  QueryKeys.ACTIVITY_DATA, // the activities table the user is most likely looking at
  QueryKeys.ACTIVITIES,
  QueryKeys.ACCOUNTS_SUMMARY, // each withdrawal moves the account's cash balance
  QueryKeys.HOLDINGS,
  QueryKeys.PORTFOLIO_SUMMARY,
  QueryKeys.INCOME_SUMMARY,
  QueryKeys.HISTORY_VALUATION, // valuation series is recomputed from activities
  QueryKeys.PERFORMANCE_SUMMARY,
  QueryKeys.PERFORMANCE_HISTORY,
];

// ─── Internal shapes ──────────────────────────────────────────────────────────

interface PendingCharge {
  /** Sync-log key. Unchanged from the pre-fix scheme so already-synced charges
   *  are not re-created: "${subId}:${date}" / "bill:${billId}:${date}". */
  key: string;
  /** Short "Name (date)" label used in user-facing error strings. */
  label: string;
  /** Client-side id submitted as ActivityCreate.id and echoed back as
   *  ActivityBulkIdentifierMapping.tempId. A UUID rather than the sync-log key,
   *  so it is still a sane primary key if the host adopts it verbatim. */
  tempId: string;
  accountId: string;
  create: ActivityCreate;
}

interface ChunkOutcome {
  /** Sync-log entries to persist: key -> activityId (may be "" — see below). */
  entries: Record<string, string>;
  failed: number;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Push every subscription charge and bill occurrence up to today into
 * Wealthfolio as WITHDRAWAL activities. Idempotent via the ss:sync-log map.
 * Never rejects: all failures surface in the returned SyncResult.
 * Each entity goes to its own accountId when set, else defaultAccountId.
 */
export async function syncAll(defaultAccountId: string): Promise<SyncResult> {
  const tally = { synced: 0, failed: 0, skipped: 0 };
  const errors: string[] = [];

  try {
    await run(defaultAccountId, tally, errors);
  } catch (err) {
    // Belt and braces: getContext(), storage and the collectors are all
    // meant to be safe, but a rejection here would reach the UI as nothing.
    errors.push(`Sync stopped: ${describe(err)}`);
  }

  return { ...tally, errors: capErrors(errors) };
}

async function run(
  defaultAccountId: string,
  tally: { synced: number; failed: number; skipped: number },
  errors: string[],
): Promise<void> {
  const ctx = getContext();
  const today = todayISO();
  const log = getSyncLog();
  const seen = new Set<string>(Object.keys(log));

  const pending: PendingCharge[] = [];
  collectSubscriptions(pending, seen, tally, errors, defaultAccountId, today);
  collectBills(pending, seen, tally, errors, defaultAccountId, today);

  if (pending.length === 0) return; // nothing to write, nothing to invalidate

  const touchedAccounts = new Set<string>();
  // Probed once: an older host simply has no saveMany, and we must not spend a
  // failed chunk to discover that.
  let bulkSupported = typeof ctx.api?.activities?.saveMany === "function";

  for (const chunk of chunks(pending, CHUNK_SIZE)) {
    let outcome: ChunkOutcome;

    if (bulkSupported) {
      try {
        outcome = interpretBulkResult(
          chunk,
          await ctx.api.activities.saveMany({
            creates: chunk.map((c) => ({ ...c.create, id: c.tempId })),
          }),
          errors,
        );
      } catch (err) {
        if (looksUnsupported(err)) {
          // Host doesn't implement bulk writes: degrade for the rest of the run.
          bulkSupported = false;
          outcome = await writeIndividually(ctx, chunk, errors);
        } else {
          // A rejected bulk call may still have partially committed. Retrying
          // these one-by-one could double-write real money into the portfolio,
          // so report and move on — the next sync picks up whatever is missing.
          tally.failed += chunk.length;
          errors.push(`Couldn't write ${chunk.length} charge(s): ${describe(err)}`);
          continue;
        }
      }
    } else {
      outcome = await writeIndividually(ctx, chunk, errors);
    }

    tally.failed += outcome.failed;

    const written = Object.keys(outcome.entries);
    if (written.length > 0) {
      // Persist per chunk: if a later chunk explodes, these are already deduped.
      updateSyncLog(outcome.entries);
      tally.synced += written.length;
      const byKey = new Map(chunk.map((c) => [c.key, c]));
      for (const key of written) {
        const account = byKey.get(key)?.accountId;
        if (account) touchedAccounts.add(account);
      }
    }
  }

  if (tally.synced > 0) {
    // The matcher caches the fetched activity list per account set. The rows we
    // just wrote are synthetic and must be excluded from suggestions, so a stale
    // snapshot would both miss them and let them be offered as real payments.
    invalidateActivityCache();
    invalidateCaches(ctx, touchedAccounts);
  }
}

// ─── Collecting charges ───────────────────────────────────────────────────────

function collectSubscriptions(
  out: PendingCharge[],
  seen: Set<string>,
  tally: { synced: number; failed: number; skipped: number },
  errors: string[],
  defaultAccountId: string,
  today: string,
): void {
  for (const sub of getSubscriptions()) {
    if (!sub.active) continue; // inactive subscriptions are not charges at all

    if (!sub.startDate) {
      tally.skipped++; // pre-existing behaviour: no start date, no series
      continue;
    }
    if (!isValidISODate(sub.startDate)) {
      // Used to throw RangeError deep inside the date walk and abort the sync.
      tally.skipped++;
      errors.push(`${label(sub.name)}: start date "${sub.startDate}" isn't a valid date`);
      continue;
    }

    const accountId = accountFor(sub, defaultAccountId);
    if (!accountId) {
      tally.skipped++;
      errors.push(`${label(sub.name)}: no account to sync to`);
      continue;
    }

    const dates = cycleSeries(sub.startDate, sub.billingCycle, today, MAX_OCCURRENCES);
    if (dates.length === MAX_OCCURRENCES) {
      errors.push(
        `${label(sub.name)}: stopped after ${MAX_OCCURRENCES} charges — check its start date`,
      );
    }

    for (const date of dates) {
      queue(out, seen, tally, `${sub.id}:${date}`, date, accountId, sub.name, sub.category, sub.amount, sub.currency);
    }
  }
}

function collectBills(
  out: PendingCharge[],
  seen: Set<string>,
  tally: { synced: number; failed: number; skipped: number },
  errors: string[],
  defaultAccountId: string,
  today: string,
): void {
  for (const bill of getBills()) {
    if (!isValidISODate(bill.date)) {
      tally.skipped++;
      errors.push(`${label(bill.name)}: date "${bill.date}" isn't a valid date`);
      continue;
    }
    if (bill.date > today) {
      tally.skipped++; // future bill: nothing has been paid yet
      continue;
    }

    const accountId = accountFor(bill, defaultAccountId);
    if (!accountId) {
      tally.skipped++;
      errors.push(`${label(bill.name)}: no account to sync to`);
      continue;
    }

    // A one-off bill is a single occurrence; recurring without a cycle is too.
    const dates =
      bill.recurring && bill.billingCycle
        ? cycleSeries(bill.date, bill.billingCycle, today, MAX_OCCURRENCES)
        : [bill.date];

    if (dates.length === MAX_OCCURRENCES) {
      errors.push(
        `${label(bill.name)}: stopped after ${MAX_OCCURRENCES} occurrences — check its date`,
      );
    }

    for (const date of dates) {
      queue(out, seen, tally, `bill:${bill.id}:${date}`, date, accountId, bill.name, bill.category, bill.amount, bill.currency);
    }
  }
}

/** Queue one occurrence unless the sync log (or this run) already has it. */
function queue(
  out: PendingCharge[],
  seen: Set<string>,
  tally: { synced: number; failed: number; skipped: number },
  key: string,
  date: string,
  accountId: string,
  name: string,
  category: string,
  amount: number,
  currency: string,
): void {
  if (seen.has(key)) {
    tally.skipped++;
    return;
  }
  seen.add(key);

  const tempId = generateId();
  out.push({
    key,
    label: `${label(name)} (${date})`,
    tempId,
    accountId,
    create: {
      accountId,
      activityType: "WITHDRAWAL",
      activityDate: date,
      amount,
      currency,
      comment: `${name} · ${category}`,
      // Passed as an object, not a JSON string: Activity.metadata and
      // ActivityDetails.metadata are both typed Record<string, unknown> on the
      // read side, so the host stores structured metadata and the `string` half
      // of ActivityCreate.metadata is the escape hatch for importers that carry
      // a raw JSON blob. An object round-trips as `metadata.source`, which is
      // exactly what the matcher reads.
      metadata: { source: ADDON_SOURCE, chargeKey: key },
    },
  });
}

/** Per-entity account wins; Settings' account is only the default. */
function accountFor(entity: Subscription | Bill, defaultAccountId: string): string {
  const id = entity.accountId ?? defaultAccountId;
  return typeof id === "string" ? id.trim() : "";
}

// ─── Writing ──────────────────────────────────────────────────────────────────

/**
 * Map a bulk result back onto the sync-log keys of the chunk we submitted.
 *
 * Hosts differ in what they echo back, so three strategies are tried, most
 * trustworthy first:
 *   1. metadata.chargeKey on the created Activity. Self-describing — immune to
 *      ordering and to partial failures. Works whenever metadata round-trips.
 *   2. createdMappings[].tempId, matched against the ActivityCreate.id we sent.
 *      This is what the mapping list exists for.
 *   3. Positional, and only in the unambiguous case: no errors, nothing already
 *      resolved, and exactly one created row per submitted create.
 *
 * Anything still unresolved is treated as written-with-unknown-id (recorded with
 * an empty activityId) when the host acknowledged creations, because pushing a
 * duplicate withdrawal on the next run is worse than a blank id — the sync log's
 * ids are only used to recognise pre-metadata rows, and "" matches nothing.
 * If the host acknowledged nothing at all, they count as failures instead.
 */
function interpretBulkResult(
  chunk: PendingCharge[],
  result: ActivityBulkMutationResult | undefined,
  errors: string[],
): ChunkOutcome {
  const byTempId = new Map(chunk.map((c) => [c.tempId, c]));
  const byKey = new Map(chunk.map((c) => [c.key, c]));
  const created: Activity[] = Array.isArray(result?.created) ? result.created : [];
  const mappings = Array.isArray(result?.createdMappings) ? result.createdMappings : [];
  const reported = Array.isArray(result?.errors) ? result.errors : [];

  const entries: Record<string, string> = {};
  const resolved = new Set<string>();
  const failedKeys = new Set<string>();
  let failed = 0;

  // Attributed failures first, so a rejected charge is never counted as synced.
  const anonymous: string[] = [];
  for (const err of reported) {
    const owner = err?.id ? byTempId.get(err.id) : undefined;
    const message = typeof err?.message === "string" ? err.message : "rejected";
    if (owner) {
      if (!failedKeys.has(owner.key)) {
        failedKeys.add(owner.key);
        failed++;
        errors.push(`${owner.label}: ${trim(message)}`);
      }
    } else {
      anonymous.push(trim(message));
    }
  }

  // Strategy 1 — metadata.chargeKey.
  for (const activity of created) {
    const key = chargeKeyOf(activity);
    if (!key || !byKey.has(key) || resolved.has(key) || failedKeys.has(key)) continue;
    entries[key] = idOf(activity);
    resolved.add(key);
  }

  // Strategy 2 — tempId mappings.
  for (const mapping of mappings) {
    const owner = mapping?.tempId ? byTempId.get(mapping.tempId) : undefined;
    if (!owner || resolved.has(owner.key) || failedKeys.has(owner.key)) continue;
    entries[owner.key] = typeof mapping.activityId === "string" ? mapping.activityId : "";
    resolved.add(owner.key);
  }

  const remaining = chunk.filter((c) => !resolved.has(c.key) && !failedKeys.has(c.key));
  if (remaining.length === 0) return { entries, failed };

  // Strategy 3 — positional, only when the result is unambiguous.
  if (
    resolved.size === 0 &&
    failedKeys.size === 0 &&
    anonymous.length === 0 &&
    created.length === chunk.length
  ) {
    chunk.forEach((c, i) => {
      entries[c.key] = idOf(created[i]);
    });
    return { entries, failed };
  }

  if (anonymous.length > 0) {
    // Errors the host didn't attribute: assume they explain the leftovers.
    failed += remaining.length;
    errors.push(`${remaining.length} charge(s) rejected: ${anonymous[0]}`);
    return { entries, failed };
  }

  if (created.length === 0 && mappings.length === 0) {
    // Nothing acknowledged — safe to assume nothing was written.
    failed += remaining.length;
    errors.push(`Wealthfolio returned no result for ${remaining.length} charge(s)`);
    return { entries, failed };
  }

  // Written, but we cannot say as which id. Record so we never double-push.
  for (const c of remaining) entries[c.key] = "";
  return { entries, failed };
}

/** Legacy path for hosts without saveMany. One IPC round-trip per charge. */
async function writeIndividually(
  ctx: AddonContext,
  chunk: PendingCharge[],
  errors: string[],
): Promise<ChunkOutcome> {
  const entries: Record<string, string> = {};
  let failed = 0;
  for (const c of chunk) {
    try {
      const activity = await ctx.api.activities.create(c.create);
      entries[c.key] = idOf(activity);
    } catch (err) {
      failed++;
      errors.push(`${c.label}: ${describe(err)}`);
    }
  }
  return { entries, failed };
}

function invalidateCaches(ctx: AddonContext, accountIds: Set<string>): void {
  try {
    const invalidate = ctx.api?.query?.invalidateQueries;
    if (typeof invalidate !== "function") return;
    for (const key of INVALIDATE_AFTER_WRITE) invalidate.call(ctx.api.query, key);
    // QueryKeys.valuationHistory(id) is ["historyValuation", id], which React
    // Query already matches by prefix from the scalar key above. Invalidated
    // explicitly anyway so the accounts we wrote to refresh even on a host that
    // treats a string key as an exact match.
    for (const accountId of accountIds) {
      invalidate.call(ctx.api.query, QueryKeys.valuationHistory(accountId));
    }
  } catch (err) {
    // A stale cache is cosmetic; it must not turn a successful sync into a failure.
    try {
      ctx.api?.logger?.warn?.(`[bills-and-subscriptions] cache invalidation failed: ${describe(err)}`);
    } catch {
      // Logger unavailable — nothing more we can do.
    }
  }
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function chargeKeyOf(activity: Activity | undefined): string | null {
  const meta = activity?.metadata;
  if (!meta || typeof meta !== "object") return null;
  const key = (meta as Record<string, unknown>).chargeKey;
  return typeof key === "string" && key.length > 0 ? key : null;
}

function idOf(activity: Activity | undefined): string {
  return typeof activity?.id === "string" ? activity.id : "";
}

function label(name: string): string {
  const clean = typeof name === "string" && name.trim().length > 0 ? name.trim() : "Untitled";
  return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean;
}

function trim(message: string): string {
  const clean = message.replace(/\s+/g, " ").trim();
  return clean.length > 160 ? `${clean.slice(0, 159)}…` : clean;
}

/** Turn anything throwable into one short user-facing sentence. */
function describe(err: unknown): string {
  if (err instanceof Error && err.message) return trim(err.message);
  if (typeof err === "string" && err.trim()) return trim(err);
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return trim(message);
  }
  return "unexpected error";
}

/**
 * Does this rejection mean "this host has no bulk write" rather than "the write
 * failed"? Only then do we retry the chunk one activity at a time: a genuine
 * failure may have partially committed, and re-sending it would double-write.
 */
function looksUnsupported(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const message = describe(err).toLowerCase();
  return (
    /not a function/.test(message) ||
    /not implemented/.test(message) ||
    /unimplemented/.test(message) ||
    /not supported|unsupported/.test(message) ||
    /unknown (command|method|function)/.test(message) ||
    /no such (command|method|function)/.test(message) ||
    /command .* not found/.test(message)
  );
}

/** Cap the list the UI renders; the last slot says how much was dropped. */
function capErrors(errors: string[]): string[] {
  if (errors.length <= MAX_ERRORS) return errors;
  const kept = errors.slice(0, MAX_ERRORS - 1);
  kept.push(`…and ${errors.length - (MAX_ERRORS - 1)} more problem(s) not shown`);
  return kept;
}
