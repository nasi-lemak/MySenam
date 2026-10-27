/**
 * Loaded into the acceptance server only (NODE_OPTIONS, set by
 * tests/uat/gateway.ts), never by the app: requests the app makes to Billplz's
 * sandbox go to the acceptance stand-in on the loopback instead. Nothing else
 * is touched, Billplz's live host included, and without UAT_BILLPLZ_STAND_IN
 * this does nothing.
 */
const standIn = process.env.UAT_BILLPLZ_STAND_IN;
const SANDBOX = "https://www.billplz-sandbox.com/";

if (standIn && typeof globalThis.fetch === "function") {
  const original = globalThis.fetch;
  globalThis.fetch = function fetchThroughStandIn(input, init) {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    if (typeof href === "string" && href.startsWith(SANDBOX)) {
      const target = `http://${standIn}/${href.slice(SANDBOX.length)}`;
      return original(typeof input === "string" || input instanceof URL ? target : new Request(target, input), init);
    }
    return original(input, init);
  };
}
