import { salesJournal, type Category } from "./accounting";
import { getDb, mustRethrow } from "./db";
import { documentById, documentId } from "./documents";
import { errorText, translator, type ErrorCode } from "./i18n";
import {
  documentStatus,
  mayHaveReachedLhdn,
  submissionDocuments,
  submitDocument,
  token,
  validationLink,
  type Connection,
  type DocumentStatus,
} from "./myinvois/client";
import { buildDocument, STATE_CODES, type DocLine, type Party, type Supplier } from "./myinvois/ubl";
import { receiptFor } from "./receipts";
import { region, roundMoney } from "./region";
import { seal, unseal } from "./secrets";
import { findBookingByCode } from "./store";
import { venueTax } from "./tax";
import { todayISO } from "./time";
import type { Refusal } from "./types";
import { venueZoneOf } from "./zones";
import { englishOf, said, type ServerPhrase, type StaffText } from "./staff-text";
import { tellVenueStaffEach } from "./owner-alerts";

/**
 * Malaysia's e-invoicing (LHDN MyInvois), for a venue that must or wants to.
 *
 * - **Each month**, in the first seven days, the month before goes to LHDN as
 *   one consolidated e-invoice for the general public: a line for each kind
 *   of sale, with how many receipts and which. Credit notes from the month go
 *   as consolidated credit notes, each against the e-invoice that carried
 *   what they reverse.
 * - **A customer who wants an e-invoice of their own** (a company claiming
 *   it, say) asks from their receipt, giving their tax number and details,
 *   before the month is consolidated. Theirs goes at once and is left out of
 *   the consolidated one.
 *
 * Each is sent as LHDN's UBL 2.1 JSON, version 1.0 (lib/myinvois/ubl.ts),
 * built when it is sent so it carries the venue's details as they are then,
 * and checked afterwards until LHDN says valid or invalid. A valid one gets
 * LHDN's public link, which the receipt shows. Once sent, a document is
 * never rewritten: a correction is a new document (`EInvoiceStatus`).
 *
 * The LHDN rules this follows (the seven days, the RM10,000 limit, the
 * codes and document version) are read from LHDN's published guidance and
 * samples and marked UNVERIFIED where they are used: none has been checked
 * against the MyInvois sandbox.
 *
 * MySenam reaches MyInvois with the venue's own ERP client credentials, or as
 * the venue's intermediary with the platform's (MYINVOIS_CLIENT_ID and
 * MYINVOIS_CLIENT_SECRET), once the venue has named the platform as its
 * intermediary in the MyInvois portal.
 */

export interface EInvoiceSettings {
  enabled: boolean;
  sandbox: boolean;
  mode: "own" | "intermediary";
  clientId: string | null;
  hasSecret: boolean;
  tin: string | null;
  brn: string | null;
  msicCode: string | null;
  msicName: string | null;
  legalName: string | null;
  addressLine: string | null;
  city: string | null;
  postcode: string | null;
  stateCode: string | null;
  phone: string | null;
  email: string | null;
  /** What is still needed before anything can be sent. */
  missing: string[];
  /** The same, as phrases the settings screen says in the staff language. */
  missingPhrases: StaffText[];
  /** The platform can act as intermediary on this install. */
  intermediaryAvailable: boolean;
}

interface SettingsRow {
  venue_id: number;
  enabled: number;
  sandbox: number;
  mode: "own" | "intermediary";
  client_id: string | null;
  client_secret: string | null;
  tin: string | null;
  brn: string | null;
  msic_code: string | null;
  msic_name: string | null;
  legal_name: string | null;
  address_line: string | null;
  city: string | null;
  postcode: string | null;
  state_code: string | null;
  phone: string | null;
  email: string | null;
}

const ENGLISH = translator("en");
function refuse(code: ErrorCode, vars?: Record<string, string | number>): Refusal {
  return { ok: false, error: errorText(ENGLISH, code, vars), code, ...(vars ? { vars } : {}) };
}

export function intermediaryAvailable(): boolean {
  return !!(process.env.MYINVOIS_CLIENT_ID?.trim() && process.env.MYINVOIS_CLIENT_SECRET?.trim());
}

async function settingsRow(venueId: number): Promise<SettingsRow | undefined> {
  return (await getDb().prepare("SELECT * FROM einvoice_settings WHERE venue_id = ?").get(venueId)) as SettingsRow | undefined;
}

function missingOf(r: SettingsRow | undefined): string[] {
  return missingPhrases(r).map(englishOf);
}

/** The same, as phrases the settings screen says in the staff language. */
function missingPhrases(r: SettingsRow | undefined): StaffText[] {
  if (!r) return [said("srv.einv.everything")];
  const need: [unknown, ServerPhrase][] = [
    [r.tin, "srv.einv.tin"],
    [r.brn, "srv.einv.brn"],
    [r.msic_code, "srv.einv.msic"],
    [r.legal_name, "srv.einv.legalName"],
    [r.address_line, "srv.einv.address"],
    [r.city, "srv.einv.city"],
    [r.postcode, "srv.einv.postcode"],
    [r.state_code, "srv.einv.state"],
    [r.phone, "srv.einv.phone"],
    [r.email, "srv.einv.email"],
  ];
  const missing = need.filter(([value]) => !value).map(([, key]) => said(key));
  if (r.mode === "own" && (!r.client_id || !r.client_secret)) missing.push(said("srv.einv.ownCredentials"));
  if (r.mode === "intermediary" && !intermediaryAvailable()) missing.push(said("srv.einv.intermediary"));
  return missing;
}

export async function einvoiceSettings(venueId: number): Promise<EInvoiceSettings> {
  const r = await settingsRow(venueId);
  return {
    enabled: r?.enabled === 1,
    sandbox: r ? r.sandbox === 1 : true,
    mode: r?.mode ?? "own",
    clientId: r?.client_id ?? null,
    hasSecret: !!r?.client_secret,
    tin: r?.tin ?? null,
    brn: r?.brn ?? null,
    msicCode: r?.msic_code ?? null,
    msicName: r?.msic_name ?? null,
    legalName: r?.legal_name ?? null,
    addressLine: r?.address_line ?? null,
    city: r?.city ?? null,
    postcode: r?.postcode ?? null,
    stateCode: r?.state_code ?? null,
    phone: r?.phone ?? null,
    email: r?.email ?? null,
    missing: missingOf(r),
    missingPhrases: missingPhrases(r),
    intermediaryAvailable: intermediaryAvailable(),
  };
}

const text = (v: unknown, max = 200) => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);

/** Save what was given; a secret left blank keeps the one stored. Turning it on needs everything. */
export async function saveEInvoiceSettings(
  venueId: number,
  input: Record<string, unknown>
): Promise<{ ok: true; settings: EInvoiceSettings } | { ok: false; error: string }> {
  const mode = input.mode === "intermediary" ? "intermediary" : "own";
  const tin = text(input.tin, 20)?.toUpperCase() ?? null;
  if (tin && !/^[A-Z]{1,2}\d{8,13}$/.test(tin)) return { ok: false, error: "A TIN is a letter or two and then digits, like C1234567890." };
  const msic = text(input.msicCode, 5);
  if (msic && !/^\d{5}$/.test(msic)) return { ok: false, error: "The MSIC code is five digits, like 93119." };
  const state = text(input.stateCode, 2);
  if (state && !STATE_CODES[state]) return { ok: false, error: "Choose the state." };
  const email = text(input.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "That email address does not look right." };
  const before = await settingsRow(venueId);
  const secret = text(input.clientSecret, 200);
  const row: Omit<SettingsRow, "venue_id"> = {
    enabled: input.enabled === true ? 1 : 0,
    sandbox: input.sandbox === false ? 0 : 1,
    mode,
    client_id: text(input.clientId, 100),
    client_secret: secret ? seal(secret) : (before?.client_secret ?? null),
    tin,
    brn: text(input.brn, 30),
    msic_code: msic,
    msic_name: text(input.msicName, 200),
    legal_name: text(input.legalName, 200),
    address_line: text(input.addressLine, 200),
    city: text(input.city, 80),
    postcode: text(input.postcode, 10),
    state_code: state,
    phone: text(input.phone, 30),
    email,
  };
  if (row.enabled === 1) {
    const missing = missingOf({ venue_id: venueId, ...row });
    if (missing.length > 0) return { ok: false, error: `Still needed before turning it on: ${missing.join(", ")}.` };
  }
  const cols = Object.keys(row) as (keyof typeof row)[];
  await getDb()
    .prepare(
      `INSERT INTO einvoice_settings (venue_id, ${cols.join(", ")}) VALUES (?, ${cols.map(() => "?").join(", ")})
       ON CONFLICT (venue_id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}, updated_at = datetime('now')`
    )
    .run(venueId, ...cols.map((c) => row[c]));
  return { ok: true, settings: await einvoiceSettings(venueId) };
}

/** How to reach MyInvois for this venue, or null when it cannot be. */
async function connectionFor(venueId: number): Promise<Connection | null> {
  const r = await settingsRow(venueId);
  if (!r || !r.tin) return null;
  if (r.mode === "intermediary") {
    if (!intermediaryAvailable()) return null;
    return {
      sandbox: r.sandbox === 1,
      clientId: process.env.MYINVOIS_CLIENT_ID!.trim(),
      clientSecret: process.env.MYINVOIS_CLIENT_SECRET!.trim(),
      onBehalfOf: r.tin,
    };
  }
  const secret = r.client_secret ? unseal(r.client_secret) : null;
  if (!r.client_id || !secret) return null;
  return { sandbox: r.sandbox === 1, clientId: r.client_id, clientSecret: secret, onBehalfOf: null };
}

/** Sign in to MyInvois with the venue's settings, to show they work. */
export async function testEInvoiceConnection(venueId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const c = await connectionFor(venueId);
  if (!c) return { ok: false, error: "Fill in the MyInvois credentials and the TIN first." };
  try {
    const { token } = await import("./myinvois/client");
    await token(c);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "MyInvois could not be reached." };
  }
}

async function supplierFor(venueId: number): Promise<Supplier | null> {
  const r = await settingsRow(venueId);
  if (!r || missingOf(r).length > 0) return null;
  const tax = await venueTax(venueId);
  return {
    tin: r.tin!,
    idType: "BRN",
    idNumber: r.brn!,
    sst: tax.registered ? tax.regNo : null,
    name: r.legal_name!,
    addressLine: r.address_line!,
    city: r.city!,
    postcode: r.postcode!,
    stateCode: r.state_code!,
    country: "MYS",
    phone: r.phone!,
    email: r.email!,
    msicCode: r.msic_code!,
    msicName: r.msic_name ?? "NA",
  };
}

// ------------------------------------------------------------ what is sent

/**
 * Where a document stands (docs/integrations/myinvois.md#states-and-what-never-changes):
 *
 * - `pending`: written down, not sent yet: a draft. Its lines are drawn when
 *   it is sent, from the receipts as they are then, so a draft follows its
 *   receipt; they name nobody (the receipt's number and the kind of sale, or
 *   for a consolidated one the kind of sale and the month). A credit note
 *   stays pending until what it corrects is valid at LHDN.
 * - `failed`: not sent: the venue's details were incomplete, nothing was
 *   left to send, or MyInvois could not be reached. Still a draft, sent
 *   again as it is once put right. Unless its outcome is unknown
 *   (`outcomeUnknown`, migration 0260): MySenam asked LHDN and never
 *   recorded the answer, so LHDN may hold it. That is shown as needing
 *   verification, never as not sent, and is sent again only once staff say
 *   LHDN does not have it (`retryEInvoice`), or recorded as sent once staff
 *   give LHDN's identifiers and LHDN confirms them (`recordFromPortal`).
 * - `rejected`: LHDN refused it when it was sent: it has a submission ID and
 *   LHDN's reasons, no UUID.
 * - `submitted`: LHDN accepted it for validation and gave it a UUID.
 * - `valid`: LHDN validated it: its long ID makes the public link.
 * - `invalid`: LHDN validated it and found it invalid, with its reasons.
 * - `cancelled`: LHDN reported it cancelled (cancelling is done in the
 *   MyInvois portal; MySenam only records what LHDN says).
 *
 * Once a document has reached LHDN (rejected, submitted or after), what it
 * said, its totals and LHDN's identifiers never change and it is never
 * deleted: the database refuses (migration 0220). Only LHDN's verdict moves
 * on, until the statutory period has passed: then the retention run clears
 * its payload, buyer and LHDN's reasons and keeps the rest as a tombstone
 * for the books (`pruneEInvoices`, the trigger's one exception, migration
 * 0226). A correction is always a new document: a replacement, under its own
 * number and linked to the one it replaces, for one LHDN refused, found
 * invalid or reported cancelled; a credit note for a sale reversed after
 * its e-invoice was sent.
 */
export type EInvoiceStatus = "pending" | "submitted" | "valid" | "invalid" | "failed" | "rejected" | "cancelled";

/** LHDN holds none of these as a valid document: put right by a replacement, never by sending it again. */
export const REFUSED_STATUSES: readonly EInvoiceStatus[] = ["invalid", "rejected", "cancelled"];
const REFUSED = "('invalid', 'rejected', 'cancelled')";
/** A row nothing of which has reached LHDN (and not a tombstone left by the retention run). */
const UNSENT = "document IS NULL AND submission_uid IS NULL AND uuid IS NULL AND cleared_at IS NULL";

/**
 * What staff can do with a document now; the route refuses anything else.
 * `send`: one never sent, again as it is. `replace`: a new document in place
 * of one LHDN refused, found invalid or reported cancelled. `recheck`: ask
 * LHDN where one it accepted stands (how a cancellation made in the portal
 * reaches MySenam).
 */
export type EInvoiceAction = "send" | "replace" | "recheck" | "record";

/** One step in a document's attempts to reach LHDN (`e_invoice_attempts`, migration 0260). */
export interface EInvoiceAttempt {
  at: string;
  event: "claimed" | "sent" | "rejected" | "not_sent" | "outcome_unknown" | "confirmed_not_at_lhdn" | "recorded_from_portal";
  /** The staff member, for a step staff took. */
  by: string | null;
  detail: string | null;
}

export interface EInvoice {
  id: number;
  venueId: number;
  kind: "consolidated" | "consolidated_credit" | "individual";
  typeCode: "01" | "02";
  codeNumber: string;
  period: string | null;
  receiptRef: string | null;
  receiptNumber: string | null;
  buyerName: string | null;
  /** A single large sale's own e-invoice, made out to the general public at month end. */
  largeSale: boolean;
  total: number;
  uuid: string | null;
  submissionUid: string | null;
  longId: string | null;
  status: EInvoiceStatus;
  /**
   * What the document is to anyone reading it: `unknown` for a draft whose outcome at LHDN is not known (its
   * `status` is still `failed`), else its `status`.
   */
  state: EInvoiceStatus | "unknown";
  /** `unknown`: MySenam asked LHDN and never recorded the answer, so LHDN may hold it; null otherwise. */
  outcome: "unknown" | null;
  outcomeUnknown: boolean;
  /** When that was found. */
  outcomeUnknownAt: string | null;
  /** When the latest attempt to send it began; null before one. */
  lastAttemptAt: string | null;
  /** Each attempt to send it, and each staff step on it, oldest first. */
  history: EInvoiceAttempt[];
  /** Why it was not sent, or LHDN's reasons as LHDN gave them. */
  error: string | null;
  refersCode: string | null;
  createdAt: string;
  submittedAt: string | null;
  /** When LHDN was last asked about it. */
  checkedAt: string | null;
  /** LHDN's public page for a valid one. */
  link: string | null;
  /** Its lines as sent (from the stored document); null until it reaches LHDN. */
  sentLines: { description: string; amount: number }[] | null;
  /** The number of the document it replaces, and of the one that replaced it. */
  replacesCode: string | null;
  replacedByCode: string | null;
  /** Credit notes against it, sent or waiting. */
  correctedBy: string[];
  /**
   * When the retention run cleared it, the statutory period over: its
   * payload, buyer and LHDN's reasons gone, the rest kept for the books.
   */
  clearedAt: string | null;
  /** A credit note waiting for what it corrects to be valid: that document's number. */
  waitingFor: string | null;
  actions: EInvoiceAction[];
  /**
   * Why one LHDN refused may not be replaced: a customer's own whose sale
   * has since gone in a consolidated one (`consolidated`), or that the
   * customer asked for again (`newer`).
   */
  replaceBlocked: "consolidated" | "newer" | null;
}

interface EInvoiceRow {
  id: number;
  venue_id: number;
  kind: EInvoice["kind"];
  type_code: "01" | "02";
  code_number: string;
  period: string | null;
  receipt_ref: string | null;
  receipt_number: string | null;
  buyer: string | null;
  total: number | string;
  document: string | null;
  submission_uid: string | null;
  uuid: string | null;
  long_id: string | null;
  status: EInvoiceStatus;
  error: string | null;
  refers_uuid: string | null;
  refers_code: string | null;
  created_at: string;
  submitted_at: string | null;
  checked_at: string | null;
  replaces_id: number | null;
  series_code: string | null;
  covers: string | null;
  cleared_at: string | null;
  /** Claimed by a sender, until LHDN's answer is written (migration 0256). */
  sending_at: string | null;
  /** LHDN may hold it: its answer was never recorded (migration 0260). */
  outcome_unknown_at: string | null;
  last_attempt_at: string | null;
  /** What the latest attempt sent, while LHDN's answer is unknown (JSON). */
  attempt_payload: string | null;
}

/** It has reached LHDN: what it holds is LHDN's record too, and never changes (a tombstone included). */
const reached = (r: Pick<EInvoiceRow, "document" | "submission_uid" | "uuid" | "cleared_at">) => !!(r.document || r.submission_uid || r.uuid || r.cleared_at);
/** The number a document and its replacements are looked up by: the first one's. */
const seriesOf = (r: Pick<EInvoiceRow, "series_code" | "code_number">) => r.series_code ?? r.code_number;
const isRefused = (s: EInvoiceStatus) => REFUSED_STATUSES.includes(s);
/**
 * A draft whose outcome at LHDN is unknown: MySenam asked LHDN and never recorded the answer, so LHDN may hold it.
 * Rows from before migration 0260 carry only the old error sentence, which counts too.
 */
const isUnknown = (r: Pick<EInvoiceRow, "status" | "document" | "submission_uid" | "uuid" | "cleared_at" | "outcome_unknown_at" | "error">) =>
  r.status === "failed" && !reached(r) && (r.outcome_unknown_at !== null || r.error === SENDING_INTERRUPTED);
/** The same, in SQL (one parameter: `SENDING_INTERRUPTED`). */
const UNKNOWN_SQL = `status = 'failed' AND ${UNSENT} AND (outcome_unknown_at IS NOT NULL OR error = ?)`;

async function rowById(id: number): Promise<EInvoiceRow | undefined> {
  return (await getDb().prepare("SELECT * FROM e_invoices WHERE id = ?").get(id)) as EInvoiceRow | undefined;
}

/** The document a number stands for now: the latest of its series (itself, or the last replacement sent in its place). */
async function currentOf(venueId: number, code: string): Promise<EInvoiceRow | undefined> {
  return (await getDb()
    .prepare("SELECT * FROM e_invoices WHERE venue_id = ? AND COALESCE(series_code, code_number) = ? ORDER BY id DESC LIMIT 1")
    .get(venueId, code)) as EInvoiceRow | undefined;
}

/** A stored document's lines, as sent: each one's words and amount with its tax. */
function sentLinesOf(document: string | null): EInvoice["sentLines"] {
  if (!document) return null;
  try {
    type Value = { _: string | number }[];
    const doc = JSON.parse(document) as {
      Invoice?: { InvoiceLine?: { Item?: { Description?: Value }[]; LineExtensionAmount?: Value; TaxTotal?: { TaxAmount?: Value }[] }[] }[];
    };
    return (doc.Invoice?.[0]?.InvoiceLine ?? []).map((l) => ({
      description: String(l.Item?.[0]?.Description?.[0]?._ ?? ""),
      amount: roundMoney(Number(l.LineExtensionAmount?.[0]?._ ?? 0) + Number(l.TaxTotal?.[0]?.TaxAmount?.[0]?._ ?? 0)),
    }));
  } catch {
    return null;
  }
}

async function historyOf(id: number): Promise<EInvoiceAttempt[]> {
  const rows = (await getDb()
    .prepare("SELECT at, event, admin_name, detail FROM e_invoice_attempts WHERE e_invoice_id = ? ORDER BY id")
    .all(id)) as { at: string; event: EInvoiceAttempt["event"]; admin_name: string | null; detail: string | null }[];
  // The interruption's sentence is said by the screen in its own words.
  return rows.map((a) => ({ at: a.at, event: a.event, by: a.admin_name, detail: a.detail === SENDING_INTERRUPTED ? null : a.detail }));
}

/** The staff member taking a step on a document (for its history). */
export interface StaffActor {
  id: number | null;
  name: string;
}

/** Add a step to a document's history. Append-only (migration 0260). */
async function noteAttempt(id: number, event: EInvoiceAttempt["event"], detail: string | null = null, by: StaffActor | null = null): Promise<void> {
  await getDb()
    .prepare("INSERT INTO e_invoice_attempts (e_invoice_id, event, admin_id, admin_name, detail) VALUES (?, ?, ?, ?, ?)")
    .run(id, event, by?.id ?? null, by?.name ?? null, detail?.slice(0, 1000) ?? null);
}

async function toEInvoice(r: EInvoiceRow): Promise<EInvoice> {
  const db = getDb();
  const sandbox = (await settingsRow(r.venue_id))?.sandbox === 1;
  const buyer = r.buyer ? (JSON.parse(r.buyer) as Party) : null;
  const replacement = (await db.prepare("SELECT code_number FROM e_invoices WHERE replaces_id = ?").get(r.id)) as { code_number: string } | undefined;
  const replaced = r.replaces_id
    ? ((await db.prepare("SELECT code_number FROM e_invoices WHERE id = ?").get(r.replaces_id)) as { code_number: string } | undefined)
    : undefined;
  const correctedBy =
    r.type_code === "01" && !replacement
      ? ((await db
          .prepare("SELECT code_number FROM e_invoices WHERE venue_id = ? AND refers_code = ? AND replaces_id IS NULL ORDER BY id")
          .all(r.venue_id, seriesOf(r))) as { code_number: string }[]).map((c) => c.code_number)
      : [];
  let waitingFor: string | null = null;
  if (r.status === "pending" && r.refers_code) {
    const target = await currentOf(r.venue_id, r.refers_code);
    if (target?.status !== "valid") waitingFor = target?.code_number ?? r.refers_code;
  }
  const actions: EInvoiceAction[] = [];
  let replaceBlocked: EInvoice["replaceBlocked"] = null;
  // A tombstone (the statutory period over) is the books' record only: nothing more is done with it.
  const live = !r.cleared_at;
  const unknown = live && isUnknown(r);
  // Its outcome unknown: LHDN's identifiers may be recorded, or, once staff confirm LHDN does not have it, it is sent again.
  if (unknown) actions.push("record");
  if (live && !reached(r) && r.status === "failed") actions.push("send");
  // A refused one; or, from before migration 0220, one sent again in place and left waiting or failed.
  if (live && !replacement && reached(r) && (isRefused(r.status) || r.status === "pending" || r.status === "failed")) {
    replaceBlocked = await whyNotReplace(r);
    if (!replaceBlocked) actions.push("replace");
  }
  if (live && (r.status === "submitted" || r.status === "valid") && r.uuid) actions.push("recheck");
  return {
    id: r.id,
    venueId: r.venue_id,
    kind: r.kind,
    typeCode: r.type_code,
    codeNumber: r.code_number,
    period: r.period,
    receiptRef: r.receipt_ref,
    receiptNumber: r.receipt_number,
    buyerName: buyer?.name ?? null,
    largeSale: r.kind === "individual" && r.period !== null && !buyer,
    total: Number(r.total),
    uuid: r.uuid,
    submissionUid: r.submission_uid,
    longId: r.long_id,
    status: r.status,
    state: unknown ? "unknown" : r.status,
    outcome: unknown ? "unknown" : null,
    outcomeUnknown: unknown,
    outcomeUnknownAt: r.outcome_unknown_at,
    lastAttemptAt: r.last_attempt_at,
    history: await historyOf(r.id),
    // The sentence an interruption leaves is said by the screen in its own words.
    error: unknown && r.error === SENDING_INTERRUPTED ? null : r.error,
    refersCode: r.refers_code,
    createdAt: r.created_at,
    submittedAt: r.submitted_at,
    checkedAt: r.checked_at,
    link: r.status === "valid" && r.uuid && r.long_id ? validationLink(sandbox, r.uuid, r.long_id) : null,
    sentLines: sentLinesOf(r.document),
    replacesCode: replaced?.code_number ?? null,
    replacedByCode: replacement?.code_number ?? null,
    correctedBy,
    clearedAt: r.cleared_at,
    waitingFor,
    actions,
    replaceBlocked,
  };
}

/**
 * Why a document LHDN refused may not be replaced. Only a customer's own can
 * be held back: when they asked for one again since, or when its sale has
 * gone to LHDN in a consolidated e-invoice since (it would be invoiced
 * twice). A consolidated one sent before migration 0220 did not record
 * which receipts it carried, so its month counts as carrying the sale.
 */
async function whyNotReplace(r: EInvoiceRow): Promise<EInvoice["replaceBlocked"]> {
  if (r.kind !== "individual" || r.period !== null || !r.receipt_number || !r.receipt_ref) return null;
  const db = getDb();
  const newer = await db
    .prepare(
      `SELECT 1 FROM e_invoices WHERE venue_id = ? AND kind = 'individual' AND receipt_number = ?
          AND COALESCE(series_code, code_number) <> ? AND status NOT IN ${REFUSED}`
    )
    .get(r.venue_id, r.receipt_number, seriesOf(r));
  if (newer) return "newer";
  const month = await receiptMonth(r.receipt_ref, r.venue_id);
  if (!month) return null;
  const con = await currentOf(r.venue_id, `CON-${month}`);
  if (!con || isRefused(con.status) || !reached(con)) return null;
  if (con.covers === null) return "consolidated";
  return (JSON.parse(con.covers) as string[]).includes(r.receipt_number) ? "consolidated" : null;
}

/** The month, on the venue's calendar, a receipt was paid in. */
async function receiptMonth(ref: string, venueId: number): Promise<string | null> {
  const db = getDb();
  const id = documentId(ref);
  const at =
    id !== null
      ? ((await db.prepare("SELECT issued_at AS at FROM receipts WHERE id = ?").get(id)) as { at: string | null } | undefined)
      : ((await db.prepare("SELECT paid_at AS at FROM bookings WHERE code = ?").get(ref)) as { at: string | null } | undefined);
  return at?.at ? localMonth(at.at, await zoneOf(venueId)) : null;
}

export async function listEInvoices(venueId: number): Promise<EInvoice[]> {
  const rows = (await getDb()
    .prepare("SELECT * FROM e_invoices WHERE venue_id = ? ORDER BY id DESC LIMIT 100")
    .all(venueId)) as EInvoiceRow[];
  return Promise.all(rows.map(toEInvoice));
}

/**
 * Receipts that stay out of the consolidated one: a large sale's own
 * e-invoice whatever became of it (it may not be consolidated), and a
 * customer's own unless LHDN refused it and nothing has replaced it (the
 * customer may then ask again, or the sale goes in the month's).
 */
async function individuallyInvoiced(venueId: number): Promise<Set<string>> {
  const rows = (await getDb()
    .prepare(
      `SELECT receipt_number FROM e_invoices WHERE venue_id = ? AND kind = 'individual' AND type_code = '01'
          AND (period IS NOT NULL OR status NOT IN ${REFUSED})`
    )
    .all(venueId)) as { receipt_number: string }[];
  return new Set(rows.map((r) => r.receipt_number));
}

const monthBounds = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, "0")}` };
};

/**
 * No single sale above this goes in a consolidated e-invoice: it gets its
 * own. UNVERIFIED: taken from LHDN's e-invoice guideline as read when this
 * was written; not checked against LHDN's current guideline or its sandbox
 * (docs/integrations/myinvois.md#what-is-assumed-and-not-verified).
 */
export const CONSOLIDATION_LIMIT = 10_000;

/** The address part of a receipt's link, from its printed number: a booking's code, or "R<id>". */
async function refOfReceipt(venueId: number, number: string): Promise<string | null> {
  if (!number.startsWith("R-") && !number.startsWith("CN-")) return number;
  const row = (await getDb().prepare("SELECT id FROM receipts WHERE venue_id = ? AND number = ?").get(venueId, number)) as { id: number } | undefined;
  return row ? `R${row.id}` : null;
}

/** The month before this one, on the venue's calendar. */
export async function lastMonthAt(venueId: number): Promise<string> {
  return previousPeriod(todayISO(await zoneOf(venueId)));
}

/** The month before this date's: "2026-10" on any day of November. */
export function previousPeriod(today: string): string {
  const [y, m] = today.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/**
 * The month's documents that go to LHDN consolidated: the sales journal's, less a test booking's receipt and its
 * credit notes, from before the venue went live (lib/test-bookings.ts): no sale was made, so neither is sent.
 */
async function consolidable(venueId: number, from: string, to: string) {
  // A draft venue's try-outs are no sale. Once the venue is live, a test still standing with a payment on it is money
  // that was taken (the owner's rule, 29 October 2026): it goes in, as any sale does, rather than staying hidden.
  const live = (await getDb().prepare("SELECT 1 FROM venues WHERE id = ? AND published_at IS NOT NULL").get(venueId)) !== undefined;
  return (await salesJournal(venueId, from, to)).filter((j) => live || !j.test);
}

/** Lines of a consolidated document: one per kind of sale and tax rate, saying which receipts. */
function consolidatedLines(rows: { number: string; category: Category; gross: number; tax: number; taxRate: number | null }[], period: string): DocLine[] {
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.category}|${r.taxRate ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map((g) => {
    const numbers = g.map((r) => r.number).sort();
    const which = numbers.length <= 6 ? numbers.join(", ") : `${numbers[0]} … ${numbers[numbers.length - 1]}`;
    return {
      description: `${g[0].category}, ${period}: ${g.length} receipt${g.length === 1 ? "" : "s"} (${which})`,
      gross: roundMoney(g.reduce((s, r) => s + Math.abs(r.gross), 0)),
      tax: roundMoney(g.reduce((s, r) => s + Math.abs(r.tax), 0)),
      rate: g[0].taxRate,
      classification: "004",
    };
  });
}

/**
 * The month as LHDN's consolidated documents, written down to send: the
 * receipts nobody asked an e-invoice of their own for, and the credit notes,
 * each against the e-invoice that carried what it reverses. Once a month:
 * a second call finds them already there (a replacement of one keeps the
 * first one's number as its series). UNVERIFIED: that a consolidated
 * e-invoice and consolidated credit notes are made this way (classification
 * 004, buyer the general public, one line per kind of sale and tax rate) is
 * read from LHDN's guideline and samples, not checked in the sandbox.
 */
export async function consolidate(venueId: number, period: string): Promise<EInvoice[]> {
  const db = getDb();
  const code = `CON-${period}`;
  const exists = await db.prepare("SELECT id FROM e_invoices WHERE venue_id = ? AND code_number = ?").get(venueId, code);
  if (exists) return [];
  const { from, to } = monthBounds(period);
  const journal = await consolidable(venueId, from, to);
  // A single sale over the limit may not go in a consolidated e-invoice: it
  // gets its own, made out to the general public unless the customer asked
  // for one in their name already.
  const made: number[] = [];
  const already = await individuallyInvoiced(venueId);
  for (const r of journal.filter((j) => j.type === "Receipt" && j.gross > CONSOLIDATION_LIMIT && !already.has(j.number))) {
    const ref = await refOfReceipt(venueId, r.number);
    if (!ref) continue;
    const row = (await db
      .prepare(
        `INSERT INTO e_invoices (venue_id, kind, type_code, code_number, period, receipt_ref, receipt_number, total)
         VALUES (?, 'individual', '01', ?, ?, ?, ?, ?) ON CONFLICT (venue_id, code_number) DO NOTHING RETURNING id`
      )
      .get(venueId, `EI-${r.number}`, period, ref, r.number, r.gross)) as { id: number } | undefined;
    if (row) made.push(row.id);
  }
  const own = await individuallyInvoiced(venueId);
  const receipts = journal.filter((r) => r.type === "Receipt" && !own.has(r.number) && r.gross > 0);
  if (receipts.length > 0) {
    const total = roundMoney(receipts.reduce((s, r) => s + r.gross, 0));
    const row = (await db
      .prepare("INSERT INTO e_invoices (venue_id, kind, type_code, code_number, period, total) VALUES (?, 'consolidated', '01', ?, ?, ?) RETURNING id")
      .get(venueId, code, period, total)) as { id: number };
    made.push(row.id);
  }

  // Credit notes, by the e-invoice that carried what each reverses.
  const credits = journal.filter((r) => r.type === "Credit note");
  const byTarget = new Map<string, typeof credits>();
  for (const c of credits) {
    const target = await creditTarget(venueId, c.number);
    if (!target) continue; // reverses a sale from before e-invoicing: nothing at LHDN to correct
    byTarget.set(target, [...(byTarget.get(target) ?? []), c]);
  }
  for (const [target, group] of byTarget) {
    const total = roundMoney(group.reduce((s, r) => s + Math.abs(r.gross), 0));
    // A customer's own e-invoice is corrected in their name, not the public's.
    const buyer = (await db.prepare("SELECT buyer FROM e_invoices WHERE venue_id = ? AND code_number = ?").get(venueId, target)) as
      | { buyer: string | null }
      | undefined;
    const row = (await db
      .prepare(
        `INSERT INTO e_invoices (venue_id, kind, type_code, code_number, period, total, refers_code, buyer)
         VALUES (?, 'consolidated_credit', '02', ?, ?, ?, ?, ?) ON CONFLICT (venue_id, code_number) DO NOTHING RETURNING id`
      )
      .get(venueId, `CCN-${period}-${target}`, period, total, target, buyer?.buyer ?? null)) as { id: number } | undefined;
    if (row) made.push(row.id);
  }
  const rows = made.length
    ? ((await db.prepare(`SELECT * FROM e_invoices WHERE id IN (${made.map(() => "?").join(",")}) ORDER BY id`).all(...made)) as EInvoiceRow[])
    : [];
  return Promise.all(rows.map(toEInvoice));
}

/**
 * The e-invoice a credit note corrects, by our code (its series: a
 * replacement sent in its place is followed when the credit note is sent):
 * the receipt's own where it was kept out of the consolidated one, else the
 * consolidated one of its month, whatever LHDN made of it so far (the
 * credit note waits until it is valid).
 */
async function creditTarget(venueId: number, creditNumber: string): Promise<string | null> {
  const db = getDb();
  const note = (await db.prepare("SELECT credits_id, credits_ref FROM receipts WHERE venue_id = ? AND number = ?").get(venueId, creditNumber)) as
    | { credits_id: number | null; credits_ref: string | null }
    | undefined;
  if (!note?.credits_ref) return null;
  const individual = (await db
    .prepare(
      `SELECT COALESCE(series_code, code_number) AS code_number FROM e_invoices
        WHERE venue_id = ? AND kind = 'individual' AND type_code = '01' AND receipt_number = ?
          AND (period IS NOT NULL OR status NOT IN ${REFUSED}) ORDER BY id DESC LIMIT 1`
    )
    .get(venueId, note.credits_ref)) as { code_number: string } | undefined;
  if (individual) return individual.code_number;
  // When the reversed sale happened, on the venue's calendar.
  const zone = await zoneOf(venueId);
  const when = note.credits_id
    ? ((await db.prepare("SELECT issued_at AS at FROM receipts WHERE id = ?").get(note.credits_id)) as { at: string } | undefined)
    : ((await db.prepare("SELECT paid_at AS at FROM bookings WHERE code = ?").get(note.credits_ref)) as { at: string | null } | undefined);
  if (!when?.at) return null;
  const month = localMonth(when.at, zone);
  const consolidated = await db.prepare("SELECT 1 FROM e_invoices WHERE venue_id = ? AND code_number = ?").get(venueId, `CON-${month}`);
  return consolidated ? `CON-${month}` : null;
}

async function zoneOf(venueId: number): Promise<string> {
  const v = (await getDb().prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(venueId)) as
    | { time_zone: string | null; lat: number | null; lng: number | null }
    | undefined;
  return venueZoneOf(v ?? {});
}

/** A stored UTC time, as the month it fell in where the venue is. */
function localMonth(utc: string, zone: string): string {
  const at = new Date(utc.includes("T") ? utc : `${utc.replace(" ", "T")}Z`);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit" }).formatToParts(at);
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
}

// ------------------------------------------------------------ a customer's own

export interface BuyerInput {
  name: unknown;
  tin: unknown;
  idType: unknown;
  idNumber: unknown;
  sst?: unknown;
  email: unknown;
  phone: unknown;
  addressLine: unknown;
  city: unknown;
  postcode: unknown;
  stateCode: unknown;
}

export type RequestResult = { ok: true; einvoice: EInvoice } | Refusal | { ok: false; error: string };

/**
 * A customer asking, from their receipt, for an e-invoice made out to them.
 * Only while its month has not gone to LHDN consolidated, and once.
 */
export async function requestEInvoice(ref: string, receiptToken: string, input: BuyerInput): Promise<RequestResult> {
  const receipt = await receiptFor(ref, receiptToken);
  if (!receipt || receipt.kind !== "receipt") return refuse("EINVOICE_NO_RECEIPT");
  const venueId = await venueOfReceipt(ref);
  if (venueId === null || !(await einvoiceSettings(venueId)).enabled) return refuse("EINVOICE_OFF");
  const buyer = readBuyer(input);
  if (typeof buyer === "string") return { ok: false, error: buyer };
  const db = getDb();
  if (await monthSent(venueId, receipt.paidAt)) return refuse("EINVOICE_TOO_LATE");
  const already = await db
    .prepare(`SELECT id FROM e_invoices WHERE venue_id = ? AND kind = 'individual' AND receipt_number = ? AND status NOT IN ${REFUSED}`)
    .get(venueId, receipt.number);
  if (already) return refuse("EINVOICE_ALREADY");
  const row = (await db
    .prepare(
      `INSERT INTO e_invoices (venue_id, kind, type_code, code_number, receipt_ref, receipt_number, buyer, total)
       VALUES (?, 'individual', '01', ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(venueId, `EI-${receipt.number}-${Date.now().toString(36)}`, ref, receipt.number, JSON.stringify(buyer), receipt.total)) as { id: number };
  await submitOne(row.id).catch(() => undefined);
  return { ok: true, einvoice: await toEInvoice((await rowById(row.id))!) };
}

/**
 * Whether the month a sale was paid in has gone to LHDN consolidated (or is
 * on its way): its consolidated e-invoice, or the replacement sent in its
 * place, is not one LHDN refused.
 */
async function monthSent(venueId: number, paidAt: string | null): Promise<boolean> {
  const month = localMonth(paidAt ?? new Date().toISOString(), await zoneOf(venueId));
  const con = await currentOf(venueId, `CON-${month}`);
  return !!con && !isRefused(con.status);
}

function readBuyer(input: BuyerInput): Party | string {
  const name = text(input.name);
  if (!name || name.length < 2) return "Give the name the e-invoice is made out to.";
  const tin = text(input.tin, 20)?.toUpperCase();
  if (!tin || !/^[A-Z]{1,2}\d{8,13}$/.test(tin)) return "Give a tax number (TIN), like IG12345678910 or C1234567890.";
  const idType = ["NRIC", "BRN", "PASSPORT", "ARMY"].includes(input.idType as string) ? (input.idType as Party["idType"]) : null;
  const idNumber = text(input.idNumber, 30);
  if (!idType || !idNumber) return "Give an IC, passport or business registration number.";
  const email = text(input.email);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Give an email address.";
  const phone = text(input.phone, 30);
  const addressLine = text(input.addressLine);
  const city = text(input.city, 80);
  const postcode = text(input.postcode, 10);
  const stateCode = text(input.stateCode, 2);
  if (!phone || !addressLine || !city || !postcode || !stateCode || !STATE_CODES[stateCode]) return "Give a phone number and a full address.";
  return { tin, idType, idNumber, sst: text(input.sst, 30), name, addressLine, city, postcode, stateCode, country: "MYS", phone, email };
}

async function venueOfReceipt(ref: string): Promise<number | null> {
  const id = documentId(ref);
  if (id !== null) return (await documentById(id))?.venueId ?? null;
  const booking = await findBookingByCode(ref);
  if (!booking) return null;
  const row = (await getDb().prepare("SELECT venue_id FROM courts WHERE id = ?").get(booking.courtId)) as { venue_id: number } | undefined;
  return row?.venue_id ?? null;
}

/** Where a receipt's own e-invoice stands, for the receipt page; available while one can still be asked for. */
export async function einvoiceForReceipt(ref: string, paidAt: string | null): Promise<{ available: boolean; einvoice: EInvoice | null }> {
  const venueId = await venueOfReceipt(ref);
  if (venueId === null) return { available: false, einvoice: null };
  const row = (await getDb()
    .prepare("SELECT * FROM e_invoices WHERE venue_id = ? AND kind = 'individual' AND receipt_ref = ? ORDER BY id DESC LIMIT 1")
    .get(venueId, ref)) as EInvoiceRow | undefined;
  const available = (await einvoiceSettings(venueId)).enabled && !(await monthSent(venueId, paidAt));
  return { available, einvoice: row ? await toEInvoice(row) : null };
}

// ------------------------------------------------------------ sending and checking

/** How long a draft stays claimed by a sender that never wrote LHDN's answer before it counts as interrupted. */
export const SENDING_CLAIM_MINUTES = 15;

/** Said of a draft whose sending was interrupted: it may have reached LHDN, so it is not sent again by itself. */
export const SENDING_INTERRUPTED =
  "Sending was interrupted before LHDN's answer was recorded. Check in the MyInvois portal whether it arrived before sending it again.";

/**
 * Build one draft now, with the venue's details and the receipts as they
 * are, and send it. Only a draft is ever sent: one that has reached LHDN is
 * left as it is (a replacement is sent in its place, `retryEInvoice`).
 *
 * Sent once: the draft is claimed (`sending_at`, migration 0256) in one
 * statement just before LHDN is asked, so of the scheduler and staff sending
 * it at the same moment, or two servers, one sends it and the other leaves
 * it, as a refund is claimed before the gateway is asked. The claim is
 * cleared when LHDN's answer (or the failure) is written.
 *
 * What the failure was decides what it is called (migration 0260): one that
 * certainly did not reach LHDN (details incomplete, nothing to send, no
 * sign-in, no connection) is *not sent*; one that may have (a timeout, a
 * connection cut after the request, an answer that could not be read) is an
 * *unknown outcome* that staff reconcile with LHDN before anything is sent
 * again (`mayHaveReachedLhdn`). Each attempt is written to the document's
 * history.
 */
export async function submitOne(id: number, now = new Date()): Promise<EInvoice> {
  const db = getDb();
  const r = (await rowById(id))!;
  if (r.status !== "pending" || reached(r) || r.sending_at) return toEInvoice(r);
  /** It did not reach LHDN, certainly: not sent, and still a draft. */
  const fail = async (error: string) => {
    const done = await db
      .prepare(`UPDATE e_invoices SET status = 'failed', error = ?, sending_at = NULL, attempt_payload = NULL WHERE id = ? AND ${UNSENT}`)
      .run(error.slice(0, 1000), id);
    if (done.changes === 1) await noteAttempt(id, "not_sent", error);
    return toEInvoice((await rowById(id))!);
  };
  /** LHDN may hold it and MySenam has no answer: kept as a draft, marked unknown, and the venue's staff told once. */
  const unknown = async (error: string) => {
    const done = await db.transaction(async () => {
      const marked = await db
        .prepare(`UPDATE e_invoices SET status = 'failed', error = ?, sending_at = NULL, outcome_unknown_at = datetime('now') WHERE id = ? AND ${UNSENT}`)
        .run(error.slice(0, 1000), id);
      if (marked.changes === 1) await noteAttempt(id, "outcome_unknown", error);
      return marked.changes;
    })();
    if (done === 1) await alertUnknown(r.venue_id, r.code_number);
    return toEInvoice((await rowById(id))!);
  };
  const connection = await connectionFor(r.venue_id);
  const supplier = await supplierFor(r.venue_id);
  if (!connection || !supplier) return fail("The venue's e-invoicing details are not complete.");

  let refers: { codeNumber: string; uuid: string } | null = null;
  if (r.refers_code) {
    // Waits until what it corrects (or the replacement sent in its place) is
    // valid at LHDN. MySenam's own order of things, so a credit note never
    // names a document LHDN may yet find invalid; not an LHDN rule.
    const target = await currentOf(r.venue_id, r.refers_code);
    if (!target?.uuid || target.status !== "valid") return toEInvoice(r);
    refers = { codeNumber: target.code_number, uuid: target.uuid };
  }

  const { lines, covers } = await linesFor(r);
  if (lines.length === 0) return fail("Nothing to send.");
  const doc = buildDocument({
    typeCode: r.type_code,
    codeNumber: r.code_number,
    issuedAt: now,
    currency: region().currency.code,
    supplier,
    buyer: r.buyer ? (JSON.parse(r.buyer) as Party) : null,
    lines,
    refers,
  });
  // Signed in first: a sign-in that fails has sent nothing, so it is not an attempt that might have reached LHDN.
  try {
    await token(connection);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "MyInvois could not be reached.");
  }
  // Claimed, or left to whoever claimed it first. What is about to be sent is kept with the claim, so that if LHDN's
  // answer is never recorded and staff find LHDN holds it, the record says exactly what was sent.
  const claimed = await db.transaction(async () => {
    const took = await db
      .prepare(
        `UPDATE e_invoices SET sending_at = datetime('now'), last_attempt_at = datetime('now'), attempt_payload = ?
          WHERE id = ? AND status = 'pending' AND sending_at IS NULL AND ${UNSENT}`
      )
      .run(JSON.stringify({ document: doc.json, total: doc.gross, covers, refersUuid: refers?.uuid ?? null }), id);
    if (took.changes === 1) await noteAttempt(id, "claimed");
    return took.changes;
  })();
  if (claimed !== 1) return toEInvoice((await rowById(id))!);
  let outcome: Awaited<ReturnType<typeof submitDocument>>;
  try {
    outcome = await submitDocument(connection, r.code_number, doc.json);
  } catch (err) {
    const why = err instanceof Error ? err.message : "MyInvois could not be reached.";
    return mayHaveReachedLhdn(err) ? unknown(why) : fail(why);
  }
  // From here it is LHDN's record too: kept as sent, with LHDN's identifiers
  // (and, refused, LHDN's reasons as given), and never changed after.
  const sent = [doc.json, doc.gross, covers ? JSON.stringify(covers) : null, outcome.submissionUid || null, refers?.uuid ?? null];
  await db.transaction(async () => {
    if (outcome.accepted) {
      await db
        .prepare(
          `UPDATE e_invoices SET status = 'submitted', error = NULL, document = ?, total = ?, covers = ?, submission_uid = ?, refers_uuid = ?,
             uuid = ?, submitted_at = datetime('now'), sending_at = NULL, attempt_payload = NULL WHERE id = ? AND ${UNSENT}`
        )
        .run(...sent, outcome.accepted.uuid, id);
      await noteAttempt(id, "sent", outcome.submissionUid ? `Submission ${outcome.submissionUid}` : null);
    } else {
      const why = (outcome.rejected ?? "MyInvois did not accept it.").slice(0, 1000);
      await db
        .prepare(
          `UPDATE e_invoices SET status = 'rejected', error = ?, document = ?, total = ?, covers = ?, submission_uid = ?, refers_uuid = ?,
             submitted_at = datetime('now'), sending_at = NULL, attempt_payload = NULL WHERE id = ? AND ${UNSENT}`
        )
        .run(why, ...sent, id);
      await noteAttempt(id, "rejected", why);
    }
  })();
  return toEInvoice((await rowById(id))!);
}

/**
 * The venue's staff are told once that a document's outcome at LHDN is unknown, each in their own staff language,
 * so it is not missed (the same path as other venue alerts, `tellVenueStaffEach`). Never throws.
 */
async function alertUnknown(venueId: number, code: string): Promise<void> {
  try {
    const venue = (await getDb().prepare("SELECT name FROM venues WHERE id = ?").get(venueId)) as { name: string } | undefined;
    await tellVenueStaffEach(venueId, (t) => ({
      subject: t("ei10.alert.s", { code }),
      body: t("ei10.alert.b", { code, venue: venue?.name ?? t("r9d.yourVenue") }),
    }));
  } catch (err) {
    if (mustRethrow(err)) throw err;
    console.error("[mysenam] could not tell staff that an e-invoice's outcome is unknown:", err);
  }
}

/**
 * What a draft says, drawn now from the receipts it covers, and which
 * receipts or credit notes those are (for a consolidated one).
 */
async function linesFor(r: EInvoiceRow): Promise<{ lines: DocLine[]; covers: string[] | null }> {
  if (r.kind === "individual") {
    const receipt = r.receipt_ref ? await receiptFor(r.receipt_ref, (await import("./receipts")).receiptToken(r.receipt_ref)) : null;
    if (!receipt) return { lines: [], covers: null };
    // Never whom it was for or who coached: the receipt's number and the kind of sale (the owner's decision of
    // 28 October 2026). The buyer's own details, on a customer's own, are the buyer party's, not the line's.
    const words = await kindOfSale(r.venue_id, receipt.number, receipt.paidAt);
    return {
      lines: [
        {
          description: `Receipt ${receipt.number}: ${words}`,
          gross: receipt.total,
          tax: receipt.tax?.amount ?? 0,
          rate: receipt.tax?.rate ?? null,
          classification: "022",
        },
      ],
      covers: null,
    };
  }
  const { from, to } = monthBounds(r.period!);
  const journal = await consolidable(r.venue_id, from, to);
  if (r.kind === "consolidated") {
    const own = await individuallyInvoiced(r.venue_id);
    const receipts = journal.filter((j) => j.type === "Receipt" && !own.has(j.number) && j.gross > 0);
    return { lines: consolidatedLines(receipts, r.period!), covers: [...new Set(receipts.map((j) => j.number))] };
  }
  const credits: typeof journal = [];
  for (const c of journal.filter((j) => j.type === "Credit note"))
    if ((await creditTarget(r.venue_id, c.number)) === r.refers_code) credits.push(c);
  return { lines: consolidatedLines(credits, r.period!), covers: [...new Set(credits.map((j) => j.number))] };
}

/** A receipt's kind of sale as the books say it (court hire, memberships…): words that name nobody. */
async function kindOfSale(venueId: number, number: string, paidAt: string | null): Promise<string> {
  if (!paidAt) return "sale";
  const { from, to } = monthBounds(localMonth(paidAt, await zoneOf(venueId)));
  const row = (await salesJournal(venueId, from, to)).find((j) => j.type === "Receipt" && j.number === number);
  return row ? row.category.toLowerCase() : "sale";
}

/**
 * Record what LHDN says of one it accepted: submitted to valid (with its
 * long ID), invalid (with LHDN's reasons) or cancelled; valid to cancelled.
 * Anything else changes only when it was last asked. Whether it was decided.
 */
async function applyVerdict(r: EInvoiceRow, s: DocumentStatus): Promise<boolean> {
  const db = getDb();
  if (r.status === "submitted" && s.status === "Valid") {
    await db.prepare("UPDATE e_invoices SET status = 'valid', long_id = COALESCE(long_id, ?), checked_at = datetime('now') WHERE id = ?").run(s.longId, r.id);
    return true;
  }
  if (r.status === "submitted" && s.status === "Invalid") {
    await db
      .prepare("UPDATE e_invoices SET status = 'invalid', error = ?, checked_at = datetime('now') WHERE id = ?")
      .run((s.problems.join("; ") || "LHDN found it invalid.").slice(0, 1000), r.id);
    return true;
  }
  if ((r.status === "submitted" || r.status === "valid") && s.status === "Cancelled") {
    await db.prepare("UPDATE e_invoices SET status = 'cancelled', checked_at = datetime('now') WHERE id = ?").run(r.id);
    return true;
  }
  await db.prepare("UPDATE e_invoices SET checked_at = datetime('now') WHERE id = ?").run(r.id);
  return false;
}

/** What LHDN made of those sent and not yet decided. */
export async function checkSubmitted(venueId?: number): Promise<number> {
  const db = getDb();
  const rows = (await db
    .prepare(`SELECT * FROM e_invoices WHERE status = 'submitted' AND cleared_at IS NULL${venueId ? " AND venue_id = ?" : ""} ORDER BY id LIMIT 50`)
    .all(...(venueId ? [venueId] : []))) as EInvoiceRow[];
  let decided = 0;
  for (const r of rows) {
    const connection = await connectionFor(r.venue_id);
    if (!connection || !r.uuid) continue;
    try {
      if (await applyVerdict(r, await documentStatus(connection, r.uuid))) decided++;
    } catch {
      // Asked again next time.
    }
  }
  return decided;
}

/** Ask LHDN where one it accepted stands now: a cancellation made in the MyInvois portal reaches MySenam this way. */
export async function recheckEInvoice(id: number, venueId: number): Promise<{ ok: true; einvoice: EInvoice } | { ok: false; error: string }> {
  const r = (await getDb().prepare("SELECT * FROM e_invoices WHERE id = ? AND venue_id = ?").get(id, venueId)) as EInvoiceRow | undefined;
  if (!r?.uuid || r.cleared_at || (r.status !== "submitted" && r.status !== "valid")) return { ok: false, error: "Only an e-invoice LHDN has accepted can be checked." };
  const connection = await connectionFor(venueId);
  if (!connection) return { ok: false, error: "Fill in the MyInvois credentials and the TIN first." };
  try {
    await applyVerdict(r, await documentStatus(connection, r.uuid));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "MyInvois could not be reached." };
  }
  return { ok: true, einvoice: await toEInvoice((await rowById(id))!) };
}

/**
 * Send whatever is waiting, for one venue or all. A draft claimed for sending
 * longer ago than `SENDING_CLAIM_MINUTES` (LHDN is given 30 seconds) was
 * interrupted between asking LHDN and writing its answer down, so LHDN may
 * have it: it is marked *outcome unknown* (migration 0260), the claim's start
 * kept as the attempt's time, and the venue's staff told once. Staff check the
 * portal; it is never sent again by itself.
 */
export async function submitPending(venueId?: number, now = new Date()): Promise<number> {
  const db = getDb();
  const interrupted = await db.transaction(async () => {
    const stale = (await db
      .prepare(
        `UPDATE e_invoices SET status = 'failed', error = ?, sending_at = NULL, outcome_unknown_at = datetime('now')
          WHERE status = 'pending' AND sending_at < datetime('now', '-${SENDING_CLAIM_MINUTES} minutes') AND ${UNSENT}${venueId ? " AND venue_id = ?" : ""}
          RETURNING id, venue_id, code_number`
      )
      .all(SENDING_INTERRUPTED, ...(venueId ? [venueId] : []))) as { id: number; venue_id: number; code_number: string }[];
    for (const e of stale) await noteAttempt(e.id, "outcome_unknown", SENDING_INTERRUPTED);
    return stale;
  })();
  for (const e of interrupted) await alertUnknown(e.venue_id, e.code_number);
  const rows = (await db
    .prepare(`SELECT id FROM e_invoices WHERE status = 'pending' AND sending_at IS NULL AND ${UNSENT}${venueId ? " AND venue_id = ?" : ""} ORDER BY id LIMIT 50`)
    .all(...(venueId ? [venueId] : []))) as { id: number }[];
  for (const r of rows) await submitOne(r.id, now);
  return rows.length;
}

/** `confirmedNotAtLhdn`: the document's outcome was unknown and staff confirmed LHDN does not hold it. */
export type RetryResult = { ok: true; einvoice: EInvoice; from: string; confirmedNotAtLhdn?: boolean } | { ok: false; error: string };

/** What a send of a document whose outcome is unknown says until staff confirm LHDN does not have it. */
const UNKNOWN_NEEDS_CONFIRMATION =
  "Whether LHDN holds this e-invoice is not known. Check the MyInvois portal: record LHDN's identifiers if it has it, or confirm it does not and send it again.";

/**
 * Put one right, once the venue has: one never sent is sent as it is; one
 * LHDN refused, found invalid or reported cancelled stays as it was sent,
 * and a new document goes in its place under its own number (`CON-2026-10-R2`),
 * linked to it, its lines drawn afresh from the receipts. Only what
 * `actions` offers; anything else is refused.
 *
 * One whose outcome at LHDN is unknown is never sent blindly: it is refused
 * unless `notAtLhdn` says the manager checked the MyInvois portal and LHDN
 * does not have it, and that confirmation, with who gave it, goes into the
 * document's history (migration 0260).
 */
export async function retryEInvoice(id: number, venueId: number, opts: { notAtLhdn?: boolean; by?: StaffActor } = {}): Promise<RetryResult> {
  const db = getDb();
  const r = (await db.prepare("SELECT * FROM e_invoices WHERE id = ? AND venue_id = ?").get(id, venueId)) as EInvoiceRow | undefined;
  const cannot = "Only an e-invoice that was not sent, or that LHDN refused, found invalid or cancelled, can be sent again.";
  if (!r) return { ok: false, error: cannot };
  if (!reached(r)) {
    const doubtful = isUnknown(r);
    if (doubtful && opts.notAtLhdn !== true) return { ok: false, error: UNKNOWN_NEEDS_CONFIRMATION };
    const done = await db.transaction(async () => {
      const set = await db
        .prepare(
          `UPDATE e_invoices SET status = 'pending', error = NULL, outcome_unknown_at = NULL, attempt_payload = NULL
            WHERE id = ? AND status = 'failed' AND ${UNSENT}${doubtful ? " AND (outcome_unknown_at IS NOT NULL OR error = ?)" : ""}`
        )
        .run(id, ...(doubtful ? [SENDING_INTERRUPTED] : []));
      if (set.changes === 1 && doubtful)
        await noteAttempt(id, "confirmed_not_at_lhdn", "Checked in the MyInvois portal: LHDN does not hold it. Sent again.", opts.by ?? null);
      return set.changes;
    })();
    if (done !== 1) return { ok: false, error: cannot };
    return { ok: true, einvoice: await submitOne(id), from: r.code_number, ...(doubtful ? { confirmedNotAtLhdn: true } : {}) };
  }
  const now = await toEInvoice(r);
  if (!now.actions.includes("replace")) {
    if (now.replaceBlocked === "consolidated")
      return { ok: false, error: "This sale has gone to LHDN in the month's consolidated e-invoice since; a replacement would invoice it twice." };
    if (now.replaceBlocked === "newer") return { ok: false, error: "The customer has asked for another e-invoice for this receipt since." };
    return { ok: false, error: now.replacedByCode ? "It has been replaced already." : cannot };
  }
  const series = seriesOf(r);
  const { n } = (await db
    .prepare("SELECT COUNT(*)::int AS n FROM e_invoices WHERE venue_id = ? AND COALESCE(series_code, code_number) = ?")
    .get(venueId, series)) as { n: number };
  // Two at once: the second finds the number or the replaced one taken, and nothing is made.
  const made = (await db
    .prepare(
      `INSERT INTO e_invoices (venue_id, kind, type_code, code_number, period, receipt_ref, receipt_number, buyer, total, refers_code, replaces_id, series_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`
    )
    .get(venueId, r.kind, r.type_code, `${series}-R${Number(n) + 1}`, r.period, r.receipt_ref, r.receipt_number, r.buyer, r.total, r.refers_code, r.id, series)) as
    | { id: number }
    | undefined;
  if (!made) return { ok: false, error: "It has been replaced already." };
  return { ok: true, einvoice: await submitOne(made.id), from: r.code_number };
}

export type RecordResult = { ok: true; einvoice: EInvoice } | { ok: false; error: string };

/** What the MyInvois portal shows for a submission ID or a document UUID. */
const PORTAL_IDENTIFIER = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * *LHDN has it: record its identifiers*, for a document whose outcome at LHDN is unknown. Staff give the submission
 * ID and/or the document UUID the MyInvois portal shows; MySenam asks LHDN for that submission or document with the
 * venue's own credentials (read-only calls), and records them only when LHDN says the document it holds under them
 * carries this document's number (its internal ID, our number). The document then stands as sent, with what the
 * attempt sent as it was kept at the claim, and moves on as *Ask LHDN again* moves it (valid, invalid, cancelled).
 * A mismatch, a number LHDN does not hold or a lookup that fails changes nothing and says why. UNVERIFIED: the
 * lookups are written from LHDN's published API (`submissionDocuments`, `documentStatus`), against a stand-in only.
 */
export async function recordFromPortal(
  id: number,
  venueId: number,
  input: { submissionUid?: unknown; documentUuid?: unknown },
  by: StaffActor
): Promise<RecordResult> {
  const db = getDb();
  const r = (await db.prepare("SELECT * FROM e_invoices WHERE id = ? AND venue_id = ?").get(id, venueId)) as EInvoiceRow | undefined;
  if (!r || r.cleared_at || !isUnknown(r)) return { ok: false, error: "Only an e-invoice whose outcome at LHDN is unknown can be recorded this way." };
  const given = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  let submissionUid = given(input.submissionUid);
  let uuid = given(input.documentUuid);
  if (!submissionUid && !uuid) return { ok: false, error: "Give the submission ID or the document UUID the MyInvois portal shows." };
  if ([submissionUid, uuid].some((v) => v !== null && !PORTAL_IDENTIFIER.test(v)))
    return { ok: false, error: "That is not an identifier the MyInvois portal shows." };
  const connection = await connectionFor(venueId);
  if (!connection) return { ok: false, error: "Fill in the MyInvois credentials and the TIN first." };

  let status: DocumentStatus;
  try {
    if (submissionUid) {
      const ours = (await submissionDocuments(connection, submissionUid)).filter((d) => d.internalId === r.code_number);
      if (ours.length === 0) return { ok: false, error: `LHDN holds no document numbered ${r.code_number} under that submission ID. Nothing was recorded.` };
      if (uuid && !ours.some((d) => d.uuid === uuid))
        return { ok: false, error: `LHDN holds ${r.code_number} under another document UUID than that one. Nothing was recorded.` };
      uuid ??= ours[0].uuid;
    }
    status = await documentStatus(connection, uuid!);
  } catch (err) {
    return { ok: false, error: `MyInvois could not be asked: ${err instanceof Error ? err.message : "no answer"}. Nothing was changed.` };
  }
  if (status.internalId !== r.code_number)
    return {
      ok: false,
      error: status.internalId
        ? `LHDN holds that document under the number ${status.internalId}, not ${r.code_number}. Nothing was recorded.`
        : `LHDN did not say which document number it holds under that UUID, so it was not recorded.`,
    };
  if (submissionUid && status.submissionUid && status.submissionUid !== submissionUid)
    return { ok: false, error: `LHDN says that document arrived in another submission than that one. Nothing was recorded.` };
  submissionUid ??= status.submissionUid;
  if (await db.prepare("SELECT 1 FROM e_invoices WHERE uuid = ? AND id <> ?").get(uuid, id))
    return { ok: false, error: "Another e-invoice here already holds that document UUID. Nothing was recorded." };

  let kept: { document?: string; total?: number; covers?: string[] | null; refersUuid?: string | null } | null = null;
  try {
    kept = r.attempt_payload ? JSON.parse(r.attempt_payload) : null;
  } catch {
    kept = null;
  }
  const recorded = await db.transaction(async () => {
    // From here it is LHDN's record too. What the attempt sent is as it was kept at the claim (a document marked
    // before migration 0260 kept none: it then holds LHDN's identifiers only).
    const set = await db
      .prepare(
        `UPDATE e_invoices SET status = 'submitted', error = NULL, document = ?, total = ?, covers = ?, refers_uuid = ?,
           submission_uid = ?, uuid = ?, submitted_at = COALESCE(last_attempt_at, datetime('now')), sending_at = NULL, attempt_payload = NULL
          WHERE id = ? AND status = 'failed' AND ${UNKNOWN_SQL}`
      )
      .run(
        kept?.document ?? null,
        kept?.total ?? r.total,
        kept?.covers ? JSON.stringify(kept.covers) : null,
        kept?.refersUuid ?? null,
        submissionUid,
        uuid,
        id,
        SENDING_INTERRUPTED
      );
    if (set.changes === 1)
      await noteAttempt(id, "recorded_from_portal", `Found at LHDN under ${[submissionUid && `submission ${submissionUid}`, `document ${uuid}`].filter(Boolean).join(", ")}; LHDN says ${status.status}.`, by);
    return set.changes;
  })();
  if (recorded !== 1) return { ok: false, error: "It changed while LHDN was being asked. Look at the list again." };
  await applyVerdict((await rowById(id))!, status);
  return { ok: true, einvoice: await toEInvoice((await rowById(id))!) };
}

/**
 * The scheduler's part: in each venue's first seven days of a month, the
 * month before consolidated; then whatever is waiting sent, and whatever was
 * sent checked. UNVERIFIED: the seven days follow LHDN's guideline for
 * consolidated e-invoices as read when this was written, not checked
 * against its current guideline.
 */
export async function runEInvoicing(now = new Date()): Promise<void> {
  const venues = (await getDb().prepare("SELECT venue_id FROM einvoice_settings WHERE enabled = 1").all()) as { venue_id: number }[];
  for (const { venue_id } of venues) {
    const today = todayISO(await zoneOf(venue_id));
    if (Number(today.slice(8, 10)) <= 7) await consolidate(venue_id, previousPeriod(today));
  }
  await submitPending(undefined, now);
  await checkSubmitted();
}

// ------------------------------------------------------------ the statutory period

/**
 * The retention run's part for e-invoices (lib/privacy.ts `pruneOldData`;
 * docs/architecture/privacy.md#e-invoice-records). The install keeps them
 * for its statutory period (lib/einvoice-retention.ts, provisionally 7
 * years from each document's issue); once it has passed:
 *
 * - a document that reached LHDN becomes a **tombstone**: its stored payload
 *   (what it said, the buyer's details in it), the buyer's details given and
 *   LHDN's reasons as given are emptied; its number, kind, dates, total, the
 *   receipts it covered, LHDN's submission ID, UUID and long ID, what it
 *   corrects or replaces and its last state stay, so the books still say
 *   what went to LHDN and LHDN's own record can be found by its UUID. This
 *   is the one change migration 0226's trigger allows on a sent document,
 *   only from here (the transaction says it is the retention run) and only
 *   once the period the database holds has passed;
 * - a draft that never reached LHDN (waiting, or not sent) is deleted: LHDN
 *   never had it, and the receipt it was for stays for the books.
 *
 * The receipts and credit notes themselves are never deleted (their names go
 * at 730 days as before). Inside the caller's transaction. Returns how many
 * rows it cleared or deleted.
 */
export async function pruneEInvoices(): Promise<number> {
  const db = getDb();
  const cutoff = `-${(await (await import("./einvoice-retention")).einvoiceRetention()).years} years`;
  // Its own transaction (a savepoint inside the run's): the trigger's permission lasts only for it, and goes
  // with it if anything is refused.
  return db.transaction(async () => {
    // A draft whose outcome at LHDN is unknown is not "never sent": LHDN may hold it, so it stays until staff settle it.
    const drafts = await db
      .prepare(`DELETE FROM e_invoices WHERE ${UNSENT} AND NOT (${UNKNOWN_SQL}) AND created_at < datetime('now', ?)`)
      .run(SENDING_INTERRUPTED, cutoff);
    await db.prepare("SELECT set_config('mysenam.einvoice_retention', 'on', true)").get();
    const cleared = await db
      .prepare(
        `UPDATE e_invoices SET cleared_at = datetime('now'), document = NULL, buyer = NULL, error = NULL
          WHERE cleared_at IS NULL AND NOT (${UNSENT}) AND COALESCE(submitted_at, created_at) < datetime('now', ?)`
      )
      .run(cutoff);
    await db.prepare("SELECT set_config('mysenam.einvoice_retention', '', true)").get();
    return drafts.changes + cleared.changes;
  })();
}

/** How many e-invoice rows the retention run would clear or delete now. */
export async function einvoicesDue(): Promise<number> {
  const years = (await (await import("./einvoice-retention")).einvoiceRetention()).years;
  const row = (await getDb()
    .prepare(
      `SELECT COUNT(*)::int AS n FROM e_invoices
        WHERE (${UNSENT} AND NOT (${UNKNOWN_SQL}) AND created_at < datetime('now', ?))
           OR (cleared_at IS NULL AND NOT (${UNSENT}) AND COALESCE(submitted_at, created_at) < datetime('now', ?))`
    )
    .get(SENDING_INTERRUPTED, `-${years} years`, `-${years} years`)) as { n: number };
  return Number(row.n);
}

/**
 * A customer's e-invoices, for their data export (lib/privacy.ts
 * `exportCustomerData`): every e-invoice made for a receipt of theirs (their
 * own, with the buyer details they gave; a large sale's, made out to the
 * general public) and the credit notes against them, with where each stands.
 * Kept for the statutory period whether or not the account is, so the
 * export says what is held on that basis.
 */
export async function einvoicesExport(userId: number): Promise<unknown[]> {
  const rows = (await getDb()
    .prepare(
      `WITH mine AS (
         SELECT e.* FROM e_invoices e
          WHERE e.kind = 'individual'
            AND (e.receipt_ref IN (SELECT 'R' || id FROM receipts WHERE user_id = ?)
                 OR e.receipt_ref IN (SELECT code FROM bookings WHERE user_id = ?))
       )
       SELECT e.*, v.name AS venue_name FROM e_invoices e JOIN venues v ON v.id = e.venue_id
        WHERE e.id IN (SELECT id FROM mine)
           OR (e.kind = 'consolidated_credit' AND e.venue_id IN (SELECT venue_id FROM mine)
               AND e.refers_code IN (SELECT COALESCE(series_code, code_number) FROM mine))
        ORDER BY e.id`
    )
    .all(userId, userId)) as (EInvoiceRow & { venue_name: string })[];
  return rows.map((r) => ({
    venue: r.venue_name,
    number: r.code_number,
    kind: r.type_code === "02" ? "credit note" : r.buyer ? "your own e-invoice" : "a large sale's e-invoice, to the general public",
    receipt: r.receipt_number,
    corrects: r.refers_code,
    total: Number(r.total),
    status: isUnknown(r) ? "unknown" : r.status,
    askedAt: r.created_at,
    sentAt: r.submitted_at,
    lhdnUuid: r.uuid,
    buyerDetailsGiven: r.buyer ? (JSON.parse(r.buyer) as Party) : null,
    linesSent: sentLinesOf(r.document),
    clearedAt: r.cleared_at,
    keptBecause:
      "An e-invoice is a tax record the venue must keep for the statutory period (provisionally 7 years from its issue, pending legal verification); it is kept even if this account is closed, and cleared after that period.",
  }));
}
