import { beforeEach } from "vitest";
import { installBrowserGlobals } from "./browser-globals";
import { hydrateStorage } from "../src/lib/storage";

// Installed at setup time — before any test module (and therefore before
// @wealthfolio/addon-sdk, which touches `window` while it is evaluated) loads.
const kv = installBrowserGlobals();

// One shared store, wiped between tests, so no test file has to shim it and no
// test can leak state into the next one. Re-hydrating from the now-empty store
// also clears storage.ts's in-memory cache and the pending-write queue's effects.
beforeEach(async () => {
  kv.reset();
  await hydrateStorage();
});
