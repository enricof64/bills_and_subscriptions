/**
 * The host surface the addon's data layer needs, installed once per test process.
 * Imported by test/setup.ts (which resets the store between tests) and by any
 * test that wants a handle on the store itself.
 *
 * storage.ts talks to the host's async KV store (ctx.api.storage), so the tests
 * install a fake AddonContext whose storage is the in-memory `MemoryStorage`
 * below. It is deliberately NOT exposed as `localStorage`: the real sandboxed
 * host has none, and a test that passes only because localStorage exists is a
 * test of the wrong thing. (`withLocalStorage` opts in for the one migration
 * that reads it.)
 *
 * Provided here rather than by switching to a DOM environment because nothing
 * under test renders: storage.ts needs a `window` that can dispatch events, and
 * @wealthfolio/addon-sdk reads `window` at module scope.
 */
import type { AddonContext } from "@wealthfolio/addon-sdk";
import { setContext } from "../src/context";

export interface MemoryStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  /** Make the next `count` host writes (storage.set) reject, to exercise quota handling. */
  failNextWrites(count: number, err?: unknown): void;
  /** Back to empty and non-failing. */
  reset(): void;
  /** Consume one pending write failure; throws it if one is armed. */
  consumeWriteFailure(): void;
}

function createMemoryStorage(): MemoryStorage {
  const entries = new Map<string, string>();
  let failuresLeft = 0;
  let failure: unknown = new Error("QuotaExceededError");

  return {
    get length() {
      return entries.size;
    },
    key(index) {
      return [...entries.keys()][index] ?? null;
    },
    getItem(key) {
      const value = entries.get(String(key));
      return value === undefined ? null : value;
    },
    setItem(key, value) {
      entries.set(String(key), String(value));
    },
    removeItem(key) {
      entries.delete(String(key));
    },
    clear() {
      entries.clear();
    },
    failNextWrites(count, err) {
      failuresLeft = count;
      if (err !== undefined) failure = err;
    },
    consumeWriteFailure() {
      if (failuresLeft > 0) {
        failuresLeft--;
        throw failure;
      }
    },
    reset() {
      entries.clear();
      failuresLeft = 0;
    },
  };
}

let installed: MemoryStorage | null = null;

function createFakeContext(kv: MemoryStorage): AddonContext {
  const api = {
    storage: {
      async get(key: string) {
        return kv.getItem(key);
      },
      async set(key: string, value: string) {
        kv.consumeWriteFailure();
        kv.setItem(key, value);
      },
      async delete(key: string) {
        kv.removeItem(key);
      },
    },
    // No legacy secrets in tests unless a test arranges them.
    secrets: {
      async get() {
        return null;
      },
      async set() {},
      async delete() {},
    },
    logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} },
    toast: { error() {}, success() {}, info() {}, warning() {} },
  };
  return { api } as unknown as AddonContext;
}

/** Idempotent: repeated calls return the same store that is already installed. */
export function installBrowserGlobals(): MemoryStorage {
  if (installed) return installed;

  const kv = createMemoryStorage();
  const globals = globalThis as unknown as Record<string, unknown>;

  // A real EventTarget, so onDataChanged/persist notifications behave as they
  // do in the host instead of being swallowed by a stub.
  const win = (globals.window as Record<string, unknown> | undefined) ?? (new EventTarget() as unknown as Record<string, unknown>);
  globals.window = win;

  setContext(createFakeContext(kv));

  installed = kv;
  return kv;
}

/** Expose a plain localStorage holding `entries` for the duration of the returned restore(). */
export function withLocalStorage(entries: Record<string, string>): () => void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const map = new Map(Object.entries(entries));
  globals.localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  return () => {
    delete globals.localStorage;
  };
}
