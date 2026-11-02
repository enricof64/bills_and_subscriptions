// Persistence for subscriptions, bills, links and settings, backed by
// ctx.api.storage — the host's durable per-addon KV store (Wealthfolio 3.6.2+) —
// through a synchronous in-memory cache (see "Host KV store + in-memory cache").
// localStorage is not used: it is unavailable in the sandboxed iframe addons run in.
//
// Two invariants hold throughout this file:
//   1. Every write goes through persist() — a rejected host write must be
//      reported and rolled back, never thrown into a React event handler.
//   2. Every date is a "YYYY-MM-DD" string and all arithmetic/formatting is
//      UTC-only. Mixing UTC parsing with local rendering shifts dates by a day.
import { getContext } from "../context";

export type BillingCycle = "monthly" | "yearly" | "quarterly" | "weekly";

/** Stamped into metadata.source of activities this addon creates, so the
 *  transaction matcher can recognise and exclude its own synthetic activities. */
export const ADDON_SOURCE = "bills-and-subscriptions";
export const SCHEMA_VERSION = 2;

export const CATEGORIES = [
  "Entertainment",
  "Productivity",
  "Health & Fitness",
  "Finance",
  "News & Media",
  "Education",
  "Cloud & Storage",
  "Communication",
  "Shopping",
  "Utilities",
  "Other",
] as const;

export type SubscriptionCategory = (typeof CATEGORIES)[number];

export const CURRENCIES = [
  "USD", "EUR", "GBP", "CAD", "AUD", "JPY", "CHF", "SEK", "NOK", "DKK",
  "NZD", "SGD", "HKD", "BRL", "MXN", "INR", "KRW", "PLN", "CZK", "HUF",
] as const;

export type Currency = (typeof CURRENCIES)[number];

export interface Subscription {
  id: string;
  name: string;
  amount: number;
  currency: Currency;
  billingCycle: BillingCycle;
  category: SubscriptionCategory;
  website?: string;    // optional — used to auto-fetch favicon
  startDate?: string;  // ISO date string
  notes?: string;
  active: boolean;
  accountId?: string;
}

export const CYCLE_LABELS: Record<BillingCycle, string> = {
  monthly: "/ mo",
  yearly: "/ yr",
  quarterly: "/ qtr",
  weekly: "/ wk",
};

// Category colors — one distinct hue per category, no hue family repeated more than once.
export const CATEGORY_COLORS: Record<SubscriptionCategory, { bg: string; color: string }> = {
  "Entertainment":    { bg: "rgba(148,97,212,0.15)",  color: "#9461d4" },  // purple
  "Productivity":     { bg: "rgba(77,125,204,0.15)",  color: "#4d7dcc" },  // blue
  "Health & Fitness": { bg: "rgba(54,161,93,0.15)",   color: "#36a15d" },  // green
  "Finance":          { bg: "rgba(181,128,38,0.15)",  color: "#b58026" },  // amber
  "News & Media":     { bg: "rgba(198,83,133,0.15)",  color: "#c65385" },  // rose
  "Education":        { bg: "rgba(59,176,164,0.15)",  color: "#3bb0a4" },  // teal
  "Cloud & Storage":  { bg: "rgba(114,140,53,0.15)",  color: "#728c35" },  // olive
  "Communication":    { bg: "rgba(91,92,200,0.15)",   color: "#5b5cc8" },  // indigo
  "Shopping":         { bg: "rgba(175,140,44,0.15)",  color: "#af8c2c" },  // gold
  "Utilities":        { bg: "rgba(210,114,45,0.15)",  color: "#d2722d" },  // orange
  "Other":            { bg: "rgba(128,149,179,0.12)", color: "#8095b3" },  // slate
};

// ─── Bills ────────────────────────────────────────────────────────────────────

export const BILL_CATEGORIES = [
  "Electricity",
  "Water",
  "Gas",
  "Internet",
  "Phone",
  "Rent",
  "Insurance",
  "Other",
] as const;

export type BillCategory = (typeof BILL_CATEGORIES)[number];

export const BILL_CATEGORY_COLORS: Record<BillCategory, { bg: string; color: string }> = {
  "Electricity": { bg: "rgba(175,140,44,0.15)",  color: "#af8c2c" },  // gold
  "Water":       { bg: "rgba(59,176,164,0.15)",  color: "#3bb0a4" },  // teal
  "Gas":         { bg: "rgba(210,114,45,0.15)",  color: "#d2722d" },  // orange
  "Internet":    { bg: "rgba(91,92,200,0.15)",   color: "#5b5cc8" },  // indigo
  "Phone":       { bg: "rgba(198,83,133,0.15)",  color: "#c65385" },  // rose
  "Rent":        { bg: "rgba(200,64,64,0.15)",   color: "#c84040" },  // red
  "Insurance":   { bg: "rgba(54,161,93,0.15)",   color: "#36a15d" },  // green
  "Other":       { bg: "rgba(128,149,179,0.12)", color: "#8095b3" },  // slate
};

export interface Bill {
  id: string;
  name: string;
  amount: number;
  currency: Currency;
  category: BillCategory;
  date: string;   // ISO date — when the bill arrived / is due
  website?: string;
  notes?: string;
  paid: boolean;
  recurring: boolean;
  billingCycle?: BillingCycle; // only meaningful when recurring === true
  accountId?: string;
}

// ─── Storage keys ─────────────────────────────────────────────────────────────
// Dotted names match the keys the upstream addon already writes to ctx.api.storage
// (so an install that predates this fork's extras keeps its data); the storage
// API accepts only ASCII letters, digits, '.', '_', ':' and '-'.

const SUBS_KEY = "ss.subscriptions";
const BILLS_KEY = "ss.bills";
const SETTINGS_KEY = "ss.settings";
const SYNC_LOG_KEY = "ss.synclog";
const SCHEMA_VERSION_KEY = "ss.schema-version";
/** Canonical key for linked transactions. Import this instead of hardcoding. */
export const LINKS_KEY = "ss.links";
/** Pre-v2 key that predates the ss prefix convention. */
const LEGACY_LINKS_KEY = "blink:links";

const SECRETS_MIGRATION_MARKER_KEY = "ss.migrated.storage-api";
const LOCALSTORAGE_MIGRATION_MARKER_KEY = "ss.migrated.localstorage";

/** Every key the in-memory cache mirrors. Logos are cached separately. */
const CACHED_KEYS = [
  SUBS_KEY,
  BILLS_KEY,
  SETTINGS_KEY,
  SYNC_LOG_KEY,
  SCHEMA_VERSION_KEY,
  LINKS_KEY,
  LEGACY_LINKS_KEY,
] as const;

/** Where this fork kept each key while it was localStorage-backed (pre-3.6 hosts). */
const LOCALSTORAGE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["ss:subscriptions", SUBS_KEY],
  ["ss:bills", BILLS_KEY],
  ["ss:settings", SETTINGS_KEY],
  ["ss:sync-log", SYNC_LOG_KEY],
  ["ss:schema-version", SCHEMA_VERSION_KEY],
  ["ss:links", LINKS_KEY],
  ["blink:links", LEGACY_LINKS_KEY],
];

// ─── Storage error reporting ──────────────────────────────────────────────────

export type StorageErrorHandler = (err: unknown, key: string) => void;

let storageErrorHandler: StorageErrorHandler | null = null;

/** Pages call this once to route quota/serialisation failures to a host toast. */
export function setStorageErrorHandler(fn: StorageErrorHandler | null): void {
  storageErrorHandler = fn;
}

/** Exported so sibling data modules report through the same channel. */
export function reportStorageError(err: unknown, key: string): void {
  try {
    storageErrorHandler?.(err, key);
  } catch {
    // A broken handler must not take the caller down with it.
  }
}

// ─── Change notification ──────────────────────────────────────────────────────

/**
 * Pages read their slice of the cache on mount, so a write made on one tab
 * left every other tab stale until it happened to remount — a link created on
 * the Bills page was missing from the Links page, and vice versa. Every write
 * goes through persist(), so one dispatch there covers all of them.
 */
const DATA_CHANGED_EVENT = "ss:data-changed";

/** Subscribe to writes. Returns an unsubscribe function.
 *  `keys` optionally narrows to the storage keys the caller cares about. */
export function onDataChanged(fn: (key: string) => void, keys?: readonly string[]): () => void {
  const handler = (e: Event) => {
    const key = (e as CustomEvent<{ key: string }>).detail?.key ?? "";
    if (keys && !keys.includes(key)) return;
    fn(key);
  };
  window.addEventListener(DATA_CHANGED_EVENT, handler);
  return () => window.removeEventListener(DATA_CHANGED_EVENT, handler);
}

function notifyChanged(key: string): void {
  try {
    window.dispatchEvent(new CustomEvent(DATA_CHANGED_EVENT, { detail: { key } }));
  } catch {
    // Notification is a nicety; a successful write must still count as one.
  }
}

// ─── Host KV store + in-memory cache ──────────────────────────────────────────
// ctx.api.storage is async, but the rest of the addon (and every render) reads
// synchronously. So reads come from an in-memory cache that hydrateStorage()
// fills once, and writes update the cache immediately and are written through to
// the host in order. Each collection is one JSON blob (the store caps values at
// ~250 KB, comfortably above this addon's data).

let hydrated = false;
const cache = new Map<string, string>();

/**
 * True once hydrateStorage() has loaded the KV store into the cache. A write
 * before this point would be built on an empty cache and could overwrite what is
 * on disk with an incomplete snapshot — pages must gate mutations (e.g. disable
 * "Add") on this.
 */
export function isHydrated(): boolean {
  return hydrated;
}

// Writes are serialised so two never land out of order and clobber each other
// with a stale snapshot (each write sends the whole current blob).
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(op, op);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Resolves once every write issued so far has settled (successfully or not). */
export function flushWrites(): Promise<void> {
  return writeQueue.then(() => undefined);
}

function sanitizeKeySegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._:-]/g, "_");
}

function storageGet(key: string): Promise<string | null> {
  return getContext().api.storage.get(key);
}

function storageSet(key: string, value: string): Promise<void> {
  return enqueueWrite(() => getContext().api.storage.set(key, value));
}

function storageDelete(key: string): Promise<void> {
  return enqueueWrite(() => getContext().api.storage.delete(key));
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await storageGet(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch (err: unknown) {
    getContext().api.logger.error(`Failed to read "${key}": ${String(err)}`);
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  storageSet(key, JSON.stringify(value)).catch((err: unknown) => {
    getContext().api.logger.error(`Failed to persist "${key}": ${String(err)}`);
  });
}

/** The single write path for every module that owns an "ss." key. Serialises,
 *  updates the cache, writes through to the host, reports failures, never throws. */
export function persist(key: string, value: unknown): void {
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch (err) {
    reportStorageError(err, key);
    return; // Nothing changed, so do not tell listeners it did.
  }
  const previous = cache.get(key);
  cache.set(key, raw);
  notifyChanged(key);
  storageSet(key, raw).catch((err: unknown) => {
    // The host refused the write (quota, size cap, store unavailable). Roll the
    // cache back so the UI does not show data that will vanish on reload — but
    // only if nothing newer has been written to this key in the meantime.
    if (cache.get(key) === raw) {
      if (previous === undefined) cache.delete(key);
      else cache.set(key, previous);
      notifyChanged(key);
    }
    reportStorageError(err, key);
  });
}

function forget(key: string): void {
  cache.delete(key);
  storageDelete(key).catch((err: unknown) => reportStorageError(err, key));
}

/** Raw cached JSON for a key, or null. Never throws. */
export function readRaw(key: string): string | null {
  return cache.get(key) ?? null;
}

function load<T>(key: string): T[] {
  try {
    const raw = readRaw(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function save<T>(key: string, items: T[]): void {
  persist(key, items);
}

let subLogoCache: Record<string, string> = {};
let subLogoIds: string[] = [];
let billLogoCache: Record<string, string> = {};
let billLogoIds: string[] = [];

/**
 * Load everything from the host KV store into the cache, run schema migrations
 * on the loaded data, then announce "ss:storage-hydrated". Safe to call again
 * (it replaces the cache wholesale). Never throws: a failed read leaves that
 * collection empty and is logged.
 */
export async function hydrateStorage(): Promise<void> {
  try {
    await migrateLegacySecretsIfNeeded();
    await migrateLocalStorageIfNeeded();
  } catch (err: unknown) {
    getContext().api.logger.error(`Legacy data migration failed: ${String(err)}`);
  }

  const [rawEntries, subLogos, billLogos] = await Promise.all([
    Promise.all(
      CACHED_KEYS.map(async (key) => {
        try {
          return [key, await storageGet(key)] as const;
        } catch (err: unknown) {
          getContext().api.logger.error(`Failed to read "${key}": ${String(err)}`);
          return [key, null] as const;
        }
      }),
    ),
    loadLogos("sub"),
    loadLogos("bill"),
  ]);

  cache.clear();
  for (const [key, raw] of rawEntries) {
    if (raw !== null) cache.set(key, raw);
  }
  subLogoCache = subLogos.cache;
  subLogoIds = subLogos.ids;
  billLogoCache = billLogos.cache;
  billLogoIds = billLogos.ids;

  runMigrations();
  hydrated = true;
  window.dispatchEvent(new CustomEvent("ss:storage-hydrated"));
}

// ─── Fork localStorage -> KV migration ────────────────────────────────────────
// Before this addon moved to ctx.api.storage it kept everything in localStorage
// under "ss:*". Hosts that still expose localStorage to addons hand that data
// to the KV store exactly once; sandboxed hosts (3.6+) have none and skip it.

async function migrateLocalStorageIfNeeded(): Promise<void> {
  const marker = await storageGet(LOCALSTORAGE_MIGRATION_MARKER_KEY).catch(() => null);
  if (marker) return;

  let ls: Storage | null = null;
  try {
    ls = typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    ls = null; // accessing it throws in sandboxed iframes
  }

  if (ls) {
    for (const [lsKey, kvKey] of LOCALSTORAGE_KEYS) {
      let raw: string | null = null;
      try {
        raw = ls.getItem(lsKey);
      } catch {
        continue;
      }
      if (raw === null) continue;
      // Never overwrite data that already lives in the KV store.
      const existing = await storageGet(kvKey).catch(() => null);
      if (existing === null) await storageSet(kvKey, raw);
    }
  }

  await storageSet(LOCALSTORAGE_MIGRATION_MARKER_KEY, "1");
}

// ─── Legacy secrets migration ─────────────────────────────────────────────────
// Wealthfolio versions before 3.6.2 gave addons no durable storage other than
// ctx.api.secrets (OS keyring-backed, capped at 2560 chars/value), so the addon
// split each collection into one secret per item plus an index, and chunked
// logos into ~1000-char pieces. This one-time pass reads any pre-3.6.2 data out
// of secrets, writes it into the new storage keys, and deletes the old secrets
// so they don't linger in the keyring. Gated by a marker key.

function itemKey(prefix: string, id: string): string {
  return `ss.${prefix}.${sanitizeKeySegment(id)}`;
}

function indexKey(prefix: string): string {
  return `ss.${prefix}.index`;
}

async function loadLegacyCollection<T>(
  secrets: { get(key: string): Promise<string | null> },
  prefix: string,
): Promise<{ items: T[]; ids: string[] }> {
  try {
    const indexRaw = await secrets.get(indexKey(prefix));
    const ids: string[] = indexRaw ? JSON.parse(indexRaw) : [];
    const items: (T | null)[] = await Promise.all(
      ids.map(async (id): Promise<T | null> => {
        try {
          const raw = await secrets.get(itemKey(prefix, id));
          return raw ? (JSON.parse(raw) as T) : null;
        } catch {
          return null;
        }
      }),
    );
    return { items: items.filter((item): item is T => item !== null), ids };
  } catch {
    return { items: [], ids: [] };
  }
}

async function loadLegacyChunkedValue(
  secrets: { get(key: string): Promise<string | null> },
  prefix: string,
  id: string,
): Promise<{ value: string | null; chunkCount: number }> {
  try {
    const metaRaw = await secrets.get(itemKey(prefix, id));
    if (!metaRaw) return { value: null, chunkCount: 0 };
    const meta = JSON.parse(metaRaw) as { chunks: number };
    const chunks = await Promise.all(
      Array.from({ length: meta.chunks }, (_, i) => secrets.get(`${itemKey(prefix, id)}.c${i}`)),
    );
    if (chunks.some((c) => c === null)) return { value: null, chunkCount: meta.chunks };
    return { value: chunks.join(""), chunkCount: meta.chunks };
  } catch {
    return { value: null, chunkCount: 0 };
  }
}

async function loadLegacyLogos(
  secrets: { get(key: string): Promise<string | null> },
  prefix: string,
): Promise<{ cache: Record<string, string>; chunkCounts: Record<string, number> }> {
  const indexRaw = await secrets.get(indexKey(prefix)).catch(() => null);
  const ids: string[] = indexRaw ? JSON.parse(indexRaw) : [];
  const loaded = await Promise.all(ids.map((id) => loadLegacyChunkedValue(secrets, prefix, id)));
  const cache: Record<string, string> = {};
  const chunkCounts: Record<string, number> = {};
  ids.forEach((id, i) => {
    if (loaded[i].value !== null) cache[id] = loaded[i].value as string;
    chunkCounts[id] = loaded[i].chunkCount;
  });
  return { cache, chunkCounts };
}

async function migrateLegacySecretsIfNeeded(): Promise<void> {
  const marker = await storageGet(SECRETS_MIGRATION_MARKER_KEY).catch(() => null);
  if (marker) return;

  const secrets = getContext().api.secrets;

  const [subs, bills, syncLog, settingsRaw, subLogos, billLogos] = await Promise.all([
    loadLegacyCollection<Subscription>(secrets, "sub"),
    loadLegacyCollection<Bill>(secrets, "bill"),
    loadLegacyCollection<string>(secrets, "synclog"),
    secrets.get(SETTINGS_KEY).catch(() => null),
    loadLegacyLogos(secrets, "logo-sub"),
    loadLegacyLogos(secrets, "logo-bill"),
  ]);

  const subLogoIdsFound = Object.keys(subLogos.cache);
  const billLogoIdsFound = Object.keys(billLogos.cache);
  const foundLegacyData =
    subs.items.length > 0 ||
    bills.items.length > 0 ||
    syncLog.items.length > 0 ||
    !!settingsRaw ||
    subLogoIdsFound.length > 0 ||
    billLogoIdsFound.length > 0;

  if (foundLegacyData) {
    const syncLogEntries = Object.fromEntries(
      syncLog.ids.map((id, i) => [id, syncLog.items[i]]).filter(([, v]) => v !== undefined),
    );
    await Promise.all([
      storageSet(SUBS_KEY, JSON.stringify(subs.items)),
      storageSet(BILLS_KEY, JSON.stringify(bills.items)),
      storageSet(SYNC_LOG_KEY, JSON.stringify(syncLogEntries)),
      settingsRaw ? storageSet(SETTINGS_KEY, settingsRaw) : Promise.resolve(),
      ...subLogoIdsFound.map((id) => storageSet(itemKey("logo.sub", id), subLogos.cache[id])),
      subLogoIdsFound.length ? storageSet(indexKey("logo.sub"), JSON.stringify(subLogoIdsFound)) : Promise.resolve(),
      ...billLogoIdsFound.map((id) => storageSet(itemKey("logo.bill", id), billLogos.cache[id])),
      billLogoIdsFound.length ? storageSet(indexKey("logo.bill"), JSON.stringify(billLogoIdsFound)) : Promise.resolve(),
    ]);

    const legacyKeysToDelete = [
      SETTINGS_KEY,
      indexKey("sub"), ...subs.ids.map((id) => itemKey("sub", id)),
      indexKey("bill"), ...bills.ids.map((id) => itemKey("bill", id)),
      indexKey("synclog"), ...syncLog.ids.map((id) => itemKey("synclog", id)),
      indexKey("logo-sub"),
      ...Object.keys(subLogos.chunkCounts).flatMap((id) =>
        Array.from({ length: subLogos.chunkCounts[id] }, (_, i) => `${itemKey("logo-sub", id)}.c${i}`).concat(
          itemKey("logo-sub", id),
        ),
      ),
      indexKey("logo-bill"),
      ...Object.keys(billLogos.chunkCounts).flatMap((id) =>
        Array.from({ length: billLogos.chunkCounts[id] }, (_, i) => `${itemKey("logo-bill", id)}.c${i}`).concat(
          itemKey("logo-bill", id),
        ),
      ),
    ];
    await Promise.all(legacyKeysToDelete.map((key) => secrets.delete(key).catch(() => {})));
    getContext().api.logger.info(
      `Migrated legacy secrets-backed data to storage API: ${subs.items.length} subscriptions, ${bills.items.length} bills`,
    );
  }

  await storageSet(SECRETS_MIGRATION_MARKER_KEY, "1");
}

// ─── Logos ────────────────────────────────────────────────────────────────────
// Keyed individually rather than folded into one blob, since they're looked
// up by subscription/bill id and added/removed independently. An index lists
// the ids that currently have a logo, since the storage API has no key
// listing/enumeration of its own.

export type LogoKind = "sub" | "bill";

function logoPrefix(kind: LogoKind): string {
  return kind === "sub" ? "logo.sub" : "logo.bill";
}

async function loadLogos(kind: LogoKind): Promise<{ cache: Record<string, string>; ids: string[] }> {
  const prefix = logoPrefix(kind);
  const ids = await readJson<string[]>(indexKey(prefix), []);
  const values = await Promise.all(ids.map((id) => storageGet(itemKey(prefix, id))));
  const cache = Object.fromEntries(
    ids.map((id, i) => [id, values[i]]).filter((entry): entry is [string, string] => entry[1] !== null),
  );
  return { cache, ids: Object.keys(cache) };
}

export function getLogo(kind: LogoKind, id: string): string | null {
  return (kind === "sub" ? subLogoCache : billLogoCache)[id] ?? null;
}

/** Returns true if the logo was saved successfully. */
export async function saveLogo(kind: LogoKind, id: string, dataUri: string): Promise<boolean> {
  const prefix = logoPrefix(kind);
  try {
    await storageSet(itemKey(prefix, id), dataUri);
  } catch (err: unknown) {
    getContext().api.logger.error(`Failed to persist logo ${prefix}/${id}: ${String(err)}`);
    getContext().api.toast.error("Couldn't save that logo — it may still be too large. Try a smaller image.");
    return false;
  }
  if (kind === "sub") {
    subLogoCache = { ...subLogoCache, [id]: dataUri };
    if (!subLogoIds.includes(id)) {
      subLogoIds = [id, ...subLogoIds];
      writeJson(indexKey(prefix), subLogoIds);
    }
  } else {
    billLogoCache = { ...billLogoCache, [id]: dataUri };
    if (!billLogoIds.includes(id)) {
      billLogoIds = [id, ...billLogoIds];
      writeJson(indexKey(prefix), billLogoIds);
    }
  }
  return true;
}

export function deleteLogo(kind: LogoKind, id: string): void {
  const prefix = logoPrefix(kind);
  storageDelete(itemKey(prefix, id)).catch(() => {});
  if (kind === "sub") {
    const { [id]: _removed, ...rest } = subLogoCache;
    subLogoCache = rest;
    subLogoIds = subLogoIds.filter((existing) => existing !== id);
    writeJson(indexKey(prefix), subLogoIds);
  } else {
    const { [id]: _removed, ...rest } = billLogoCache;
    billLogoCache = rest;
    billLogoIds = billLogoIds.filter((existing) => existing !== id);
    writeJson(indexKey(prefix), billLogoIds);
  }
}


// ─── Bills store ──────────────────────────────────────────────────────────────

export function getBills(): Bill[] {
  return load<Bill>(BILLS_KEY);
}

export function saveBill(bill: Bill): void {
  const all = load<Bill>(BILLS_KEY);
  const idx = all.findIndex((b) => b.id === bill.id);
  if (idx >= 0) {
    all[idx] = bill;
  } else {
    all.unshift(bill);
  }
  save(BILLS_KEY, all);
}

export function deleteBill(id: string): void {
  save(BILLS_KEY, load<Bill>(BILLS_KEY).filter((b) => b.id !== id));
}

// ─── Addon settings ───────────────────────────────────────────────────────────

export interface AddonSettings {
  billsEnabled: boolean;
  syncAccountId: string | null; // null = sync disabled
}

const DEFAULT_SETTINGS: AddonSettings = { billsEnabled: true, syncAccountId: null };

export function getSettings(): AddonSettings {
  try {
    const raw = readRaw(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AddonSettings): void {
  persist(SETTINGS_KEY, settings);
  try {
    window.dispatchEvent(new CustomEvent("ss:settings-changed"));
  } catch {
    // Non-DOM environment (tests); nothing to notify.
  }
}

// ─── Sync log ─────────────────────────────────────────────────────────────────
// Maps "${subId}:${date}" → activityId so we never push the same charge twice.

export function getSyncLog(): Record<string, string> {
  try {
    const raw = readRaw(SYNC_LOG_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export function updateSyncLog(entries: Record<string, string>): void {
  persist(SYNC_LOG_KEY, { ...getSyncLog(), ...entries });
}

export function getSyncLogCount(): number {
  return Object.keys(getSyncLog()).length;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Extract a clean hostname from a website string entered by the user. */
export function extractDomain(website: string): string {
  try {
    const url = website.startsWith("http") ? website : `https://${website}`;
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return website.replace(/^www\./, "");
  }
}

/** Convert any billing cycle amount to its monthly equivalent. */
export function toMonthly(amount: number, cycle: BillingCycle): number {
  switch (cycle) {
    case "weekly":    return (amount * 52) / 12;
    case "monthly":   return amount;
    case "quarterly": return amount / 3;
    case "yearly":    return amount / 12;
  }
}

/** Convert any billing cycle amount to its yearly equivalent. */
export function toYearly(amount: number, cycle: BillingCycle): number {
  switch (cycle) {
    case "weekly":    return amount * 52;
    case "monthly":   return amount * 12;
    case "quarterly": return amount * 4;
    case "yearly":    return amount;
  }
}

/**
 * Never throws. Intl rejects anything that is not a 3-letter ISO 4217 code with
 * a RangeError, and the currency reaching this function is not always one: link
 * rows carry whatever currency the host had on the activity, and a restored
 * backup is only validated structurally. This is called from render bodies, so a
 * throw would blank the whole page — including the buttons needed to delete the
 * offending row — leaving the addon unusable until its stored data is cleared by
 * hand. Falls back to "12.30 US$" rather than dying.
 */
export function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    const shown = Number.isFinite(amount) ? amount.toFixed(2) : String(amount);
    return currency ? `${shown} ${currency}` : shown;
  }
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
// All date strings are "YYYY-MM-DD". All arithmetic is UTC-only, all formatting
// passes timeZone: "UTC", and everything here is pure except todayISO().

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH_RE = /^(\d{4})-(\d{2})$/;

interface YMD { y: number; m: number; d: number } // m is 1-based

function parseISODate(s: string): YMD | null {
  if (typeof s !== "string") return null;
  const match = ISO_DATE_RE.exec(s);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function toISO({ y, m, d }: YMD): string {
  return `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
}

/** Number of days in a 1-based month. */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addDaysUTC(base: YMD, days: number): YMD {
  const t = new Date(Date.UTC(base.y, base.m - 1, base.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Add whole months, clamping the day to the target month's length. */
function addMonthsUTC(base: YMD, months: number, anchorDay: number): YMD {
  const total = (base.y * 12 + (base.m - 1)) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return { y, m, d: Math.min(anchorDay, daysInMonth(y, m)) };
}

/** Advance `base` by `n` whole cycles, computed from the base directly. */
function addCycles(base: YMD, cycle: BillingCycle, n: number, anchorDay: number): YMD {
  switch (cycle) {
    case "weekly":    return addDaysUTC(base, 7 * n);
    case "monthly":   return addMonthsUTC(base, n, anchorDay);
    case "quarterly": return addMonthsUTC(base, 3 * n, anchorDay);
    case "yearly":    return addMonthsUTC(base, 12 * n, anchorDay);
  }
}

/** Today as YYYY-MM-DD, using the user's LOCAL calendar day (not UTC midnight). */
export function todayISO(): string {
  const now = new Date();
  return toISO({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });
}

/** true iff s is a well-formed, real YYYY-MM-DD calendar date. */
export function isValidISODate(s: string): boolean {
  return parseISODate(s) !== null;
}

/** "2026-02-03" -> "2026-02". Returns "" for invalid input. */
export function monthKey(dateStr: string): string {
  const p = parseISODate(dateStr);
  return p ? `${String(p.y).padStart(4, "0")}-${pad2(p.m)}` : "";
}

function parseMonthKey(key: string): { y: number; m: number } | null {
  if (typeof key !== "string") return null;
  const match = ISO_MONTH_RE.exec(key);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  return m >= 1 && m <= 12 ? { y, m } : null;
}

/** "2026-02" -> "February 2026" (locale-aware, rendered in UTC so no off-by-one-day). */
export function formatMonthLabel(monthKey: string): string {
  const p = parseMonthKey(monthKey);
  if (!p) return "";
  return new Date(Date.UTC(p.y, p.m - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "2026-02-03" -> "3 Feb" (locale-aware, UTC-rendered). */
export function formatDayLabel(dateStr: string): string {
  const p = parseISODate(dateStr);
  if (!p) return "";
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/**
 * "2026-02-03" -> "3 Feb 2026". Same locale-aware, UTC-pinned formatting as
 * formatDayLabel, plus the year — matched transactions are ranked by name and
 * amount rather than recency, so the top candidate is routinely from a prior
 * year and a bare day+month would be ambiguous exactly when it matters. The
 * year is lifted off the ISO string, never re-parsed through a local Date.
 */
export function formatFullDate(dateStr: string): string {
  const label = formatDayLabel(dateStr);
  return label ? `${label} ${dateStr.slice(0, 4)}` : "";
}

/** Best-effort human-readable form of an unknown thrown value. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/** "2026-02" -> "2026-02-01" (first day of that month). */
export function monthKeyToDate(monthKey: string): string {
  const p = parseMonthKey(monthKey);
  return p ? toISO({ y: p.y, m: p.m, d: 1 }) : "";
}

/**
 * Advance one billing cycle. UTC-only, never throws.
 * anchorDay: preferred day-of-month for month-based cycles; defaults to the day
 * of dateStr. Clamped to the target month's length (Jan 31 +1mo -> Feb 28).
 * Returns "" if dateStr is invalid.
 */
export function advanceDateByCycle(dateStr: string, cycle: BillingCycle, anchorDay?: number): string {
  const base = parseISODate(dateStr);
  if (!base) return "";
  const anchor = normaliseAnchor(anchorDay, base.d);
  return toISO(addCycles(base, cycle, 1, anchor));
}

function normaliseAnchor(anchorDay: number | undefined, fallback: number): number {
  if (typeof anchorDay !== "number" || !Number.isFinite(anchorDay)) return fallback;
  return Math.min(31, Math.max(1, Math.trunc(anchorDay)));
}

/**
 * Every occurrence date from startDate up to and including untilDate.
 * Each occurrence i is computed as start + i cycles rather than by repeatedly
 * advancing the previous result, so the day-of-month never drifts: a monthly
 * series from 2026-01-31 is 2026-01-31, 2026-02-28, 2026-03-31, 2026-04-30, ...
 * Returns [] if startDate is invalid or after untilDate. Never throws.
 */
export function cycleSeries(
  startDate: string,
  cycle: BillingCycle,
  untilDate: string,
  maxCount = 2000,
): string[] {
  const start = parseISODate(startDate);
  const until = parseISODate(untilDate);
  if (!start || !until) return [];
  const untilISO = toISO(until);
  if (toISO(start) > untilISO) return [];

  const cap = Number.isFinite(maxCount) ? Math.max(0, Math.trunc(maxCount)) : 0;
  const out: string[] = [];
  for (let i = 0; out.length < cap; i++) {
    const iso = toISO(addCycles(start, cycle, i, start.d));
    if (iso > untilISO) break;
    out.push(iso);
  }
  return out;
}

// ─── Subscriptions store ──────────────────────────────────────────────────────

export function getSubscriptions(): Subscription[] {
  return load<Subscription>(SUBS_KEY);
}

export function saveSubscription(sub: Subscription): void {
  const all = load<Subscription>(SUBS_KEY);
  const idx = all.findIndex((s) => s.id === sub.id);
  if (idx >= 0) {
    all[idx] = sub;
  } else {
    all.unshift(sub);
  }
  save(SUBS_KEY, all);
}

export function deleteSubscription(id: string): void {
  save(SUBS_KEY, load<Subscription>(SUBS_KEY).filter((s) => s.id !== id));
}

export function generateId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the timestamp+random fallback.
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ─── Migrations ───────────────────────────────────────────────────────────────

interface LegacyLink {
  entityId?: unknown;
  entityType?: unknown;
  subscriptionId?: unknown;
  activityId?: unknown;
  [key: string]: unknown;
}

/** De-duplicate links by "entityId|activityId", first occurrence wins. */
function dedupeLinks(links: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const link of links) {
    if (typeof link !== "object" || link === null) continue;
    const l = link as LegacyLink;
    const key = `${String(l.entityId ?? "")}|${String(l.activityId ?? "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}

/** Rewrite a pre-refactor link ({ subscriptionId }) into the current shape. */
function upgradeLink(link: unknown): unknown {
  if (typeof link !== "object" || link === null) return link;
  const { subscriptionId, ...rest } = link as LegacyLink;
  if (subscriptionId === undefined || rest.entityId !== undefined) return link;
  return { entityId: subscriptionId, entityType: "subscription", ...rest };
}

/** Idempotent. Called once from addon.tsx enable(). Never throws. */
export function runMigrations(): void {
  try {
    if (readRaw(SCHEMA_VERSION_KEY) === null) {
      // v1 -> v2: links move from "blink:links" to "ss:links" and
      // LinkedTransaction.subscriptionId becomes entityId + entityType.
      const legacy = load<unknown>(LEGACY_LINKS_KEY).map(upgradeLink);
      if (legacy.length > 0) {
        const merged = dedupeLinks([...load<unknown>(LINKS_KEY), ...legacy]);
        persist(LINKS_KEY, merged);
      }
      forget(LEGACY_LINKS_KEY);
    }
    persist(SCHEMA_VERSION_KEY, SCHEMA_VERSION);
  } catch (err) {
    reportStorageError(err, SCHEMA_VERSION_KEY);
  }
}

// ─── Backup / restore ─────────────────────────────────────────────────────────

export interface BackupPayload {
  schemaVersion: number;
  exportedAt: string;
  subscriptions: Subscription[];
  bills: Bill[];
  links: unknown[];
  settings: AddonSettings;
  syncLog: Record<string, string>;
}

/** Pretty-printed JSON of everything this addon owns. */
export function exportData(): string {
  const payload: BackupPayload = {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    subscriptions: getSubscriptions(),
    bills: getBills(),
    links: load<unknown>(LINKS_KEY),
    settings: getSettings(),
    syncLog: getSyncLog(),
  };
  return JSON.stringify(payload, null, 2);
}

export interface ImportSummary { subscriptions: number; bills: number; links: number; }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates then REPLACES all addon data. Throws Error with a short
 *  user-facing message if the payload is not a valid backup. */
export function importData(json: string): ImportSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (!isPlainObject(parsed)) {
    throw new Error("That file isn't a Subscriptions & Bills backup.");
  }
  const { subscriptions, bills, links, settings, syncLog } = parsed;
  if (!Array.isArray(subscriptions) || !Array.isArray(bills)) {
    throw new Error("Backup is missing its subscriptions or bills list.");
  }

  // Everything below is validated — write only now.
  // Links go through upgradeLink first: a backup taken before v2 carries
  // { subscriptionId }, and the import stamps SCHEMA_VERSION at the end, so
  // runMigrations() would never get the chance to rewrite them. Without this,
  // restoring an old backup lands every link in the orphaned bucket with its
  // bill/subscription association permanently lost. upgradeLink is a no-op on
  // links that are already in the current shape.
  const cleanLinks = dedupeLinks((Array.isArray(links) ? links : []).map(upgradeLink));
  save(SUBS_KEY, subscriptions as Subscription[]);
  save(BILLS_KEY, bills as Bill[]);
  save(LINKS_KEY, cleanLinks);
  if (isPlainObject(settings)) {
    saveSettings({ ...DEFAULT_SETTINGS, ...(settings as Partial<AddonSettings>) });
  }
  persist(SYNC_LOG_KEY, isPlainObject(syncLog) ? syncLog : {});
  persist(SCHEMA_VERSION_KEY, SCHEMA_VERSION);

  return {
    subscriptions: subscriptions.length,
    bills: bills.length,
    links: cleanLinks.length,
  };
}
