import { afterEach, describe, expect, it } from "vitest";
import { installBrowserGlobals, withLocalStorage } from "../browser-globals";
import {
  LINKS_KEY,
  SCHEMA_VERSION,
  exportData,
  flushWrites,
  getBills,
  getLogo,
  hydrateStorage,
  isHydrated,
  getSettings,
  getSubscriptions,
  getSyncLog,
  importData,
  runMigrations,
  saveBill,
  saveSettings,
  saveSubscription,
  setStorageErrorHandler,
  updateSyncLog,
  type Bill,
  type Subscription,
} from "../../src/lib/storage";

const storage = installBrowserGlobals();

const LEGACY_LINKS_KEY = "blink:links";
const SCHEMA_VERSION_KEY = "ss.schema-version";
const SUBS_KEY = "ss.subscriptions";

/** Put raw values in the host KV store (as a previous session would have left
 *  them) and boot the addon's storage layer from it. hydrateStorage() also runs
 *  the schema migrations, exactly as it does in the host. */
async function boot(seed: Record<string, unknown> = {}): Promise<void> {
  storage.reset();
  for (const [key, value] of Object.entries(seed)) {
    storage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  await hydrateStorage();
}

/** What the host actually holds, once every queued write has landed. */
async function stored(key: string): Promise<unknown> {
  await flushWrites();
  return readJSON(key);
}

function sub(over: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub-1",
    name: "Netflix",
    amount: 15.99,
    currency: "USD",
    billingCycle: "monthly",
    category: "Entertainment",
    active: true,
    startDate: "2026-01-31",
    ...over,
  };
}

function bill(over: Partial<Bill> = {}): Bill {
  return {
    id: "bill-1",
    name: "Electricity",
    amount: 82.4,
    currency: "EUR",
    category: "Electricity",
    date: "2026-02-01",
    paid: false,
    recurring: true,
    billingCycle: "monthly",
    ...over,
  };
}

function readJSON(key: string): unknown {
  const raw = storage.getItem(key);
  return raw === null ? null : JSON.parse(raw);
}

afterEach(() => {
  setStorageErrorHandler(null);
});

describe("schema migrations (run on hydrate)", () => {
  const legacyLink = {
    subscriptionId: "sub-1",
    activityId: "act-1",
    activityDate: "2026-01-31",
    amount: 15.99,
    currency: "USD",
    description: "NETFLIX",
    accountName: "Checking",
    linkedAt: "2026-02-01T00:00:00.000Z",
  };

  it("moves blink:links to ss.links and rewrites subscriptionId to entityId + entityType", async () => {
    await boot({ [LEGACY_LINKS_KEY]: [legacyLink] });

    expect(await stored(LINKS_KEY)).toEqual([
      {
        entityId: "sub-1",
        entityType: "subscription",
        activityId: "act-1",
        activityDate: "2026-01-31",
        amount: 15.99,
        currency: "USD",
        description: "NETFLIX",
        accountName: "Checking",
        linkedAt: "2026-02-01T00:00:00.000Z",
      },
    ]);
    // The legacy key must be gone, or a later re-run would resurrect deleted links.
    expect(storage.getItem(LEGACY_LINKS_KEY)).toBeNull();
    expect(readJSON(SCHEMA_VERSION_KEY)).toBe(SCHEMA_VERSION);
  });

  it("merges legacy links with existing links and de-duplicates by entity + activity", async () => {
    await boot({
      [LINKS_KEY]: [{ entityId: "sub-1", entityType: "subscription", activityId: "act-1" }],
      [LEGACY_LINKS_KEY]: [
        { subscriptionId: "sub-1", activityId: "act-1" }, // duplicate of the above
        { subscriptionId: "sub-2", activityId: "act-2" },
      ],
    });

    expect(await stored(LINKS_KEY)).toEqual([
      { entityId: "sub-1", entityType: "subscription", activityId: "act-1" },
      { entityId: "sub-2", entityType: "subscription", activityId: "act-2" },
    ]);
  });

  it("leaves already-migrated links untouched", async () => {
    const links = [{ entityId: "bill-1", entityType: "bill", activityId: "act-9", amount: 5 }];
    await boot({ [LEGACY_LINKS_KEY]: links });

    expect(await stored(LINKS_KEY)).toEqual(links);
  });

  it("is idempotent — booting twice changes nothing", async () => {
    await boot({ [LEGACY_LINKS_KEY]: [{ subscriptionId: "sub-1", activityId: "act-1" }] });
    const afterFirst = (await stored(LINKS_KEY)) as unknown;

    await hydrateStorage();
    await flushWrites();

    expect(readJSON(LINKS_KEY)).toEqual(afterFirst);
    expect(readJSON(SCHEMA_VERSION_KEY)).toBe(SCHEMA_VERSION);
  });

  it("does not re-run once the schema version is stamped, even if a legacy key reappears", async () => {
    await boot(); // stamps the version on a fresh install
    await flushWrites();
    storage.setItem(LEGACY_LINKS_KEY, JSON.stringify([{ subscriptionId: "zombie", activityId: "act-z" }]));

    await hydrateStorage();
    await flushWrites();

    expect(storage.getItem(LINKS_KEY)).toBeNull();
  });

  it("creates no links key when there is nothing to migrate", async () => {
    await boot();
    await flushWrites();
    expect(storage.getItem(LINKS_KEY)).toBeNull();
  });

  it("skips silently on a corrupt legacy payload", async () => {
    await expect(boot({ [LEGACY_LINKS_KEY]: "{not json" })).resolves.toBeUndefined();
    await flushWrites();

    expect(storage.getItem(LINKS_KEY)).toBeNull();
    expect(readJSON(SCHEMA_VERSION_KEY)).toBe(SCHEMA_VERSION);
  });

  it("reports a rejected write instead of throwing into the caller", async () => {
    await boot();
    await flushWrites();
    const seen: string[] = [];
    setStorageErrorHandler((_err, key) => seen.push(key));
    storage.failNextWrites(1);

    expect(() => runMigrations()).not.toThrow();
    await flushWrites();
    expect(seen).toEqual([SCHEMA_VERSION_KEY]);
  });
});

describe("hydration", () => {
  it("is not hydrated until the KV store has been read, then announces itself", async () => {
    storage.reset();
    let announced = 0;
    const onHydrated = () => announced++;
    window.addEventListener("ss:storage-hydrated", onHydrated);
    try {
      await hydrateStorage();
    } finally {
      window.removeEventListener("ss:storage-hydrated", onHydrated);
    }
    expect(isHydrated()).toBe(true);
    expect(announced).toBe(1);
  });

  it("loads what a previous session left in the host store", async () => {
    await boot({
      [SUBS_KEY]: [sub()],
      "ss.bills": [bill()],
      "ss.settings": { billsEnabled: false, syncAccountId: "acc-1" },
      "ss.synclog": { "sub-1:2026-01-31": "act-1" },
    });

    expect(getSubscriptions()).toEqual([sub()]);
    expect(getBills()).toEqual([bill()]);
    expect(getSettings()).toEqual({ billsEnabled: false, syncAccountId: "acc-1" });
    expect(getSyncLog()).toEqual({ "sub-1:2026-01-31": "act-1" });
  });

  it("loads the logos kept under their own keys", async () => {
    await boot({
      "ss.logo.sub.index": ["sub-1"],
      "ss.logo.sub.sub-1": "data:image/png;base64,AAAA",
    });
    expect(getLogo("sub", "sub-1")).toBe("data:image/png;base64,AAAA");
    expect(getLogo("sub", "nobody")).toBeNull();
  });

  it("survives a corrupt blob by treating that collection as empty", async () => {
    await boot({ [SUBS_KEY]: "{not json", "ss.bills": [bill()] });
    expect(getSubscriptions()).toEqual([]);
    expect(getBills()).toEqual([bill()]);
  });

  it("imports data a pre-3.6 install kept in localStorage, once, without overwriting the KV store", async () => {
    const restore = withLocalStorage({
      "ss:subscriptions": JSON.stringify([sub({ id: "from-ls" })]),
      "ss:bills": JSON.stringify([bill({ id: "from-ls" })]),
      "ss:links": JSON.stringify([{ entityId: "from-ls", entityType: "bill", activityId: "act-1" }]),
    });
    try {
      // The KV store already has bills, which must win over the stale copy.
      await boot({ "ss.bills": [bill({ id: "from-kv" })] });
    } finally {
      restore();
    }

    expect(getSubscriptions().map((s) => s.id)).toEqual(["from-ls"]);
    expect(getBills().map((b) => b.id)).toEqual(["from-kv"]);
    expect(await stored(LINKS_KEY)).toEqual([
      { entityId: "from-ls", entityType: "bill", activityId: "act-1" },
    ]);

    // Second boot: marker is set, so a changed localStorage is ignored.
    const restore2 = withLocalStorage({ "ss:subscriptions": JSON.stringify([sub({ id: "late" })]) });
    try {
      await hydrateStorage();
    } finally {
      restore2();
    }
    expect(getSubscriptions().map((s) => s.id)).toEqual(["from-ls"]);
  });

  it("works when localStorage is absent or throws (sandboxed iframe)", async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    Object.defineProperty(globals, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      await expect(boot({ [SUBS_KEY]: [sub()] })).resolves.toBeUndefined();
    } finally {
      delete globals.localStorage;
    }
    expect(getSubscriptions()).toEqual([sub()]);
  });
});

describe("exportData / importData", () => {
  it("round-trips every slice this addon owns", async () => {
    saveSubscription(sub());
    saveSubscription(sub({ id: "sub-2", name: "Spotify", currency: "EUR", amount: 9.99 }));
    saveBill(bill());
    await flushWrites();
    storage.setItem(
      LINKS_KEY,
      JSON.stringify([{ entityId: "sub-1", entityType: "subscription", activityId: "act-1" }]),
    );
    await hydrateStorage();
    saveSettings({ billsEnabled: false, syncAccountId: "acc-7" });
    updateSyncLog({ "sub-1:2026-01-31": "act-1" });

    const backup = exportData();
    const before = {
      subs: getSubscriptions(),
      bills: getBills(),
      links: JSON.parse(backup).links,
      settings: getSettings(),
      syncLog: getSyncLog(),
    };

    await flushWrites();
    storage.clear();
    await hydrateStorage(); // a fresh install
    expect(getSubscriptions()).toEqual([]);

    const summary = importData(backup);

    expect(summary).toEqual({ subscriptions: 2, bills: 1, links: 1 });
    expect(getSubscriptions()).toEqual(before.subs);
    expect(getBills()).toEqual(before.bills);
    expect(await stored(LINKS_KEY)).toEqual(before.links);
    expect(getSettings()).toEqual(before.settings);
    expect(getSyncLog()).toEqual(before.syncLog);
    expect(readJSON(SCHEMA_VERSION_KEY)).toBe(SCHEMA_VERSION);
  });

  it("exports a stable, self-describing envelope", () => {
    saveSubscription(sub());
    const payload = JSON.parse(exportData());
    expect(payload.schemaVersion).toBe(SCHEMA_VERSION);
    expect(typeof payload.exportedAt).toBe("string");
    expect(new Date(payload.exportedAt).toString()).not.toBe("Invalid Date");
    expect(payload.subscriptions).toHaveLength(1);
    expect(payload.links).toEqual([]);
  });

  it("upgrades pre-v2 links when restoring an old backup", async () => {
    // importData stamps the schema version, so the migrations never get a
    // second chance: if the import does not rewrite subscriptionId here, every
    // restored link is orphaned for good.
    const summary = importData(
      JSON.stringify({
        schemaVersion: 1,
        subscriptions: [],
        bills: [],
        links: [
          { subscriptionId: "sub-1", activityId: "act-1", amount: 15.99 },
          { entityId: "bill-1", entityType: "bill", activityId: "act-2" },
        ],
      }),
    );

    expect(summary.links).toBe(2);
    expect(await stored(LINKS_KEY)).toEqual([
      { entityId: "sub-1", entityType: "subscription", activityId: "act-1", amount: 15.99 },
      { entityId: "bill-1", entityType: "bill", activityId: "act-2" },
    ]);
    // Idempotent: re-importing the already-upgraded export changes nothing.
    const again = readJSON(LINKS_KEY);
    importData(exportData());
    expect(await stored(LINKS_KEY)).toEqual(again);
  });

  it("de-duplicates links on import", () => {
    const backup = JSON.stringify({
      subscriptions: [],
      bills: [],
      links: [
        { entityId: "a", activityId: "1" },
        { entityId: "a", activityId: "1" },
        { entityId: "a", activityId: "2" },
        "garbage",
      ],
    });

    expect(importData(backup).links).toBe(2);
  });

  for (const [label, payload] of [
    ["not JSON at all", "{ nope"],
    ["a JSON array", "[]"],
    ["a JSON scalar", "42"],
    ["null", "null"],
    ["an object with no lists", '{"exportedAt":"now"}'],
    ["subscriptions but no bills", '{"subscriptions":[]}'],
    ["a non-array subscriptions field", '{"subscriptions":{},"bills":[]}'],
  ] as const) {
    it(`throws a readable message for ${label} and leaves existing data untouched`, () => {
      saveSubscription(sub());
      saveBill(bill());

      expect(() => importData(payload)).toThrowError(/\w+/);
      expect(() => importData(payload)).toThrowError(
        /isn't valid JSON|isn't a Subscriptions & Bills backup|missing its subscriptions or bills/,
      );

      expect(getSubscriptions()).toEqual([sub()]);
      expect(getBills()).toEqual([bill()]);
    });
  }

  it("keeps default settings for a backup that omits them", () => {
    const summary = importData(JSON.stringify({ subscriptions: [], bills: [] }));
    expect(summary).toEqual({ subscriptions: 0, bills: 0, links: 0 });
    expect(getSettings()).toEqual({ billsEnabled: true, syncAccountId: null });
    expect(getSyncLog()).toEqual({});
  });
});

describe("write path", () => {
  it("reads your own write immediately, before the host has stored it", async () => {
    saveSubscription(sub());
    expect(getSubscriptions()).toEqual([sub()]); // synchronous, from the cache
    await flushWrites();
    expect(readJSON(SUBS_KEY)).toEqual([sub()]); // and the host got it
  });

  it("routes a rejected host write to the handler and rolls the cache back", async () => {
    const errors: Array<{ key: string; message: string }> = [];
    setStorageErrorHandler((err, key) =>
      errors.push({ key, message: err instanceof Error ? err.message : String(err) }),
    );
    storage.failNextWrites(1);

    expect(() => saveSubscription(sub())).not.toThrow();
    await flushWrites();

    expect(errors).toEqual([{ key: SUBS_KEY, message: "QuotaExceededError" }]);
    // The UI must not keep showing a row that will vanish on reload.
    expect(getSubscriptions()).toEqual([]);
    expect(storage.getItem(SUBS_KEY)).toBeNull();
  });

  it("does not roll back over a newer write to the same key", async () => {
    storage.failNextWrites(1);
    saveSubscription(sub({ id: "a", name: "A" })); // will be rejected
    saveSubscription(sub({ id: "b", name: "B" })); // newer snapshot, includes A
    await flushWrites();

    expect(getSubscriptions().map((s) => s.id)).toEqual(["b", "a"]);
    expect((readJSON(SUBS_KEY) as Subscription[]).map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("upserts by id and keeps newest-first order for new rows", () => {
    saveSubscription(sub({ id: "a", name: "A" }));
    saveSubscription(sub({ id: "b", name: "B" }));
    saveSubscription(sub({ id: "a", name: "A renamed" }));

    expect(getSubscriptions().map((s) => [s.id, s.name])).toEqual([
      ["b", "B"],
      ["a", "A renamed"],
    ]);
  });
});
