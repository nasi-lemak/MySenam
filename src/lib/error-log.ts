import crypto from "crypto";
import { raiseAlert } from "./alerts";
import { aside, getDb, mustRethrow } from "./db";
import { siteName } from "./site";
import { said } from "./staff-text";

/**
 * Errors, grouped so they can be fixed: every server error from a request,
 * and every error a customer's browser reports, filed under a fingerprint of
 * what failed and where in the code, with a count, where it happened last and
 * its stack trace. The owner sees the list on the dashboard and marks each
 * fixed; one that happens again reopens.
 *
 * A new kind of server error is told to the owners as an alert of its own
 * (lib/alerts.ts). Browser errors are not, one by one — anybody can send one —
 * but together they are, at most every few hours.
 *
 * With `SENTRY_DSN` set, each one is also sent to Sentry (or anything that
 * speaks its envelope API, like GlitchTip), for teams that already live there.
 *
 * What is kept is scrubbed first: email addresses and long runs of digits
 * (phone numbers, card numbers) are replaced, and addresses lose their query
 * strings. Kept 90 days after it last happened (lib/privacy.ts).
 */

export type ErrorSource = "server" | "browser";

export interface ErrorInput {
  source: ErrorSource;
  name?: string;
  message: string;
  stack?: string | null;
  path?: string | null;
  method?: string | null;
  digest?: string | null;
}

export interface ErrorGroup {
  id: number;
  source: ErrorSource;
  name: string;
  message: string;
  stack: string | null;
  path: string | null;
  method: string | null;
  count: number;
  firstAt: string;
  lastAt: string;
  resolvedAt: string | null;
}

/** Personal details out of text that goes into a log. */
export function scrub(text: string): string {
  return text
    .replace(/[^\s@"'<>()]+@[^\s@"'<>()]+\.[a-z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s-]{7,}\d/g, "[number]");
}

/** A path without its query string or fragment, which may carry codes and tokens. */
function bare(path: string | null | undefined): string | null {
  if (!path) return null;
  return scrub(path.split(/[?#]/)[0]).slice(0, 300);
}

/**
 * What makes two errors the same one: the source, the kind, the message with
 * its variable parts taken out, and the first line of the stack that is ours.
 */
export function fingerprint(input: Pick<ErrorInput, "source" | "name" | "message" | "stack">): string {
  const message = input.message
    .replace(/\b[0-9a-f]{8,}\b/gi, "#")
    .replace(/\d+/g, "N")
    .replace(/(["'`]).*?\1/g, "S")
    .slice(0, 200);
  const frame =
    (input.stack ?? "")
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .find((l) => l && !l.includes("node_modules") && !l.includes("node:")) ?? "";
  // Line and column move with every edit; the file and function do not.
  const where = frame.replace(/:\d+:\d+\)?$/, "").replace(/\?[^)\s]*/, "");
  return crypto.createHash("sha256").update(`${input.source}|${input.name ?? "Error"}|${message}|${where}`).digest("hex").slice(0, 24);
}

/** File an error under its group. Never throws: a failure to log must not become the error. */
export async function recordError(input: ErrorInput): Promise<{ id: number; isNew: boolean; reopened: boolean } | null> {
  try {
    return await aside(async () => {
      const name = (input.name || "Error").slice(0, 100);
      const message = scrub(input.message || "(no message)").slice(0, 1000);
      const stack = input.stack ? scrub(input.stack).slice(0, 8000) : null;
      const fp = fingerprint({ ...input, name, message });
      const row = (await getDb()
        .prepare(
          // The CTE reads the row as it was before this statement, so a fixed one coming back is seen.
          `WITH before AS (SELECT resolved_at FROM error_events WHERE fingerprint = ?)
           INSERT INTO error_events (fingerprint, source, name, message, stack, path, method, digest)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (fingerprint) DO UPDATE SET
             count = error_events.count + 1, last_at = datetime('now'), message = excluded.message,
             stack = COALESCE(excluded.stack, error_events.stack), path = excluded.path, method = excluded.method,
             digest = excluded.digest, resolved_at = NULL
           RETURNING id, (xmax = 0) AS inserted, (SELECT resolved_at FROM before) IS NOT NULL AS reopened`
        )
        .get(fp, fp, input.source, name, message, stack, bare(input.path), input.method?.slice(0, 10) ?? null, input.digest?.slice(0, 100) ?? null)) as {
        id: number;
        inserted: boolean;
        reopened: boolean;
      };
      const isNew = row.inserted === true;
      const reopened = !isNew && row.reopened === true;
      if (input.source === "server" && (isNew || reopened))
        await raiseAlert(
          `error:${fp}`,
          said(reopened ? "srv.alert.backAgain" : "srv.alert.newError", { name, message: message.slice(0, 120) }),
          [`${input.method ?? ""} ${bare(input.path) ?? ""}`.trim(), stack?.split("\n").slice(0, 6).join("\n") ?? message].join("\n")
        );
      else if (input.source === "browser")
        await raiseAlert("errors:browser", said("srv.alert.browser"), `${name}: ${message}\n${bare(input.path) ?? ""}`);
      void toSentry({ ...input, name, message, stack, path: bare(input.path) });
      return { id: row.id, isNew, reopened };
    });
  } catch (err) {
    if (mustRethrow(err)) throw err;
    console.error("[mysenam] could not record an error:", err);
    return null;
  }
}

export async function listErrors(opts: { resolved?: boolean } = {}): Promise<ErrorGroup[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT * FROM error_events WHERE ${opts.resolved ? "resolved_at IS NOT NULL" : "resolved_at IS NULL"}
        ORDER BY last_at DESC LIMIT 100`
    )
    .all()) as {
    id: number;
    source: ErrorSource;
    name: string;
    message: string;
    stack: string | null;
    path: string | null;
    method: string | null;
    count: number;
    first_at: string;
    last_at: string;
    resolved_at: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    name: r.name,
    message: r.message,
    stack: r.stack,
    path: r.path,
    method: r.method,
    count: r.count,
    firstAt: r.first_at,
    lastAt: r.last_at,
    resolvedAt: r.resolved_at,
  }));
}

/** Marked fixed: off the list until it happens again. */
export async function resolveError(id: number): Promise<boolean> {
  const done = await getDb().prepare("UPDATE error_events SET resolved_at = datetime('now') WHERE id = ? AND resolved_at IS NULL").run(id);
  return done.changes === 1;
}

/**
 * Send it on to Sentry's envelope endpoint, when a DSN is configured: no SDK,
 * one request, given up on after a few seconds.
 */
async function toSentry(e: ErrorInput & { name: string }): Promise<void> {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return;
  try {
    const url = new URL(dsn);
    const project = url.pathname.replace(/^\/+/, "");
    const endpoint = `${url.protocol}//${url.host}/api/${project}/envelope/?sentry_key=${encodeURIComponent(url.username)}&sentry_version=7`;
    const eventId = crypto.randomUUID().replace(/-/g, "");
    const event = {
      event_id: eventId,
      timestamp: Date.now() / 1000,
      platform: "javascript",
      level: "error",
      server_name: siteName(),
      environment: process.env.NODE_ENV ?? "production",
      tags: { source: e.source },
      exception: { values: [{ type: e.name, value: e.message, ...(e.stack ? { stacktrace: { frames: framesOf(e.stack) } } : {}) }] },
      ...(e.path ? { request: { url: e.path, method: e.method ?? undefined } } : {}),
    };
    const body = [JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }), JSON.stringify({ type: "event" }), JSON.stringify(event)].join("\n");
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body,
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    console.error("[mysenam] could not send an error to Sentry:", err instanceof Error ? err.message : err);
  }
}

/** A V8 stack as Sentry's frames, innermost last. */
function framesOf(stack: string): { function?: string; filename?: string; lineno?: number; colno?: number }[] {
  return stack
    .split("\n")
    .slice(1)
    .map((line) => {
      const m = line.trim().match(/^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
      return m ? { function: m[1], filename: m[2], lineno: Number(m[3]), colno: Number(m[4]) } : null;
    })
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .reverse();
}
