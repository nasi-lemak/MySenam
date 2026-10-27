import { salesJournal, type Category } from "./accounting";
import { getDb } from "./db";
import { documentById, documentId, lineText } from "./documents";
import { errorText, translator, type ErrorCode } from "./i18n";
import { documentStatus, MyInvoisError, submitDocument, validationLink, type Connection } from "./myinvois/client";
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
 * LHDN's public link, which the receipt shows.
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

export type EInvoiceStatus = "pending" | "submitted" | "valid" | "invalid" | "failed";

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
  total: number;
  uuid: string | null;
  status: EInvoiceStatus;
  error: string | null;
  refersCode: string | null;
  createdAt: string;
  submittedAt: string | null;
  /** LHDN's public page for a valid one. */
  link: string | null;
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
}

async function toEInvoice(r: EInvoiceRow): Promise<EInvoice> {
  const sandbox = (await settingsRow(r.venue_id))?.sandbox === 1;
  const buyer = r.buyer ? (JSON.parse(r.buyer) as Party) : null;
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
    total: Number(r.total),
    uuid: r.uuid,
    status: r.status,
    error: r.error,
    refersCode: r.refers_code,
    createdAt: r.created_at,
    submittedAt: r.submitted_at,
    link: r.status === "valid" && r.uuid && r.long_id ? validationLink(sandbox, r.uuid, r.long_id) : null,
  };
}

export async function listEInvoices(venueId: number): Promise<EInvoice[]> {
  const rows = (await getDb()
    .prepare("SELECT * FROM e_invoices WHERE venue_id = ? ORDER BY id DESC LIMIT 100")
    .all(venueId)) as EInvoiceRow[];
  return Promise.all(rows.map(toEInvoice));
}

/** Receipts already e-invoiced for their own buyer, which stay out of the consolidated one. */
async function individuallyInvoiced(venueId: number): Promise<Set<string>> {
  const rows = (await getDb()
    .prepare(
      "SELECT receipt_number FROM e_invoices WHERE venue_id = ? AND kind = 'individual' AND type_code = '01' AND status IN ('pending', 'submitted', 'valid')"
    )
    .all(venueId)) as { receipt_number: string }[];
  return new Set(rows.map((r) => r.receipt_number));
}

const monthBounds = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, "0")}` };
};

/** LHDN: no single transaction above this may be consolidated. */
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
 * a second call finds them already there.
 */
export async function consolidate(venueId: number, period: string): Promise<EInvoice[]> {
  const db = getDb();
  const code = `CON-${period}`;
  const exists = await db.prepare("SELECT id FROM e_invoices WHERE venue_id = ? AND code_number = ?").get(venueId, code);
  if (exists) return [];
  const { from, to } = monthBounds(period);
  const journal = await salesJournal(venueId, from, to);
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
 * The e-invoice a credit note corrects, by our code: the customer's own where
 * the reversed receipt had one, else the consolidated one of its month.
 */
async function creditTarget(venueId: number, creditNumber: string): Promise<string | null> {
  const db = getDb();
  const note = (await db.prepare("SELECT credits_id, credits_ref FROM receipts WHERE venue_id = ? AND number = ?").get(venueId, creditNumber)) as
    | { credits_id: number | null; credits_ref: string | null }
    | undefined;
  if (!note?.credits_ref) return null;
  const individual = (await db
    .prepare("SELECT code_number FROM e_invoices WHERE venue_id = ? AND kind = 'individual' AND type_code = '01' AND receipt_number = ? AND status <> 'invalid'")
    .get(venueId, note.credits_ref)) as { code_number: string } | undefined;
  if (individual) return individual.code_number;
  // When the reversed sale happened, on the venue's calendar.
  const zone = await zoneOf(venueId);
  const when = note.credits_id
    ? ((await db.prepare("SELECT issued_at AS at FROM receipts WHERE id = ?").get(note.credits_id)) as { at: string } | undefined)
    : ((await db.prepare("SELECT paid_at AS at FROM bookings WHERE code = ?").get(note.credits_ref)) as { at: string | null } | undefined);
  if (!when?.at) return null;
  const month = localMonth(when.at, zone);
  const consolidated = await db.prepare("SELECT code_number FROM e_invoices WHERE venue_id = ? AND code_number = ? AND status <> 'invalid'").get(venueId, `CON-${month}`);
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
    .prepare("SELECT id FROM e_invoices WHERE venue_id = ? AND kind = 'individual' AND receipt_number = ? AND status <> 'invalid'")
    .get(venueId, receipt.number);
  if (already) return refuse("EINVOICE_ALREADY");
  const row = (await db
    .prepare(
      `INSERT INTO e_invoices (venue_id, kind, type_code, code_number, receipt_ref, receipt_number, buyer, total)
       VALUES (?, 'individual', '01', ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(venueId, `EI-${receipt.number}-${Date.now().toString(36)}`, ref, receipt.number, JSON.stringify(buyer), receipt.total)) as { id: number };
  await submitOne(row.id).catch(() => undefined);
  const fresh = (await db.prepare("SELECT * FROM e_invoices WHERE id = ?").get(row.id)) as EInvoiceRow;
  return { ok: true, einvoice: await toEInvoice(fresh) };
}

/** Whether the month a sale was paid in has gone to LHDN consolidated. */
async function monthSent(venueId: number, paidAt: string | null): Promise<boolean> {
  const month = localMonth(paidAt ?? new Date().toISOString(), await zoneOf(venueId));
  const row = await getDb()
    .prepare("SELECT id FROM e_invoices WHERE venue_id = ? AND code_number = ? AND status <> 'invalid'")
    .get(venueId, `CON-${month}`);
  return !!row;
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

/** Build one document now, with the venue's details as they are, and send it. */
export async function submitOne(id: number, now = new Date()): Promise<EInvoice> {
  const db = getDb();
  const r = (await db.prepare("SELECT * FROM e_invoices WHERE id = ?").get(id)) as EInvoiceRow;
  const fail = async (error: string) => {
    await db.prepare("UPDATE e_invoices SET status = 'failed', error = ? WHERE id = ?").run(error.slice(0, 1000), id);
    return toEInvoice((await db.prepare("SELECT * FROM e_invoices WHERE id = ?").get(id)) as EInvoiceRow);
  };
  const connection = await connectionFor(r.venue_id);
  const supplier = await supplierFor(r.venue_id);
  if (!connection || !supplier) return fail("The venue's e-invoicing details are not complete.");

  let refers: { codeNumber: string; uuid: string } | null = null;
  if (r.refers_code) {
    const target = (await db
      .prepare("SELECT uuid, status FROM e_invoices WHERE venue_id = ? AND code_number = ?")
      .get(r.venue_id, r.refers_code)) as { uuid: string | null; status: EInvoiceStatus } | undefined;
    // Waits for what it corrects to be accepted first.
    if (!target?.uuid || target.status === "pending") return toEInvoice(r);
    refers = { codeNumber: r.refers_code, uuid: target.uuid };
  }

  const lines = await linesFor(r);
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
  try {
    const outcome = await submitDocument(connection, r.code_number, doc.json);
    if (outcome.rejected || !outcome.accepted) return fail(outcome.rejected ?? "MyInvois did not accept it.");
    await db
      .prepare(
        `UPDATE e_invoices SET status = 'submitted', error = NULL, document = ?, submission_uid = ?, uuid = ?, refers_uuid = ?,
           submitted_at = datetime('now') WHERE id = ?`
      )
      .run(doc.json, outcome.submissionUid, outcome.accepted.uuid, refers?.uuid ?? null, id);
  } catch (err) {
    return fail(err instanceof MyInvoisError || err instanceof Error ? err.message : "MyInvois could not be reached.");
  }
  return toEInvoice((await db.prepare("SELECT * FROM e_invoices WHERE id = ?").get(id)) as EInvoiceRow);
}

/** What a document says, drawn now from the receipts it covers. */
async function linesFor(r: EInvoiceRow): Promise<DocLine[]> {
  if (r.kind === "individual") {
    const receipt = r.receipt_ref ? await receiptFor(r.receipt_ref, (await import("./receipts")).receiptToken(r.receipt_ref)) : null;
    if (!receipt) return [];
    return [
      {
        description: `Receipt ${receipt.number}: ${receipt.lines[0] ? lineText(receipt.lines[0]) : "sale"}`,
        gross: receipt.total,
        tax: receipt.tax?.amount ?? 0,
        rate: receipt.tax?.rate ?? null,
        classification: "022",
      },
    ];
  }
  const { from, to } = monthBounds(r.period!);
  const journal = await salesJournal(r.venue_id, from, to);
  if (r.kind === "consolidated") {
    const own = await individuallyInvoiced(r.venue_id);
    return consolidatedLines(
      journal.filter((j) => j.type === "Receipt" && !own.has(j.number) && j.gross > 0),
      r.period!
    );
  }
  const credits: typeof journal = [];
  for (const c of journal.filter((j) => j.type === "Credit note"))
    if ((await creditTarget(r.venue_id, c.number)) === r.refers_code) credits.push(c);
  return consolidatedLines(credits, r.period!);
}

/** What LHDN made of those sent and not yet decided. */
export async function checkSubmitted(venueId?: number): Promise<number> {
  const db = getDb();
  const rows = (await db
    .prepare(`SELECT * FROM e_invoices WHERE status = 'submitted'${venueId ? " AND venue_id = ?" : ""} ORDER BY id LIMIT 50`)
    .all(...(venueId ? [venueId] : []))) as EInvoiceRow[];
  let decided = 0;
  for (const r of rows) {
    const connection = await connectionFor(r.venue_id);
    if (!connection || !r.uuid) continue;
    try {
      const s = await documentStatus(connection, r.uuid);
      if (s.status === "Valid") {
        await db.prepare("UPDATE e_invoices SET status = 'valid', long_id = ?, checked_at = datetime('now') WHERE id = ?").run(s.longId, r.id);
        decided++;
      } else if (s.status === "Invalid") {
        await db
          .prepare("UPDATE e_invoices SET status = 'invalid', error = ?, checked_at = datetime('now') WHERE id = ?")
          .run((s.problems.join("; ") || "LHDN found it invalid.").slice(0, 1000), r.id);
        decided++;
      } else {
        await db.prepare("UPDATE e_invoices SET checked_at = datetime('now') WHERE id = ?").run(r.id);
      }
    } catch {
      // Asked again next time.
    }
  }
  return decided;
}

/** Send whatever is waiting, for one venue or all. */
export async function submitPending(venueId?: number, now = new Date()): Promise<number> {
  const rows = (await getDb()
    .prepare(`SELECT id FROM e_invoices WHERE status = 'pending'${venueId ? " AND venue_id = ?" : ""} ORDER BY id LIMIT 50`)
    .all(...(venueId ? [venueId] : []))) as { id: number }[];
  for (const r of rows) await submitOne(r.id, now);
  return rows.length;
}

/** One that failed or was invalid, after the venue has put it right: send it again. */
export async function retryEInvoice(id: number, venueId: number): Promise<EInvoice | null> {
  const done = await getDb()
    .prepare("UPDATE e_invoices SET status = 'pending', error = NULL WHERE id = ? AND venue_id = ? AND status IN ('failed', 'invalid')")
    .run(id, venueId);
  if (done.changes !== 1) return null;
  return submitOne(id);
}

/**
 * The scheduler's part: in each venue's first seven days of a month, the
 * month before consolidated; then whatever is waiting sent, and whatever was
 * sent checked.
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
