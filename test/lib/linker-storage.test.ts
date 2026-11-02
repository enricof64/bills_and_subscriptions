import { describe, expect, it } from "vitest";
import { installBrowserGlobals } from "../browser-globals";
import { LINKS_KEY, flushWrites, hydrateStorage } from "../../src/lib/storage";
import {
  confidenceColor,
  getLinkKeys,
  getLinkedActivityIds,
  getLinks,
  getLinksForEntity,
  isLinked,
  linkKey,
  removeLink,
  removeLinksForEntity,
  saveLink,
  type LinkedTransaction,
} from "../../src/lib/linker-storage";

const storage = installBrowserGlobals();

function link(over: Partial<LinkedTransaction> = {}): LinkedTransaction {
  return {
    entityId: "sub-1",
    entityType: "subscription",
    activityId: "act-1",
    activityDate: "2026-02-01",
    amount: 15.99,
    currency: "USD",
    description: "NETFLIX",
    accountName: "Checking",
    linkedAt: "2026-02-02T10:00:00.000Z",
    ...over,
  };
}

describe("link CRUD", () => {
  it("writes to storage.ts's canonical links key", async () => {
    // Not a stylistic point: the v1 -> v2 migration owns "ss:links", so a
    // private key here would silently strand every link.
    saveLink(link());
    await flushWrites(); // the cache updates synchronously; the host write follows
    expect(JSON.parse(storage.getItem(LINKS_KEY) ?? "null")).toEqual([link()]);
  });

  it("upserts on entityId + activityId instead of appending a duplicate", () => {
    saveLink(link({ description: "old" }));
    saveLink(link({ description: "new" }));
    expect(getLinks()).toEqual([link({ description: "new" })]);
  });

  it("keeps links that differ in either half of the identity", () => {
    saveLink(link());
    saveLink(link({ activityId: "act-2" }));
    saveLink(link({ entityId: "bill-1", entityType: "bill" }));
    expect(getLinks()).toHaveLength(3);
  });

  it("removes exactly one link", () => {
    saveLink(link());
    saveLink(link({ activityId: "act-2" }));

    removeLink("sub-1", "act-1");

    expect(getLinks().map((l) => l.activityId)).toEqual(["act-2"]);
    removeLink("sub-1", "does-not-exist");
    expect(getLinks()).toHaveLength(1);
  });

  it("removes every link for one entity and leaves the others alone", () => {
    saveLink(link({ activityId: "act-1" }));
    saveLink(link({ activityId: "act-2" }));
    saveLink(link({ entityId: "bill-1", entityType: "bill", activityId: "act-3" }));

    removeLinksForEntity("sub-1");

    expect(getLinks().map((l) => l.entityId)).toEqual(["bill-1"]);
  });

  it("returns [] rather than throwing when the stored value is unusable", async () => {
    storage.setItem(LINKS_KEY, "{not json");
    await hydrateStorage();
    expect(getLinks()).toEqual([]);
    storage.setItem(LINKS_KEY, '{"entityId":"sub-1"}'); // object, not array
    await hydrateStorage();
    expect(getLinks()).toEqual([]);
  });
});

describe("lookup helpers", () => {
  it("filters by entity", () => {
    saveLink(link());
    saveLink(link({ entityId: "bill-1", entityType: "bill", activityId: "act-3" }));

    expect(getLinksForEntity("sub-1").map((l) => l.activityId)).toEqual(["act-1"]);
    expect(getLinksForEntity("nobody")).toEqual([]);
  });

  it("collects linked activity ids for exclusion from match results", () => {
    saveLink(link({ activityId: "act-1" }));
    saveLink(link({ entityId: "bill-1", entityType: "bill", activityId: "act-2" }));

    expect(getLinkedActivityIds()).toEqual(new Set(["act-1", "act-2"]));
  });

  it("agrees with linkKey() and with isLinked()", () => {
    saveLink(link());
    saveLink(link({ entityId: "bill-1", entityType: "bill", activityId: "act-3" }));

    const keys = getLinkKeys();
    expect(keys).toEqual(new Set(["sub-1|act-1", "bill-1|act-3"]));
    expect(keys.has(linkKey("sub-1", "act-1"))).toBe(true);
    expect(keys.has(linkKey("sub-1", "act-3"))).toBe(false);

    // getLinkKeys is the render-loop replacement for isLinked; they must not
    // disagree, or a row shows the wrong link state.
    for (const [entityId, activityId] of [
      ["sub-1", "act-1"],
      ["bill-1", "act-3"],
      ["sub-1", "act-3"],
      ["nobody", "act-1"],
    ] as const) {
      expect(keys.has(linkKey(entityId, activityId))).toBe(isLinked(entityId, activityId));
    }
  });

  it("keys are unambiguous for ids that share a prefix", () => {
    expect(linkKey("sub-1", "act-1")).not.toBe(linkKey("sub-1|act", "1"));
  });
});

describe("confidenceColor", () => {
  it("maps the documented thresholds", () => {
    expect(confidenceColor(1)).toBe(confidenceColor(0.8));
    expect(confidenceColor(0.79)).toBe(confidenceColor(0.6));
    expect(confidenceColor(0.59)).toBe(confidenceColor(0));
    expect(new Set([confidenceColor(0.9), confidenceColor(0.7), confidenceColor(0.1)]).size).toBe(3);
  });
});
