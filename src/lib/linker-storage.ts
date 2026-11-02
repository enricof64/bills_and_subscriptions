// Persistence for links between a bill/subscription and a real account activity.
//
// The links array lives under storage.ts's canonical LINKS_KEY — this module
// must never define its own key, because the v1 -> v2 migration in storage.ts
// moves the data there and deletes the legacy pre-v2 key.

import { LINKS_KEY, persist, readRaw } from "./storage";

// Re-exported so existing importers of this module keep working. New code
// should import these from "./storage" directly.
export { generateId, formatCurrency } from "./storage";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LinkedTransaction {
  entityId: string;
  entityType: "subscription" | "bill";
  activityId: string;
  activityDate: string;
  amount: number;
  currency: string;
  description: string;
  accountName: string;
  linkedAt: string;
}

// ─── Read path ────────────────────────────────────────────────────────────────

export function getLinks(): LinkedTransaction[] {
  try {
    const raw = readRaw(LINKS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LinkedTransaction[]) : [];
  } catch {
    return [];
  }
}

export function getLinksForEntity(entityId: string): LinkedTransaction[] {
  return getLinks().filter((l) => l.entityId === entityId);
}

/** Every linked activityId, for excluding already-used transactions from match results. */
export function getLinkedActivityIds(): Set<string> {
  return new Set(getLinks().map((l) => l.activityId));
}

/** The key format used by getLinkKeys, so callers don't hand-roll it. */
export function linkKey(entityId: string, activityId: string): string {
  return `${entityId}|${activityId}`;
}

/**
 * "${entityId}|${activityId}" for every link. Build this once per render and
 * test it with linkKey() — isLinked() re-reads and re-parses the whole array on
 * every call, which is O(rows) JSON parses inside a render loop.
 */
export function getLinkKeys(): Set<string> {
  return new Set(getLinks().map((l) => linkKey(l.entityId, l.activityId)));
}

export function isLinked(entityId: string, activityId: string): boolean {
  return getLinks().some((l) => l.entityId === entityId && l.activityId === activityId);
}

// ─── Write path ───────────────────────────────────────────────────────────────

/** Shares storage.ts's write path, so a QuotaExceededError here reaches the
 *  same registered handler (and therefore the same host toast) as everywhere
 *  else, instead of being swallowed into the console. */
function persistLinks(links: LinkedTransaction[]): void {
  persist(LINKS_KEY, links);
}

/** Upsert: replaces any existing link with the same entityId+activityId. */
export function saveLink(link: LinkedTransaction): void {
  const all = getLinks().filter(
    (l) => !(l.entityId === link.entityId && l.activityId === link.activityId),
  );
  all.push(link);
  persistLinks(all);
}

export function removeLink(entityId: string, activityId: string): void {
  persistLinks(
    getLinks().filter((l) => !(l.entityId === entityId && l.activityId === activityId)),
  );
}

/** Remove every link belonging to one bill or subscription. */
export function removeLinksForEntity(entityId: string): void {
  persistLinks(getLinks().filter((l) => l.entityId !== entityId));
}

// ─── Presentation ─────────────────────────────────────────────────────────────

/** Traffic-light colour for a 0..1 confidence score. */
export function confidenceColor(confidence: number): string {
  if (confidence >= 0.8) return "#36a15d"; // green
  if (confidence >= 0.6) return "#b58026"; // amber
  return "#d2722d"; // orange
}
