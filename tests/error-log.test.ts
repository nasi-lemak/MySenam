import { afterEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
// As in a server process: the request-error hook runs only there.
process.env.NEXT_RUNTIME = "nodejs";

import { NextRequest } from "next/server";
import { getDb } from "../src/lib/db";
import { fingerprint, listErrors, recordError, resolveError, scrub } from "../src/lib/error-log";
import { pruneOldData } from "../src/lib/privacy";
import { onRequestError } from "../src/instrumentation";
import { POST as report } from "../src/app/api/errors/route";

/**
 * Errors, grouped by kind with their stacks, from the server and from
 * customers' browsers; new kinds told to the owners; scrubbed of personal
 * details; optionally passed on to Sentry.
 */

const alerts = async () =>
  (await getDb().prepare("SELECT key, count FROM system_alerts ORDER BY key").all()) as { key: string; count: number }[];

function boom(message: string, frame = "at handler (/app/src/lib/store.ts:120:15)"): Error {
  const err = new TypeError(message);
  err.stack = `TypeError: ${message}\n    ${frame}\n    at run (/app/node_modules/next/dist/server.js:1:1)`;
  return err;
}

const send = (body: unknown) =>
  report(
    new NextRequest("http://localhost/api/errors", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify(body),
    })
  );

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SENTRY_DSN;
});

describe("what is kept", () => {
  it("has no email addresses or phone numbers in it", () => {
    expect(scrub("Booking for aisyah@example.my on 012-345 6789 failed")).toBe("Booking for [email] on [number] failed");
  });

  it("groups errors that differ only in their details", () => {
    const a = fingerprint({ source: "server", name: "TypeError", message: "Cannot read booking 42", stack: boom("x").stack });
    const b = fingerprint({ source: "server", name: "TypeError", message: "Cannot read booking 977", stack: boom("x", "at handler (/app/src/lib/store.ts:131:9)").stack });
    const c = fingerprint({ source: "server", name: "TypeError", message: "Cannot read booking 42", stack: boom("x", "at other (/app/src/lib/games.ts:5:1)").stack });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("a server error", () => {
  it("is filed with its stack, counted, and told to the owners once per kind", async () => {
    await onRequestError(boom("Cannot read properties of undefined (reading 'id')"), { path: "/api/bookings?code=MS-ABC123", method: "POST" });
    await onRequestError(boom("Cannot read properties of undefined (reading 'id')"), { path: "/api/bookings", method: "POST" });
    const [group] = await listErrors();
    expect(group).toMatchObject({ source: "server", name: "TypeError", count: 2, path: "/api/bookings", method: "POST" });
    expect(group.stack).toContain("store.ts");
    const told = (await alerts()).filter((a) => a.key.startsWith("error:"));
    expect(told).toHaveLength(1);
    expect(told[0].count).toBe(1);
  });

  it("comes back, and is told again, when it happens after being marked fixed", async () => {
    const [group] = await listErrors();
    expect(await resolveError(group.id)).toBe(true);
    expect(await listErrors()).toHaveLength(0);
    expect(await listErrors({ resolved: true })).toHaveLength(1);
    const again = await recordError({ source: "server", name: "TypeError", message: "Cannot read properties of undefined (reading 'id')", stack: boom("x").stack });
    expect(again).toMatchObject({ isNew: false, reopened: true });
    expect((await listErrors())[0]).toMatchObject({ id: group.id, count: 3, resolvedAt: null });
    expect((await alerts()).find((a) => a.key.startsWith("error:"))!.count).toBe(2);
  });
});

describe("a browser's report", () => {
  it("is filed, scrubbed and without its query string", async () => {
    const res = await send({ name: "RangeError", message: "Bad hour for siti@example.my", stack: "RangeError: x\n    at pick (https://x/_next/static/chunks/page.js:1:2)", path: "/my-booking?phone=0123456789" });
    expect(res.status).toBe(204);
    const group = (await listErrors()).find((e) => e.source === "browser")!;
    expect(group).toMatchObject({ name: "RangeError", message: "Bad hour for [email]", path: "/my-booking" });
    expect((await alerts()).map((a) => a.key)).toContain("errors:browser");
  });

  it("ignores what browsers report that is not ours, and needs a message", async () => {
    const before = (await listErrors()).length;
    expect((await send({ message: "Script error." })).status).toBe(204);
    expect((await send({ message: "boom", stack: "Error\n    at x (chrome-extension://abc/content.js:1:1)" })).status).toBe(204);
    expect((await send({ message: "ResizeObserver loop completed with undelivered notifications." })).status).toBe(204);
    expect((await send({})).status).toBe(400);
    expect(await listErrors()).toHaveLength(before);
  });
});

describe("Sentry", () => {
  it("is sent each error as an envelope when a DSN is set", async () => {
    process.env.SENTRY_DSN = "https://publickey123@o1.ingest.sentry.io/4507";
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: init.body });
      return new Response("{}");
    }));
    await recordError({ source: "server", name: "Error", message: "Gateway timed out", stack: boom("x").stack });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe("https://o1.ingest.sentry.io/api/4507/envelope/?sentry_key=publickey123&sentry_version=7");
    const [, item, event] = calls[0].body.split("\n").map((l) => JSON.parse(l));
    expect(item).toEqual({ type: "event" });
    expect(event.exception.values[0]).toMatchObject({ type: "Error", value: "Gateway timed out" });
    expect(event.exception.values[0].stacktrace.frames.at(-1)).toMatchObject({ function: "handler", filename: "/app/src/lib/store.ts" });
  });
});

describe("retention", () => {
  it("forgets an error 90 days after it last happened", async () => {
    await getDb().prepare("UPDATE error_events SET last_at = '2020-01-01 00:00:00'").run();
    await pruneOldData();
    expect(await listErrors()).toHaveLength(0);
    expect(await listErrors({ resolved: true })).toHaveLength(0);
  });
});
