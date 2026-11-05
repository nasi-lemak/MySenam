import crypto from "crypto";
import { getDb, mustRethrow } from "./db";
import { bookingOfSource, salesJournal, type Category, type JournalRow } from "./accounting";
import { ProviderError, type AccountingProvider, type ChartAccount, type ChartTaxRate, type DocumentToSend, type Session } from "./accounting-provider";
import { tellVenueStaffEach } from "./owner-alerts";
import { region } from "./region";
import { seal, unseal } from "./secrets";
import { addDays, localDateOf } from "./time";
import { venueZoneOf } from "./zones";
import { xero } from "./xero";

/**
 * A venue's sales, pushed live to its accounting package (ADR 0041; docs/integrations/xero.md).
 *
 * What is pushed is the sales journal (lib/accounting.ts), row for row, so the numbers cannot differ from the export:
 * a paid sale becomes a sales invoice with its payment, a refund or void becomes a credit note with its refund, never
 * an edit of what was sent. The export stays as it was, and is the way for SQL Account and AutoCount, which have no
 * common cloud API.
 *
 * - **Off by default, per venue, and only where the install allows it.** The install must set
 *   `ACCOUNTING_PUSH_APPROVED` (as off-site backups abroad need `OFFSITE_TRANSFER_APPROVED`) and register its app
 *   (`XERO_*`); then a manager connects the venue's own organisation after acknowledging what is sent. Nothing is read
 *   from the package but its chart of accounts and tax rates; no webhook is used.
 * - **Never guessed.** Income by kind of sale, tax rates and ways of paying are mapped by the manager to the package's own
 *   accounts and tax types; a sale with a part unmapped is *held* and listed, and is sent once it is mapped.
 * - **Reliable.** One queue row per journal row, unique by `source_ref`, worked through in steps whose results are kept as
 *   they land; the package's own Idempotency-Key and the document's number make a replay after a crash harmless; failures
 *   back off, 429 pauses the venue until Xero says, 401 refreshes once and then asks for a reconnect; the venue's managers
 *   are told when it has been failing for a day.
 * - **Money in cents**, never floats; the tax as each receipt computed it.
 * - **Minimal personal data.** The contact is the account holder's name and email, read at the moment of sending and never
 *   stored; a customer without an account is one "walk-in" contact; a child is never named (an account holder is an adult,
 *   a child's sale is under the account that paid for it, lib/participants.ts); no phone number; a line says what kind of
 *   sale and never whom it was for. The queue holds none of it.
 */

/** The wording of what is sent, as the dashboard shows it before a manager agrees. Bump it when what is sent changes. */
export const NOTICE_VERSION = 1;

/** The contact a customer without an account is booked under. */
export const WALK_IN = "Walk-in customers";

/** Transient failures are tried again this often at most, then the sale is left to a manager. */
export const MAX_ATTEMPTS = 8;
/** How long a claimed sale is left to its taker before another may take it (a crash mid-send). */
export const LEASE_SECONDS = 300;
/** The journal is read for new sales no more often than this. */
export const SCAN_EVERY_SECONDS = 300;
/** A day in which nothing got through, or a sale left failed, and the venue's managers are told. */
export const FAILING_ALERT_HOURS = 24;
/** How far back a start date may be chosen. */
export const MAX_BACKFILL_DAYS = 800;

const ms = (s: number) => s * 1000;
const iso = (d: Date) => d.toISOString();
const stamp = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const at = (v: unknown): number => (v === null || v === undefined ? 0 : v instanceof Date ? v.getTime() : new Date(String(v)).getTime());

/** What a refusal says, in English as sent; staff read the translations (lib/staff-i18n/refusals-2.ts). */
export const REFUSALS = {
  off: "Live accounting is not switched on for this install.",
  notConfigured: "This install has not registered its Xero app yet.",
  notAcknowledged: "Read what is sent and where Xero keeps it, and tick that the venue agrees, before connecting.",
  staleNotice: "What is sent has changed since this page loaded. Read it again, then tick that the venue agrees.",
  badState: "That sign-in did not start here or has run out. Start connecting again.",
  otherPerson: "Another member of staff began that sign-in. Start connecting again yourself.",
  declined: "Xero did not give access. Nothing was connected.",
  oneOrganisation: "Connect exactly one Xero organisation: the venue's own. Nothing was connected.",
  currency: "That organisation keeps its books in another currency than this site's. Nothing was connected.",
  signIn: "Xero would not complete the sign-in. Nothing was connected.",
  notConnected: "Connect the venue's Xero organisation first.",
  loadFirst: "Load the accounts and tax rates from Xero first.",
  noAccount: "Xero has no account with that code.",
  notIncome: "Income goes to an income account in Xero.",
  notLiability: "Money held for customers goes to a liability account in Xero, not income.",
  noPayment: "That account cannot take payments in Xero.",
  noTaxType: "Xero has no tax type with that code.",
  taxRate: "That Xero tax type is not at this rate.",
  taxNone: "A sale with no tax needs a Xero tax type at 0%.",
  badKey: "That is not something that is mapped.",
  badDate: "Give the day to send from, as a date.",
  tooEarly: "That day is too far back.",
  laterThanStart: "Sales are already sent from an earlier day. Pick that day or an earlier one.",
  previewChanged: "What would be sent has changed since the preview. Check it again.",
  nothingToRetry: "That sale cannot be sent again.",
  xeroDown: "Xero could not be reached. Try again in a few minutes.",
} as const;
export type Refusal = (typeof REFUSALS)[keyof typeof REFUSALS];

type Fail = { ok: false; error: Refusal | string };

/**
 * A short code for why a sign-in at Xero did not finish, which is what the dashboard is sent back with (never the sentence: an
 * address can be made up by anybody, so what it says is chosen from a list the dashboard knows).
 */
export function whyCode(error: string): string {
  const codes: [string, string][] = [
    [REFUSALS.declined, "declined"],
    [REFUSALS.otherPerson, "other_person"],
    [REFUSALS.oneOrganisation, "one_organisation"],
    [REFUSALS.currency, "currency"],
    [REFUSALS.signIn, "sign_in"],
  ];
  return codes.find(([sentence]) => sentence === error)?.[1] ?? "bad_state";
}

// ------------------------------------------------------------------ what the install allows

/** The install's switch (like `OFFSITE_TRANSFER_APPROVED`): without it nothing is offered and nothing is sent. */
export function pushApproved(): boolean {
  return /^(yes|true|1)$/i.test(process.env.ACCOUNTING_PUSH_APPROVED?.trim() ?? "");
}

const provider: AccountingProvider = xero;

export function pushAvailability(): { approved: boolean; configured: boolean } {
  return { approved: pushApproved(), configured: provider.configured() };
}

const offered = () => pushApproved() && provider.configured();

// ------------------------------------------------------------------ what is mapped

/** The journal's categories, which are the kinds of sale a manager maps to income (or, for the two owed ones, a liability). */
export const ACCOUNT_KEYS: Category[] = [
  "Court hire",
  "Classes",
  "Coaching",
  "Memberships",
  "Passes",
  "Tournament entries",
  "League fees",
  "Game shares",
  "Stored credit",
  "Gift vouchers",
  "Counter sales",
  "Hire deposits kept",
  "Hire: damage and loss",
  "Hire: extra charges",
  "Hire: penalties",
  "Other",
];
/** Money held for customers until spent: a liability in the books, as the export says, not income. */
export const OWED_KEYS: Category[] = ["Stored credit", "Gift vouchers"];
/** How a sale was paid, as the journal says (lib/types.ts PaidVia and `counter`), and `none` for not recorded. */
export const PAYMENT_KEYS = ["cash", "qr", "transfer", "card", "online", "credit", "counter", "none"] as const;

/** The tax a row carries: its rate, or none. */
export function taxKeyOf(rate: number | string | null | undefined): string {
  const r = rate === null || rate === undefined ? 0 : Number(rate);
  return r > 0 ? `rate:${Number(r.toFixed(2))}` : "none";
}
const paymentKeyOf = (method: string | null): string => ((PAYMENT_KEYS as readonly string[]).includes(method ?? "") ? method! : "none");

export interface MappingEntry {
  code: string;
  name: string | null;
}
export interface Mapping {
  account: Record<string, MappingEntry>;
  tax: Record<string, MappingEntry>;
  payment: Record<string, MappingEntry>;
}

export async function loadMapping(venueId: number): Promise<Mapping> {
  const rows = (await getDb().prepare("SELECT kind, key, code, name FROM accounting_mappings WHERE venue_id = ?").all(venueId)) as { kind: keyof Mapping; key: string; code: string; name: string | null }[];
  const out: Mapping = { account: {}, tax: {}, payment: {} };
  for (const r of rows) out[r.kind][r.key] = { code: r.code, name: r.name };
  return out;
}

export interface Chart {
  accounts: ChartAccount[];
  taxRates: ChartTaxRate[];
  fetchedAt: string | null;
}

export async function loadChart(venueId: number): Promise<Chart> {
  const rows = (await getDb().prepare("SELECT kind, body, fetched_at FROM accounting_chart WHERE venue_id = ?").all(venueId)) as { kind: string; body: string; fetched_at: unknown }[];
  const chart: Chart = { accounts: [], taxRates: [], fetchedAt: null };
  for (const r of rows) {
    try {
      if (r.kind === "account") chart.accounts = JSON.parse(r.body) as ChartAccount[];
      else chart.taxRates = JSON.parse(r.body) as ChartTaxRate[];
      chart.fetchedAt = stamp(r.fetched_at);
    } catch {
      // A chart that cannot be read is no chart: it is loaded again.
    }
  }
  return chart;
}

/** The tax rates the venue's sales have carried (and its current one), which the mapping needs a tax type for. */
export async function taxKeysInUse(venueId: number): Promise<string[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT DISTINCT tax_rate FROM accounting_queue WHERE venue_id = ?
       UNION SELECT tax_rate FROM venues WHERE id = ? AND tax_registered = 1`
    )
    .all(venueId, venueId)) as { tax_rate: number | string | null }[];
  return [...new Set(["none", ...rows.map((r) => taxKeyOf(r.tax_rate))])].sort((a, b) => (a === "none" ? -1 : b === "none" ? 1 : Number(a.slice(5)) - Number(b.slice(5))));
}

/**
 * Save what a manager chose: `{ account: { "Court hire": "200" }, tax: { "rate:8": "OUTPUT" }, payment: { cash: "090" } }`,
 * each code checked against the chart last read from the package (an income account for income, a liability for what is
 * owed, an account that takes payments, a tax type at that very rate); an empty code removes the choice. Held sales that
 * are now mapped are released.
 */
export async function saveMapping(venueId: number, input: Record<string, unknown>): Promise<{ ok: true; mapping: Mapping } | Fail> {
  const chart = await loadChart(venueId);
  if (chart.accounts.length === 0 && chart.taxRates.length === 0) return { ok: false, error: REFUSALS.loadFirst };
  const writes: { kind: keyof Mapping; key: string; code: string; name: string | null }[] = [];
  const removals: { kind: keyof Mapping; key: string }[] = [];
  for (const kind of ["account", "tax", "payment"] as const) {
    const given = input[kind];
    if (given === undefined) continue;
    if (!given || typeof given !== "object" || Array.isArray(given)) return { ok: false, error: REFUSALS.badKey };
    for (const [key, raw] of Object.entries(given as Record<string, unknown>)) {
      const code = typeof raw === "string" ? raw.trim() : "";
      const knownKey =
        kind === "account" ? (ACCOUNT_KEYS as string[]).includes(key) : kind === "payment" ? (PAYMENT_KEYS as readonly string[]).includes(key) : key === "none" || /^rate:\d+(\.\d+)?$/.test(key);
      if (!knownKey || typeof raw !== "string" || code.length > 60) return { ok: false, error: REFUSALS.badKey };
      if (code === "") {
        removals.push({ kind, key });
        continue;
      }
      if (kind === "tax") {
        const type = chart.taxRates.find((t) => t.type === code);
        if (!type) return { ok: false, error: REFUSALS.noTaxType };
        if (key === "none" ? type.rate !== 0 : Math.abs(type.rate - Number(key.slice(5))) > 0.005) return { ok: false, error: key === "none" ? REFUSALS.taxNone : REFUSALS.taxRate };
        writes.push({ kind, key, code, name: type.name });
        continue;
      }
      const account = chart.accounts.find((a) => a.code === code);
      if (!account) return { ok: false, error: REFUSALS.noAccount };
      if (kind === "payment" && !account.acceptsPayments) return { ok: false, error: REFUSALS.noPayment };
      if (kind === "account") {
        const owed = (OWED_KEYS as string[]).includes(key);
        if (owed && account.class !== "LIABILITY") return { ok: false, error: REFUSALS.notLiability };
        if (!owed && account.class !== "REVENUE") return { ok: false, error: REFUSALS.notIncome };
      }
      writes.push({ kind, key, code, name: account.name });
    }
  }
  const db = getDb();
  await db.transaction(async () => {
    for (const r of removals) await db.prepare("DELETE FROM accounting_mappings WHERE venue_id = ? AND kind = ? AND key = ?").run(venueId, r.kind, r.key);
    for (const w of writes)
      await db
        .prepare(
          `INSERT INTO accounting_mappings (venue_id, kind, key, code, name) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (venue_id, kind, key) DO UPDATE SET code = excluded.code, name = excluded.name`
        )
        .run(venueId, w.kind, w.key, w.code, w.name);
  })();
  await classify(venueId, new Date());
  return { ok: true, mapping: await loadMapping(venueId) };
}

// ------------------------------------------------------------------ the connection

interface ConnectionRow {
  venue_id: number;
  status: "connected" | "needs_reconnect" | "disconnected";
  tenant_id: string | null;
  connection_id: string | null;
  tenant_name: string | null;
  base_currency: string | null;
  access_token: string | null;
  refresh_token: string | null;
  access_expires_at: unknown;
  refreshing_until: unknown;
  paused_until: unknown;
  start_date: string;
  scanned_through: string | null;
  scanned_at: unknown;
  connected_at: unknown;
  connected_by_name: string;
  acknowledged_at: unknown;
  acknowledged_by_name: string;
  notice_version: number;
  last_ok_at: unknown;
  failing_since: unknown;
  last_alert_at: unknown;
}

async function connectionRow(venueId: number): Promise<ConnectionRow | undefined> {
  return (await getDb().prepare("SELECT * FROM accounting_connections WHERE venue_id = ?").get(venueId)) as ConnectionRow | undefined;
}

/** The venue's today on its own calendar. */
async function venueDay(venueId: number, now: Date): Promise<string> {
  const v = (await getDb().prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(venueId)) as { time_zone: string | null; lat: number | null; lng: number | null } | undefined;
  return localDateOf(iso(now), venueZoneOf(v ?? {}));
}

export interface ConnectionView {
  available: { approved: boolean; configured: boolean };
  noticeVersion: number;
  status: ConnectionRow["status"] | "not_connected";
  organisation: string | null;
  connectedAt: string | null;
  connectedBy: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  startDate: string | null;
  lastOkAt: string | null;
  failingSince: string | null;
  pausedUntil: string | null;
}

/** What the dashboard may know of the connection: never a token, a secret or an identifier of the organisation. */
export async function connectionView(venueId: number): Promise<ConnectionView> {
  const c = await connectionRow(venueId);
  return {
    available: pushAvailability(),
    noticeVersion: NOTICE_VERSION,
    status: c ? c.status : "not_connected",
    organisation: c && c.status !== "disconnected" ? c.tenant_name : null,
    connectedAt: c && c.status !== "disconnected" ? stamp(c.connected_at) : null,
    connectedBy: c && c.status !== "disconnected" ? c.connected_by_name : null,
    acknowledgedAt: c && c.status !== "disconnected" ? stamp(c.acknowledged_at) : null,
    acknowledgedBy: c && c.status !== "disconnected" ? c.acknowledged_by_name : null,
    startDate: c && c.status !== "disconnected" ? c.start_date : null,
    lastOkAt: c ? stamp(c.last_ok_at) : null,
    failingSince: c && c.status !== "disconnected" ? stamp(c.failing_since) : null,
    pausedUntil: c && c.status === "connected" && at(c.paused_until) > Date.now() ? stamp(c.paused_until) : null,
  };
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const b64url = (b: Buffer) => b.toString("base64url");

/**
 * Start connecting: records that the venue read the notice (who, when, which wording) with the sign-in in progress, and
 * answers the address to send the manager to at Xero. The venue's own acknowledgement; the app does not judge whether
 * sending the data abroad is lawful (docs/architecture/privacy.md#live-accounting-push).
 */
export async function beginConnect(
  venueId: number,
  admin: { id: number; name: string },
  input: { acknowledged: unknown; noticeVersion: unknown },
  now = new Date()
): Promise<{ ok: true; url: string } | Fail> {
  if (!pushApproved()) return { ok: false, error: REFUSALS.off };
  if (!provider.configured()) return { ok: false, error: REFUSALS.notConfigured };
  if (input.acknowledged !== true) return { ok: false, error: REFUSALS.notAcknowledged };
  if (input.noticeVersion !== NOTICE_VERSION) return { ok: false, error: REFUSALS.staleNotice };
  const state = b64url(crypto.randomBytes(32));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const db = getDb();
  await db.prepare("DELETE FROM accounting_oauth_states WHERE expires_at < ?").run(iso(now));
  await db
    .prepare(
      `INSERT INTO accounting_oauth_states (state_hash, venue_id, admin_id, admin_name, verifier, acknowledged_at, notice_version, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(sha(state), venueId, admin.id, admin.name, seal(verifier), iso(now), NOTICE_VERSION, iso(now), iso(new Date(now.getTime() + ms(15 * 60))));
  return { ok: true, url: provider.authorizeUrl({ state, challenge }) };
}

/**
 * The address Xero sends the manager back to: the one-time state is checked and spent, the code is traded for tokens (sealed
 * at once), exactly one organisation must have been chosen, and its books must be in this site's currency.
 */
export async function finishConnect(
  input: { code: string | null; state: string | null; denied: boolean },
  admin: { id: number; name: string },
  canManage: (venueId: number) => boolean,
  now = new Date()
): Promise<{ ok: true; venueId: number; organisation: string } | (Fail & { venueId: number | null })> {
  if (!input.state) return { ok: false, error: REFUSALS.badState, venueId: null };
  const db = getDb();
  // Used once: taken out as it is read, so a replayed address finds nothing.
  const pending = (await db.prepare("DELETE FROM accounting_oauth_states WHERE state_hash = ? RETURNING *").get(sha(input.state))) as
    | { venue_id: number; admin_id: number | null; admin_name: string; verifier: string; acknowledged_at: unknown; notice_version: number; expires_at: unknown }
    | undefined;
  if (!pending || at(pending.expires_at) < now.getTime()) return { ok: false, error: REFUSALS.badState, venueId: pending?.venue_id ?? null };
  const venueId = pending.venue_id;
  if (!canManage(venueId)) return { ok: false, error: REFUSALS.badState, venueId: null };
  if (pending.admin_id !== admin.id) return { ok: false, error: REFUSALS.otherPerson, venueId };
  if (input.denied || !input.code) return { ok: false, error: REFUSALS.declined, venueId };
  const verifier = unseal(pending.verifier);
  if (!verifier) return { ok: false, error: REFUSALS.badState, venueId };

  let tokens;
  try {
    tokens = await provider.exchangeCode({ code: input.code, verifier });
  } catch {
    return { ok: false, error: REFUSALS.signIn, venueId };
  }
  const leave = async (organisations: { connectionId: string }[]): Promise<void> => {
    // Nothing is kept of a sign-in that is refused: the grant is given back at once.
    for (const o of organisations) await provider.revoke({ refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, connectionId: o.connectionId });
    if (organisations.length === 0) await provider.revoke({ refreshToken: tokens.refreshToken, accessToken: null, connectionId: null });
  };
  let organisations;
  try {
    organisations = await provider.organisations(tokens.accessToken);
  } catch {
    await leave([]);
    return { ok: false, error: REFUSALS.signIn, venueId };
  }
  if (organisations.length !== 1) {
    await leave(organisations);
    return { ok: false, error: REFUSALS.oneOrganisation, venueId };
  }
  const org = organisations[0];
  let details;
  try {
    details = await provider.organisation({ accessToken: tokens.accessToken, tenantId: org.tenantId });
  } catch {
    await leave(organisations);
    return { ok: false, error: REFUSALS.signIn, venueId };
  }
  if (details.currency !== region().currency.code) {
    await leave(organisations);
    return { ok: false, error: REFUSALS.currency, venueId };
  }

  const before = await connectionRow(venueId);
  // Mending a connection to the same organisation (it asked to be reconnected) keeps what was sent from and read through,
  // so nothing between is lost; a first connection, or one to another organisation, starts today.
  const keep = before && before.status !== "disconnected" && before.tenant_id === org.tenantId;
  const today = await venueDay(venueId, now);
  await db
    .prepare(
      `INSERT INTO accounting_connections (venue_id, provider, status, tenant_id, connection_id, tenant_name, base_currency, access_token, refresh_token,
         access_expires_at, scopes, start_date, scanned_through, scanned_at, connected_at, connected_by_admin_id, connected_by_name, acknowledged_at,
         acknowledged_by_name, notice_version, failing_since, last_alert_at, paused_until, refreshing_until, disconnected_at, updated_at)
       VALUES (?, 'xero', 'connected', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)
       ON CONFLICT (venue_id) DO UPDATE SET status = 'connected', tenant_id = excluded.tenant_id, connection_id = excluded.connection_id,
         tenant_name = excluded.tenant_name, base_currency = excluded.base_currency, access_token = excluded.access_token,
         refresh_token = excluded.refresh_token, access_expires_at = excluded.access_expires_at, scopes = excluded.scopes,
         start_date = excluded.start_date, scanned_through = ${keep ? "accounting_connections.scanned_through" : "NULL"}, scanned_at = NULL,
         connected_at = excluded.connected_at, connected_by_admin_id = excluded.connected_by_admin_id, connected_by_name = excluded.connected_by_name,
         acknowledged_at = excluded.acknowledged_at, acknowledged_by_name = excluded.acknowledged_by_name, notice_version = excluded.notice_version,
         failing_since = NULL, last_alert_at = NULL, paused_until = NULL, refreshing_until = NULL, disconnected_at = NULL, updated_at = excluded.updated_at`
    )
    .run(
      venueId,
      org.tenantId,
      org.connectionId,
      details.name || org.name,
      details.currency,
      seal(tokens.accessToken),
      seal(tokens.refreshToken),
      iso(new Date(now.getTime() + ms(tokens.expiresInSeconds))),
      tokens.scopes,
      keep ? before!.start_date : today,
      iso(now),
      admin.id,
      admin.name,
      stamp(pending.acknowledged_at),
      pending.admin_name,
      pending.notice_version,
      iso(now)
    );
  // The grant this one replaces is given up at Xero, so connecting again never leaves an old one alive (its connection is
  // left alone where Xero gave the same one again).
  const oldRefresh = before && before.status !== "disconnected" && before.refresh_token ? unseal(before.refresh_token) : null;
  if (oldRefresh)
    await provider.revoke({
      refreshToken: oldRefresh,
      accessToken: before!.access_token ? unseal(before!.access_token) : null,
      connectionId: before!.connection_id === org.connectionId ? null : before!.connection_id,
    });
  // The organisation's lists, for the mapping screen.
  await refreshChart(venueId, now).catch(() => undefined);
  return { ok: true, venueId, organisation: details.name || org.name };
}

/** Disconnect: the grant is given up at the package, both tokens are emptied, and what was never sent is left unsent. */
export async function disconnect(venueId: number, now = new Date()): Promise<{ ok: true; revoked: boolean } | Fail> {
  const c = await connectionRow(venueId);
  if (!c || c.status === "disconnected") return { ok: false, error: REFUSALS.notConnected };
  let revoked = false;
  const refresh = c.refresh_token ? unseal(c.refresh_token) : null;
  if (refresh && provider.configured()) {
    // A current access token, where one can be had, so the organisation's connection is removed as well as the grant.
    const fresh = await session(venueId, now, false).catch(() => null);
    const access = fresh?.accessToken ?? (c.access_token ? unseal(c.access_token) : null);
    const latest = (await connectionRow(venueId)) ?? c;
    revoked = await provider.revoke({ refreshToken: (latest.refresh_token ? unseal(latest.refresh_token) : null) ?? refresh, accessToken: access, connectionId: c.connection_id });
  }
  const db = getDb();
  await db.transaction(async () => {
    await db
      .prepare(
        `UPDATE accounting_connections SET status = 'disconnected', access_token = NULL, refresh_token = NULL, access_expires_at = NULL,
           refreshing_until = NULL, paused_until = NULL, failing_since = NULL, disconnected_at = ?, updated_at = ? WHERE venue_id = ?`
      )
      .run(iso(now), iso(now), venueId);
    await db
      .prepare(
        `UPDATE accounting_queue SET status = 'skipped', reason = 'disconnected', lease_until = NULL, updated_at = ?
          WHERE venue_id = ? AND status IN ('queued', 'sending', 'failed', 'held')`
      )
      .run(iso(now), venueId);
  })();
  return { ok: true, revoked };
}

/** Read the organisation's accounts and tax rates, to fill the mapping screen's lists. */
export async function refreshChart(venueId: number, now = new Date()): Promise<{ ok: true; chart: Chart } | Fail> {
  const c = await connectionRow(venueId);
  if (!c || c.status !== "connected") return { ok: false, error: REFUSALS.notConnected };
  try {
    const ctx = await contextFor(venueId, now);
    if (!ctx) return { ok: false, error: REFUSALS.xeroDown };
    const chart = await ctx.call((s) => provider.chart(s));
    const db = getDb();
    for (const [kind, body] of [["account", chart.accounts], ["tax", chart.taxRates]] as const)
      await db
        .prepare(
          `INSERT INTO accounting_chart (venue_id, kind, body, fetched_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (venue_id, kind) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`
        )
        .run(venueId, kind, JSON.stringify(body), iso(now));
    return { ok: true, chart: await loadChart(venueId) };
  } catch (err) {
    if (mustRethrow(err)) throw err;
    return { ok: false, error: err instanceof ProviderError && err.kind === "unauthorised" ? REFUSALS.notConnected : REFUSALS.xeroDown };
  }
}

// ------------------------------------------------------------------ tokens

interface Context {
  /** Run a call with the access token, refreshing it once if the package says it has gone bad. */
  call<T>(fn: (session: Session) => Promise<T>): Promise<T>;
}

/** A needs-reconnecting mark, and the day it started failing (the alert counts from there). */
async function needReconnect(venueId: number, now: Date): Promise<void> {
  await getDb()
    .prepare(
      `UPDATE accounting_connections SET status = 'needs_reconnect', refreshing_until = NULL, failing_since = COALESCE(failing_since, ?), updated_at = ?
        WHERE venue_id = ? AND status = 'connected'`
    )
    .run(iso(now), iso(now), venueId);
}

/**
 * A usable access token, refreshing it when it is about to run out. The refresh token rotates (each refresh gives a new one
 * and spends the old), so one process refreshes at a time: it takes a short lease, and another that finds it held uses
 * what the first stored, or tries again next tick. Null when it cannot be had now.
 */
async function session(venueId: number, now: Date, force: boolean): Promise<Session | null> {
  const db = getDb();
  let c = await connectionRow(venueId);
  if (!c || c.status !== "connected" || !c.tenant_id) return null;
  const fresh = (row: ConnectionRow) => row.access_token && at(row.access_expires_at) - now.getTime() > ms(60);
  if (!force && fresh(c)) {
    const token = unseal(c.access_token!);
    if (token) return { accessToken: token, tenantId: c.tenant_id };
  }
  const leased = await db
    .prepare(
      `UPDATE accounting_connections SET refreshing_until = ? WHERE venue_id = ? AND status = 'connected' AND (refreshing_until IS NULL OR refreshing_until < ?)`
    )
    .run(iso(new Date(now.getTime() + ms(60))), venueId, iso(now));
  if (leased.changes !== 1) {
    c = await connectionRow(venueId);
    if (c && c.status === "connected" && !force && fresh(c)) {
      const token = unseal(c.access_token!);
      if (token) return { accessToken: token, tenantId: c.tenant_id! };
    }
    return null;
  }
  try {
    c = (await connectionRow(venueId))!;
    const refresh = c.refresh_token ? unseal(c.refresh_token) : null;
    // Sealed under another key (an install restored elsewhere): it cannot be opened, so the grant has to be given again.
    if (!refresh) throw new ProviderError("unauthorised", "The stored access cannot be read.");
    const tokens = await provider.refresh(refresh);
    await db
      .prepare(
        `UPDATE accounting_connections SET access_token = ?, refresh_token = ?, access_expires_at = ?, scopes = ?, refreshing_until = NULL, updated_at = ? WHERE venue_id = ?`
      )
      .run(seal(tokens.accessToken), seal(tokens.refreshToken), iso(new Date(now.getTime() + ms(tokens.expiresInSeconds))), tokens.scopes, iso(now), venueId);
    return { accessToken: tokens.accessToken, tenantId: c.tenant_id! };
  } catch (err) {
    if (err instanceof ProviderError && err.kind === "unauthorised") await needReconnect(venueId, now);
    else await db.prepare("UPDATE accounting_connections SET refreshing_until = NULL WHERE venue_id = ?").run(venueId);
    throw err;
  }
}

async function contextFor(venueId: number, now: Date): Promise<Context | null> {
  let current = await session(venueId, now, false);
  if (!current) return null;
  let refreshed = false;
  return {
    async call<T>(fn: (s: Session) => Promise<T>): Promise<T> {
      try {
        return await fn(current!);
      } catch (err) {
        // 401: the token may simply have been turned in early; refreshed once, and a second refusal means reconnecting.
        if (err instanceof ProviderError && err.kind === "unauthorised" && !refreshed) {
          refreshed = true;
          const bad = current!.accessToken;
          let next = await session(venueId, now, true);
          // Another tick is refreshing at this moment (the refresh token is spent by one): take what it stores, rather than
          // taking the 401 for a lost grant.
          for (let wait = 0; !next && wait < 25; wait++) {
            await new Promise((r) => setTimeout(r, 200));
            const c = await connectionRow(venueId);
            if (!c || c.status !== "connected") break;
            const token = c.access_token ? unseal(c.access_token) : null;
            if (token && token !== bad) next = { accessToken: token, tenantId: c.tenant_id! };
          }
          if (!next) throw err;
          current = next;
          try {
            return await fn(current);
          } catch (again) {
            if (again instanceof ProviderError && again.kind === "unauthorised") await needReconnect(venueId, now);
            throw again;
          }
        }
        throw err;
      }
    },
  };
}

// ------------------------------------------------------------------ the queue

export type QueueStatus = "queued" | "sending" | "sent" | "failed" | "held" | "skipped";

interface QueueRow {
  id: number;
  venue_id: number;
  source_ref: string;
  kind: "invoice" | "credit_note";
  number: string;
  category: string;
  day: string;
  occurred_at: unknown;
  gross_cents: number;
  tax_cents: number;
  tax_rate: number | string | null;
  method: string | null;
  description: string;
  original_ref: string | null;
  status: QueueStatus;
  reason: string | null;
  attempts: number;
  next_attempt_at: unknown;
  lease_until: unknown;
  error_code: string | null;
  error_detail: string | null;
  tenant_id: string | null;
  xero_id: string | null;
  xero_number: string | null;
  xero_total_cents: number | null;
  xero_tax_cents: number | null;
  xero_payment_id: string | null;
  updated_at: unknown;
}

const cents = (n: number) => Math.round(Math.abs(n) * 100);

/** Where a credit note's original sale is, if the journal says: the receipt it reverses, or the booking whose receipt it takes back. */
async function originalOf(receiptId: number): Promise<string | null> {
  const r = (await getDb().prepare("SELECT source, credits_id FROM receipts WHERE id = ?").get(receiptId)) as { source: string; credits_id: number | null } | undefined;
  if (!r) return null;
  const reverses = /^credit:(\d+)/.exec(r.source);
  if (reverses) return `receipt:${reverses[1]}`;
  if (r.credits_id) return `receipt:${r.credits_id}`;
  const booking = await bookingOfSource(r.source);
  return booking ? `booking:${booking}` : null;
}

/** The journal's rows over a long stretch, a month at a time (a long read is several short ones). */
async function* journalWindows(venueId: number, from: string, to: string): AsyncGenerator<JournalRow[]> {
  for (let start = from; start <= to; ) {
    const end = addDays(start, 30) < to ? addDays(start, 30) : to;
    yield await salesJournal(venueId, start, end);
    start = addDays(end, 1);
  }
}

/** When it happened, as one ISO moment (the journal's own `at`, or the start of its day where that cannot be read). */
function occurred(r: JournalRow): string {
  const d = new Date(r.at);
  return Number.isNaN(d.getTime()) ? `${r.date}T00:00:00.000Z` : d.toISOString();
}

/** A journal row as the queue keeps it, or null where it is not pushed (a test booking's, made before going live). */
async function queueFields(r: JournalRow) {
  if (r.test) return null;
  const credit = r.type === "Credit note";
  return {
    kind: credit ? ("credit_note" as const) : ("invoice" as const),
    // A booking's row describes the court and the day; every other says only what kind of sale it was: the receipt's own
    // lines can say whom a place was for, and that is never sent.
    description: r.ref.startsWith("booking:") ? r.description : r.category,
    original: credit && r.ref.startsWith("receipt:") ? await originalOf(Number(r.ref.slice(8))) : null,
  };
}

/**
 * Put the journal's rows between two days on the queue (each once, whatever happens: a row already there is left as it is),
 * and, with `requeue`, give back to the queue those that were set aside only because of the connection. Returns how many are new.
 */
export async function enqueueRange(venueId: number, from: string, to: string, opts: { requeue?: boolean } = {}, now = new Date()): Promise<number> {
  const db = getDb();
  let added = 0;
  for await (const rows of journalWindows(venueId, from, to)) {
    const have = new Map(
      ((await db.prepare("SELECT source_ref, status, reason FROM accounting_queue WHERE venue_id = ? AND day BETWEEN ? AND ?").all(venueId, from, to)) as { source_ref: string; status: string; reason: string | null }[]).map(
        (x) => [x.source_ref, x] as const
      )
    );
    for (const r of rows) {
      const existing = have.get(r.ref);
      if (existing) {
        if (opts.requeue && existing.status === "skipped" && ["disconnected", "before_connection", "original_not_in_xero"].includes(existing.reason ?? ""))
          await db.prepare("UPDATE accounting_queue SET status = 'queued', reason = NULL, error_code = NULL, error_detail = NULL, attempts = 0, next_attempt_at = ?, updated_at = ? WHERE venue_id = ? AND source_ref = ? AND status = 'skipped'").run(iso(now), iso(now), venueId, r.ref);
        continue;
      }
      const f = await queueFields(r);
      if (!f) continue;
      const gross = cents(r.gross);
      const done = await db
        .prepare(
          `INSERT INTO accounting_queue (venue_id, source_ref, kind, number, category, day, occurred_at, gross_cents, tax_cents, tax_rate, method, description,
             original_ref, status, reason, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (venue_id, source_ref) DO NOTHING`
        )
        .run(
          venueId, r.ref, f.kind, r.number, r.category, r.date, occurred(r), gross, cents(r.tax), r.taxRate, r.method, f.description, f.original,
          gross === 0 ? "skipped" : "queued", gross === 0 ? "nothing_to_record" : null, iso(now), iso(now), iso(now)
        );
      added += done.changes;
    }
  }
  return added;
}

/**
 * Read the journal for new sales: from the connection's start day, a couple of days back from where it last read (a receipt
 * can be dated a little before it was written), through today. At most every few minutes unless `force`. Then hold what lacks a mapping.
 */
export async function enqueueNew(venueId: number, now = new Date(), force = false): Promise<number> {
  const c = await connectionRow(venueId);
  if (!c || c.status === "disconnected") return 0;
  if (!force && c.scanned_at && now.getTime() - at(c.scanned_at) < ms(SCAN_EVERY_SECONDS)) return 0;
  const today = await venueDay(venueId, now);
  const from = c.scanned_through ? (addDays(c.scanned_through, -2) > c.start_date ? addDays(c.scanned_through, -2) : c.start_date) : c.start_date;
  const added = from <= today ? await enqueueRange(venueId, from, today, {}, now) : 0;
  await getDb().prepare("UPDATE accounting_connections SET scanned_through = ?, scanned_at = ? WHERE venue_id = ?").run(today, iso(now), venueId);
  await classify(venueId, now);
  return added;
}

/** What a sale lacks, as the mapping keys it needs and has no choice for. */
function missingFor(row: QueueRow, mapping: Mapping, method: string | null): string[] {
  const keys: string[] = [];
  if (!mapping.account[row.category]) keys.push(`account:${row.category}`);
  const tax = taxKeyOf(row.tax_rate);
  if (!mapping.tax[tax]) keys.push(`tax:${tax}`);
  const pay = paymentKeyOf(method);
  if (!mapping.payment[pay]) keys.push(`payment:${pay}`);
  return keys;
}

/** How a sale was paid, or a credit note's: its own, else its original sale's. */
async function methodOf(row: QueueRow): Promise<string | null> {
  if (row.method || row.kind !== "credit_note" || !row.original_ref) return row.method;
  const o = (await getDb().prepare("SELECT method FROM accounting_queue WHERE venue_id = ? AND source_ref = ?").get(row.venue_id, row.original_ref)) as { method: string | null } | undefined;
  return o?.method ?? null;
}

/** Hold the queued sales that lack a mapping, and release the held ones that no longer do. */
export async function classify(venueId: number, now: Date): Promise<void> {
  const db = getDb();
  const mapping = await loadMapping(venueId);
  const rows = (await db.prepare("SELECT * FROM accounting_queue WHERE venue_id = ? AND status IN ('queued', 'held') ORDER BY id").all(venueId)) as QueueRow[];
  for (const row of rows) {
    const keys = missingFor(row, mapping, await methodOf(row));
    if (keys.length > 0) {
      if (row.status === "queued" || row.reason !== keys.join(","))
        await db.prepare("UPDATE accounting_queue SET status = 'held', reason = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'held')").run(keys.join(","), iso(now), row.id);
    } else if (row.status === "held") {
      await db.prepare("UPDATE accounting_queue SET status = 'queued', reason = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'held'").run(iso(now), iso(now), row.id);
    }
  }
}

const idempotencyKey = (venueId: number, ref: string, step: string) => sha(`mysenam|${venueId}|${ref}|${step}`);

/** The account holder behind a sale, as the contact: an adult's name and email, or the walk-in contact. Never stored. */
async function contactOf(ref: string): Promise<DocumentToSend["contact"]> {
  const db = getDb();
  const [kind, id] = ref.split(":");
  const sql =
    kind === "booking"
      ? "SELECT u.name, u.email FROM bookings b JOIN users u ON u.id = b.user_id WHERE b.id = ?"
      : "SELECT u.name, u.email FROM receipts r JOIN users u ON u.id = r.user_id WHERE r.id = ?";
  const u = (await db.prepare(sql).get(Number(id))) as { name: string | null; email: string | null } | undefined;
  const name = u?.name?.trim().slice(0, 200);
  if (!name) return { name: WALK_IN, email: null };
  const email = u?.email?.trim() ?? "";
  return { name, email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null };
}

/** Xero's own words with anything that looks like a name, an address or a token taken out before they are kept. */
export function scrub(text: string, names: (string | null | undefined)[] = []): string {
  let out = text;
  for (const n of names) if (n && n.length >= 2) out = out.split(n).join("…");
  out = out
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "…")
    // A token: a signed one (three parts), or any long run of letters and digits.
    .replace(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g, "…")
    .replace(/[A-Za-z0-9_-]{24,}/g, "…");
  return out.slice(0, 300);
}

const venueNumber = (venueId: number, n: string) => `V${venueId}-${n}`;

type Outcome = "sent" | "held" | "skipped" | "postponed" | "retry" | "failed" | "stop-rate" | "stop-auth";

interface RunCounts {
  sent: number;
  held: number;
  skipped: number;
  postponed: number;
  retried: number;
  failed: number;
  transientOrAuth: number;
  paused: boolean;
  reconnect: boolean;
}

async function claim(id: number, now: Date): Promise<boolean> {
  const r = await getDb()
    .prepare(
      `UPDATE accounting_queue SET status = 'sending', lease_until = ?, updated_at = ?
        WHERE id = ? AND ((status = 'queued' AND next_attempt_at <= ?) OR (status = 'sending' AND lease_until < ?))`
    )
    .run(iso(new Date(now.getTime() + ms(LEASE_SECONDS))), iso(now), id, iso(now), iso(now));
  return r.changes === 1;
}

const backoffMinutes = (attempts: number) => Math.min(2 ** attempts, 360);

/** Settle a claimed row to a status in one write. */
async function settle(id: number, fields: Record<string, unknown>, now: Date): Promise<void> {
  const keys = Object.keys(fields);
  await getDb()
    .prepare(`UPDATE accounting_queue SET ${keys.map((k) => `${k} = ?`).join(", ")}, lease_until = NULL, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), iso(now), id);
}

/** Keep what a step of a claimed row came to, the moment it came, so a retry resumes after it (the row stays claimed). */
async function progress(id: number, fields: Record<string, unknown>, now: Date): Promise<void> {
  const keys = Object.keys(fields);
  await getDb()
    .prepare(`UPDATE accounting_queue SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), iso(now), id);
}

async function sendOne(venueId: number, ctx: Context, row: QueueRow, mapping: Mapping, tenantId: string, now: Date): Promise<Outcome> {
  const db = getDb();
  const credit = row.kind === "credit_note";
  const method = await methodOf(row);
  const missing = missingFor(row, mapping, method);
  if (missing.length > 0) {
    await settle(row.id, { status: "held", reason: missing.join(",") }, now);
    return "held";
  }
  // A credit note reverses a sale that is in Xero: it waits for that sale, and is set aside where that sale never will be.
  if (credit && row.original_ref) {
    const o = (await db.prepare("SELECT status, tenant_id FROM accounting_queue WHERE venue_id = ? AND source_ref = ?").get(venueId, row.original_ref)) as
      | { status: QueueStatus; tenant_id: string | null }
      | undefined;
    if (!o) {
      await settle(row.id, { status: "skipped", reason: "before_connection" }, now);
      return "skipped";
    }
    if (o.status === "skipped" || (o.status === "sent" && o.tenant_id !== tenantId)) {
      await settle(row.id, { status: "skipped", reason: "original_not_in_xero" }, now);
      return "skipped";
    }
    if (o.status !== "sent") {
      await settle(row.id, { status: "queued", next_attempt_at: iso(new Date(now.getTime() + ms(10 * 60))), error_code: "waiting_for_sale", error_detail: null }, now);
      return "postponed";
    }
  }

  const contact = await contactOf(row.source_ref);
  const doc: DocumentToSend = {
    number: venueNumber(venueId, row.number),
    reference: `MySenam V${venueId} ${row.source_ref}`,
    date: row.day,
    contact,
    lines: [
      {
        description: row.description,
        grossCents: row.gross_cents,
        taxCents: row.tax_cents,
        accountCode: mapping.account[row.category].code,
        taxType: mapping.tax[taxKeyOf(row.tax_rate)].code,
      },
    ],
  };
  const payAccount = mapping.payment[paymentKeyOf(method)].code;
  const names = [contact.name, contact.email];
  try {
    let id = row.xero_id;
    if (!id) {
      let made;
      try {
        made = await ctx.call((s) => (credit ? provider.createCreditNote(s, doc, idempotencyKey(venueId, row.source_ref, "document")) : provider.createInvoice(s, doc, idempotencyKey(venueId, row.source_ref, "document"))));
      } catch (err) {
        // Xero already holds one with this number: ours (sent, and the answer lost) is adopted; somebody else's is not.
        if (!(err instanceof ProviderError) || err.kind !== "duplicate") throw err;
        const found = await ctx.call((s) => (credit ? provider.findCreditNote(s, doc.number) : provider.findInvoice(s, doc.number)));
        if (!found || found.reference !== doc.reference) throw new ProviderError("rejected", "A different document with this number is already in Xero.");
        made = found;
      }
      id = made.id;
      await progress(row.id, { tenant_id: tenantId, xero_id: made.id, xero_number: made.number, xero_total_cents: made.totalCents, xero_tax_cents: made.taxCents }, now);
    }
    if (!row.xero_payment_id) {
      const payment = { documentId: id, accountCode: payAccount, date: row.day, amountCents: row.gross_cents, reference: doc.reference };
      let paid: string;
      try {
        paid = (await ctx.call((s) => (credit ? provider.createRefund(s, payment, idempotencyKey(venueId, row.source_ref, "payment")) : provider.createPayment(s, payment, idempotencyKey(venueId, row.source_ref, "payment"))))).id;
      } catch (err) {
        // Refused because nothing is owing any more: the payment is already there (sent, and the answer lost).
        if (!(err instanceof ProviderError) || err.kind !== "rejected") throw err;
        const state = await ctx.call((s) => (credit ? provider.creditNoteState(s, id!) : provider.invoiceState(s, id!)));
        if (!state.settled) throw err;
        paid = "already-recorded";
      }
      await progress(row.id, { xero_payment_id: paid }, now);
    }
    await settle(row.id, { status: "sent", sent_at: iso(now), reason: null, error_code: null, error_detail: null, next_attempt_at: iso(now) }, now);
    return "sent";
  } catch (err) {
    if (mustRethrow(err)) throw err;
    if (err instanceof ProviderError) {
      if (err.kind === "rate_limited") {
        const until = new Date(now.getTime() + ms(err.retryAfterSeconds ?? 60));
        await db.prepare("UPDATE accounting_connections SET paused_until = ? WHERE venue_id = ?").run(iso(until), venueId);
        await settle(row.id, { status: "queued", next_attempt_at: iso(until), error_code: "rate_limited", error_detail: null }, now);
        return "stop-rate";
      }
      if (err.kind === "unauthorised") {
        await needReconnect(venueId, now);
        await settle(row.id, { status: "queued", next_attempt_at: iso(now), error_code: "unauthorised", error_detail: null }, now);
        return "stop-auth";
      }
      const attempts = row.attempts + 1;
      if (err.kind === "unavailable") {
        const giveUp = attempts >= MAX_ATTEMPTS;
        await settle(
          row.id,
          { status: giveUp ? "failed" : "queued", attempts, error_code: "unavailable", error_detail: null, next_attempt_at: iso(new Date(now.getTime() + ms(backoffMinutes(attempts) * 60))) },
          now
        );
        return giveUp ? "failed" : "retry";
      }
      // Refused: sending it again unchanged will not help, so it waits for a person.
      await settle(row.id, { status: "failed", attempts, error_code: "rejected", error_detail: scrub(err.message, names) }, now);
      return "failed";
    }
    // Something of our own: not Xero's fault, and not worth losing the sale over; tried again, with nothing said of what it was.
    console.error("[mysenam] accounting push: an unexpected error:", err instanceof Error ? err.name : "unknown");
    const attempts = row.attempts + 1;
    await settle(row.id, { status: attempts >= MAX_ATTEMPTS ? "failed" : "queued", attempts, error_code: "internal", error_detail: null, next_attempt_at: iso(new Date(now.getTime() + ms(backoffMinutes(attempts) * 60))) }, now);
    return attempts >= MAX_ATTEMPTS ? "failed" : "retry";
  }
}

export interface PushResult extends Partial<RunCounts> {
  /** Why nothing was sent, where that is so. */
  idle?: "off" | "not_connected" | "paused" | "busy" | "reconnect";
}

/**
 * Send what is due for one venue, oldest first: the queued sales whose time has come (and any whose taker died mid-send).
 * Stops at the first 429 (the venue is paused until Xero says) or refusal of the access (a reconnect is asked for).
 */
export async function pushDue(venueId: number, now = new Date(), limit = 50): Promise<PushResult> {
  if (!offered()) return { idle: "off" };
  let c = await connectionRow(venueId);
  if (!c || c.status === "disconnected") return { idle: "not_connected" };
  if (c.status === "needs_reconnect") return { idle: "reconnect" };
  if (at(c.paused_until) > now.getTime()) return { idle: "paused" };
  if (c.paused_until) await getDb().prepare("UPDATE accounting_connections SET paused_until = NULL WHERE venue_id = ?").run(venueId);
  await classify(venueId, now);
  const counts: RunCounts = { sent: 0, held: 0, skipped: 0, postponed: 0, retried: 0, failed: 0, transientOrAuth: 0, paused: false, reconnect: false };
  let ctx: Context | null;
  try {
    ctx = await contextFor(venueId, now);
  } catch (err) {
    if (mustRethrow(err)) throw err;
    if (err instanceof ProviderError && err.kind === "unauthorised") return { idle: "reconnect" };
    await noteRun(venueId, { ...counts, transientOrAuth: 1 }, now);
    return { ...counts, transientOrAuth: 1 };
  }
  if (!ctx) return { idle: "busy" };
  c = (await connectionRow(venueId))!;
  const mapping = await loadMapping(venueId);
  const due = (await getDb()
    .prepare(
      `SELECT * FROM accounting_queue WHERE venue_id = ? AND ((status = 'queued' AND next_attempt_at <= ?) OR (status = 'sending' AND lease_until < ?))
        ORDER BY occurred_at, id LIMIT ?`
    )
    .all(venueId, iso(now), iso(now), limit)) as QueueRow[];
  for (const row of due) {
    if (!(await claim(row.id, now))) continue;
    // The row as it is now it is ours: the steps it already made are in it.
    const mine = (await getDb().prepare("SELECT * FROM accounting_queue WHERE id = ?").get(row.id)) as QueueRow;
    const outcome = await sendOne(venueId, ctx, mine, mapping, c.tenant_id!, now);
    if (outcome === "sent") counts.sent++;
    else if (outcome === "held") counts.held++;
    else if (outcome === "skipped") counts.skipped++;
    else if (outcome === "postponed") counts.postponed++;
    else if (outcome === "retry") {
      counts.retried++;
      counts.transientOrAuth++;
    }
    else if (outcome === "failed") counts.failed++;
    else if (outcome === "stop-rate") {
      counts.paused = true;
      break;
    } else {
      counts.reconnect = true;
      counts.transientOrAuth++;
      break;
    }
    // Three that Xero could not be reached for in a row: it is down; the rest wait for the next tick.
    if (counts.retried >= 3) break;
  }
  await noteRun(venueId, counts, now);
  return counts;
}

/** After a run: when something last went right, or since when nothing has. */
async function noteRun(venueId: number, counts: RunCounts, now: Date): Promise<void> {
  const db = getDb();
  if (counts.sent > 0) await db.prepare("UPDATE accounting_connections SET last_ok_at = ?, updated_at = ? WHERE venue_id = ?").run(iso(now), iso(now), venueId);
  if (counts.sent > 0 && counts.transientOrAuth === 0) await db.prepare("UPDATE accounting_connections SET failing_since = NULL WHERE venue_id = ?").run(venueId);
  else if (counts.transientOrAuth > 0 && counts.sent === 0)
    await db.prepare("UPDATE accounting_connections SET failing_since = COALESCE(failing_since, ?) WHERE venue_id = ?").run(iso(now), venueId);
}

/**
 * The venue's managers are told, in their own language, when sending has been failing for a day (nothing got through, the
 * access needs renewing, or a sale has been left failed): once a day while it lasts. Never throws.
 */
export async function alertIfFailing(venueId: number, now = new Date()): Promise<boolean> {
  try {
    const c = await connectionRow(venueId);
    if (!c || c.status === "disconnected") return false;
    const day = ms(FAILING_ALERT_HOURS * 3600);
    const failing = c.failing_since && now.getTime() - at(c.failing_since) >= day;
    const stuck = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM accounting_queue WHERE venue_id = ? AND status = 'failed' AND updated_at < ?").get(venueId, iso(new Date(now.getTime() - day)))) as { n: number };
    if (!failing && stuck.n === 0) return false;
    if (c.last_alert_at && now.getTime() - at(c.last_alert_at) < day) return false;
    // Claimed before it is sent: two processes do not both tell.
    const claimed = await getDb()
      .prepare("UPDATE accounting_connections SET last_alert_at = ? WHERE venue_id = ? AND (last_alert_at IS NULL OR last_alert_at < ?)")
      .run(iso(now), venueId, iso(new Date(now.getTime() - day)));
    if (claimed.changes !== 1) return false;
    const venue = (await getDb().prepare("SELECT name FROM venues WHERE id = ?").get(venueId)) as { name: string } | undefined;
    const reconnect = c.status === "needs_reconnect";
    await tellVenueStaffEach(
      venueId,
      (t) => ({
        subject: t("xr.alert.s", { venue: venue?.name ?? t("r9d.yourVenue") }),
        body: t(reconnect ? "xr.alert.reconnect" : "xr.alert.b", { venue: venue?.name ?? t("r9d.yourVenue"), failed: stuck.n }),
      }),
      { managersOnly: true }
    );
    return true;
  } catch (err) {
    if (mustRethrow(err)) throw err;
    console.error("[mysenam] could not tell staff that the accounting push is failing:", err instanceof Error ? err.name : "unknown");
    return false;
  }
}

/** The scheduler's part (lib/scheduler.ts): for each connected venue, read new sales, send what is due, tell if it keeps failing. */
export async function runAccountingPush(now = new Date()): Promise<void> {
  if (!offered()) return;
  const venues = (await getDb().prepare("SELECT venue_id, status FROM accounting_connections WHERE status IN ('connected', 'needs_reconnect') ORDER BY venue_id").all()) as { venue_id: number; status: string }[];
  for (const v of venues) {
    try {
      if (v.status === "connected") {
        await enqueueNew(v.venue_id, now);
        await pushDue(v.venue_id, now);
      }
      await alertIfFailing(v.venue_id, now);
    } catch (err) {
      if (mustRethrow(err)) throw err;
      // One venue's trouble does not stop the others', and says nothing of what it held.
      console.error(`[mysenam] accounting push for venue ${v.venue_id} failed:`, err instanceof Error ? err.name : "unknown");
    }
  }
}

// ------------------------------------------------------------------ what the dashboard shows

export interface QueueView {
  counts: Record<QueueStatus, number> & { retrying: number };
  held: { id: number; number: string; category: string; day: string; grossCents: number; kind: string; needs: string[] }[];
  failed: { id: number; number: string; category: string; day: string; grossCents: number; kind: string; code: string | null; detail: string | null; attempts: number }[];
  skipped: Record<string, number>;
}

export async function queueView(venueId: number): Promise<QueueView> {
  const db = getDb();
  const counts: QueueView["counts"] = { queued: 0, sending: 0, sent: 0, failed: 0, held: 0, skipped: 0, retrying: 0 };
  for (const r of (await db.prepare("SELECT status, COUNT(*)::int AS n FROM accounting_queue WHERE venue_id = ? GROUP BY status").all(venueId)) as { status: QueueStatus; n: number }[]) counts[r.status] = r.n;
  counts.retrying = ((await db.prepare("SELECT COUNT(*)::int AS n FROM accounting_queue WHERE venue_id = ? AND status = 'queued' AND error_code IS NOT NULL").get(venueId)) as { n: number }).n;
  const held = (await db.prepare("SELECT * FROM accounting_queue WHERE venue_id = ? AND status = 'held' ORDER BY day DESC, id DESC LIMIT 100").all(venueId)) as QueueRow[];
  const failed = (await db.prepare("SELECT * FROM accounting_queue WHERE venue_id = ? AND status = 'failed' ORDER BY updated_at DESC LIMIT 100").all(venueId)) as QueueRow[];
  const skipped: Record<string, number> = {};
  for (const r of (await db.prepare("SELECT COALESCE(reason, '') AS reason, COUNT(*)::int AS n FROM accounting_queue WHERE venue_id = ? AND status = 'skipped' GROUP BY reason").all(venueId)) as { reason: string; n: number }[]) skipped[r.reason] = r.n;
  return {
    counts,
    held: held.map((r) => ({ id: r.id, number: r.number, category: r.category, day: r.day, grossCents: r.gross_cents, kind: r.kind, needs: (r.reason ?? "").split(",").filter(Boolean) })),
    failed: failed.map((r) => ({ id: r.id, number: r.number, category: r.category, day: r.day, grossCents: r.gross_cents, kind: r.kind, code: r.error_code, detail: r.error_detail, attempts: r.attempts })),
    skipped,
  };
}

/** A manager sends a failed sale (or, with no id, every one) again, and what waits for its turn now. */
export async function retry(venueId: number, id: number | null, now = new Date()): Promise<{ ok: true; count: number } | Fail> {
  const db = getDb();
  const r = await db
    .prepare(
      `UPDATE accounting_queue SET status = 'queued', attempts = 0, error_code = NULL, error_detail = NULL, next_attempt_at = ?, lease_until = NULL, updated_at = ?
        WHERE venue_id = ? AND (status = 'failed' OR (status = 'queued' AND error_code IS NOT NULL))${id === null ? "" : " AND id = ?"}`
    )
    .run(...[iso(now), iso(now), venueId, ...(id === null ? [] : [id])]);
  if (id !== null && r.changes === 0) return { ok: false, error: REFUSALS.nothingToRetry };
  // A paused or reconnecting venue is not forced: the pause is Xero's.
  await db.prepare("UPDATE accounting_connections SET failing_since = NULL WHERE venue_id = ? AND status = 'connected'").run(venueId);
  return { ok: true, count: r.changes };
}

export interface StartPreview {
  from: string;
  count: number;
  /** Receipts less credit notes, in cents. */
  totalCents: number;
}

async function signed(rows: JournalRow[]): Promise<number> {
  return rows.reduce((sum, r) => sum + (r.type === "Credit note" ? -1 : 1) * cents(r.gross), 0);
}

function checkStartDay(from: unknown, today: string, current: string): { ok: true; from: string } | Fail {
  if (typeof from !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(`${from}T00:00:00Z`))) return { ok: false, error: REFUSALS.badDate };
  if (from > today) return { ok: false, error: REFUSALS.badDate };
  if (from < addDays(today, -MAX_BACKFILL_DAYS)) return { ok: false, error: REFUSALS.tooEarly };
  if (from > current) return { ok: false, error: REFUSALS.laterThanStart };
  return { ok: true, from };
}

/** How many sales, and what total, would be queued if sending began on this day: the preview a manager confirms. */
export async function previewStart(venueId: number, from: unknown, now = new Date()): Promise<{ ok: true; preview: StartPreview } | Fail> {
  const c = await connectionRow(venueId);
  if (!c || c.status === "disconnected") return { ok: false, error: REFUSALS.notConnected };
  const today = await venueDay(venueId, now);
  const day = checkStartDay(from, today, c.start_date);
  if (!day.ok) return day;
  const db = getDb();
  const have = new Map(
    ((await db.prepare("SELECT source_ref, status, reason FROM accounting_queue WHERE venue_id = ? AND day >= ?").all(venueId, day.from)) as { source_ref: string; status: string; reason: string | null }[]).map((x) => [x.source_ref, x] as const)
  );
  let count = 0;
  let total = 0;
  for await (const rows of journalWindows(venueId, day.from, today)) {
    const fresh = rows.filter((r) => {
      if (r.test) return false;
      const e = have.get(r.ref);
      return !e || (e.status === "skipped" && ["disconnected", "before_connection", "original_not_in_xero"].includes(e.reason ?? ""));
    });
    count += fresh.length;
    total += await signed(fresh);
  }
  return { ok: true, preview: { from: day.from, count, totalCents: total } };
}

/**
 * "Send everything from this day": only with the preview's count and total confirmed (recomputed here, and refused if the
 * ledger has moved). The start day moves back to it; what is already queued or sent is untouched.
 */
export async function startFrom(venueId: number, from: unknown, confirm: { count: unknown; totalCents: unknown }, now = new Date()): Promise<{ ok: true; added: number } | Fail> {
  const preview = await previewStart(venueId, from, now);
  if (!preview.ok) return preview;
  if (confirm.count !== preview.preview.count || confirm.totalCents !== preview.preview.totalCents) return { ok: false, error: REFUSALS.previewChanged };
  const today = await venueDay(venueId, now);
  const db = getDb();
  await db.prepare("UPDATE accounting_connections SET start_date = ?, scanned_through = NULL, scanned_at = NULL, updated_at = ? WHERE venue_id = ?").run(preview.preview.from, iso(now), venueId);
  const added = await enqueueRange(venueId, preview.preview.from, today, { requeue: true }, now);
  await db.prepare("UPDATE accounting_connections SET scanned_through = ?, scanned_at = ? WHERE venue_id = ?").run(today, iso(now), venueId);
  await classify(venueId, now);
  return { ok: true, added };
}

export interface Reconciliation {
  from: string;
  to: string;
  /** From the start day on, test bookings left out, as the export is. */
  ledger: { count: number; grossCents: number; taxCents: number };
  /** What Xero answered for what was sent to the connected organisation, in the same days. */
  sent: { count: number; grossCents: number; taxCents: number };
  differs: boolean;
  /** Days on which the two disagree (at most 31). */
  days: { day: string; ledgerGrossCents: number; sentGrossCents: number }[];
  /** What has not been sent, by status, and why it was set aside. */
  waiting: { queued: number; held: number; failed: number; skipped: Record<string, number> };
}

/** The ledger's totals against what was sent, day by day: the sums of the sales and of the tax, said to differ when they do. */
export async function reconcile(venueId: number, from: string, to: string): Promise<{ ok: true; report: Reconciliation } | Fail> {
  const c = await connectionRow(venueId);
  if (!c || c.status === "disconnected") return { ok: false, error: REFUSALS.notConnected };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) return { ok: false, error: REFUSALS.badDate };
  const first = from > c.start_date ? from : c.start_date;
  const ledgerDays = new Map<string, number>();
  const ledger = { count: 0, grossCents: 0, taxCents: 0 };
  if (first <= to)
    for await (const rows of journalWindows(venueId, first, to))
      for (const r of rows) {
        if (r.test || cents(r.gross) === 0) continue;
        const sign = r.type === "Credit note" ? -1 : 1;
        ledger.count++;
        ledger.grossCents += sign * cents(r.gross);
        ledger.taxCents += sign * cents(r.tax);
        ledgerDays.set(r.date, (ledgerDays.get(r.date) ?? 0) + sign * cents(r.gross));
      }
  const db = getDb();
  const sentRows = (await db
    .prepare(
      `SELECT day, kind, gross_cents, tax_cents, xero_total_cents, xero_tax_cents FROM accounting_queue
        WHERE venue_id = ? AND status = 'sent' AND tenant_id = ? AND day BETWEEN ? AND ?`
    )
    .all(venueId, c.tenant_id, first, to)) as { day: string; kind: string; gross_cents: number; tax_cents: number; xero_total_cents: number | null; xero_tax_cents: number | null }[];
  const sent = { count: 0, grossCents: 0, taxCents: 0 };
  const sentDays = new Map<string, number>();
  for (const r of sentRows) {
    const sign = r.kind === "credit_note" ? -1 : 1;
    // What Xero answered (it is what is in the books); what was sent, where it did not say.
    const gross = r.xero_total_cents ?? r.gross_cents;
    sent.count++;
    sent.grossCents += sign * gross;
    sent.taxCents += sign * (r.xero_tax_cents ?? r.tax_cents);
    sentDays.set(r.day, (sentDays.get(r.day) ?? 0) + sign * gross);
  }
  const days = [...new Set([...ledgerDays.keys(), ...sentDays.keys()])]
    .sort()
    .filter((d) => (ledgerDays.get(d) ?? 0) !== (sentDays.get(d) ?? 0))
    .slice(0, 31)
    .map((day) => ({ day, ledgerGrossCents: ledgerDays.get(day) ?? 0, sentGrossCents: sentDays.get(day) ?? 0 }));
  const status = (await db
    .prepare("SELECT status, COALESCE(reason, '') AS reason, COUNT(*)::int AS n FROM accounting_queue WHERE venue_id = ? AND day BETWEEN ? AND ? AND status <> 'sent' GROUP BY status, reason")
    .all(venueId, first, to)) as { status: string; reason: string; n: number }[];
  const waiting: Reconciliation["waiting"] = { queued: 0, held: 0, failed: 0, skipped: {} };
  for (const s of status) {
    if (s.status === "skipped") waiting.skipped[s.reason] = (waiting.skipped[s.reason] ?? 0) + s.n;
    else if (s.status === "held") waiting.held += s.n;
    else if (s.status === "failed") waiting.failed += s.n;
    else waiting.queued += s.n;
  }
  return { ok: true, report: { from: first, to, ledger, sent, differs: ledger.grossCents !== sent.grossCents || ledger.taxCents !== sent.taxCents, days, waiting } };
}
