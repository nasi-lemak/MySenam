import sharp from "sharp";
import { logAction } from "./activity";
import { activityName } from "./activity-registry";
import { venueMayOffer } from "./activities";
import type { Admin } from "./admin-auth";
import { policyBreaches } from "./booking-policy";
import { claim, isConflict, release } from "./claims";
import { courtFor, courtOffers } from "./court-activities";
import { getDb, withTransaction } from "./db";
import { venueAheadDays } from "./house-rules";
import { instantOf } from "./interval";
import { customerMayBook } from "./limits";
import { accountLocale, emailPlain, emailPlayer } from "./outbox";
import { phoneRefusal } from "./phone-check";
import { MAX_PIXELS, sniff } from "./photos";
import { addSignOff, signOffHolds, type SignOffKind } from "./sign-offs";
import { courtDay, createBookingSeries, getBookingById, getCourt, spanFor } from "./store";
import { venueBaseUrl } from "./storefront";
import { addDays, isBookableDate, isValidDateString, todayISO } from "./time";
import { GUARDIAN_AGE } from "./tournaments";
import type { Phrase } from "./i18n";
import type { Booking, Sport } from "./types";
import { currentWaiver, signWaiver, waiverSigned } from "./waivers";

/**
 * Registering online for an activity that needs a sign-off or certification
 * (docs/features/activities.md#registering-online-for-approval; ADR 0019).
 *
 * A venue says, per activity, what it asks before it approves somebody:
 * questions, an online declaration, documents staff review (a certificate:
 * never identity documents), a video briefing to confirm, and an in-person
 * briefing or assessment that only staff can record. A signed-in customer
 * applies from their account; the venue's staff, or a coach the venue lists
 * and authorises for that activity, review it from wherever they are:
 * approve, reject, or ask for more (the customer answers and it comes back).
 *
 * An application is its own record, never a booking. Approved, it writes the
 * sign-off or certification the booking rules already check
 * (lib/sign-offs.ts), linked to the customer's account and lasting as long as
 * the venue says; every booking path keeps working as it did. Until then it
 * grants nothing: no booking of the activity, no door code, no place.
 *
 * A slot asked for alongside is held by an expiring claim of its own kind
 * (lib/claims.ts), let go on rejection, withdrawal or expiry, or when its
 * time runs out. Approved, the slot is booked through the ordinary booking
 * path, under the same constraints as any booking: the hold is let go and the
 * booking claimed in one transaction. If the hold had lapsed and the slot is
 * gone, nothing is overbooked: the customer is offered the waiting list or
 * another time. Nothing is charged while an application waits; a booking it
 * becomes is paid, refunded and cancelled like any other.
 */

export type ApprovalStatus = "pending" | "info_requested" | "in_person_due" | "approved" | "rejected" | "withdrawn" | "expired";
/** Statuses an application is still open in. */
export const LIVE_STATUSES: ApprovalStatus[] = ["pending", "info_requested", "in_person_due"];
export type SlotStatus = "held" | "lapsed" | "released" | "booked" | "taken";

export interface ApprovalQuestion {
  id: string;
  text: string;
  required: boolean;
}

export interface ApprovalRequirement {
  id: number;
  venueId: number;
  sport: Sport;
  kind: SignOffKind;
  intro: string | null;
  declaration: string | null;
  documentLabel: string | null;
  videoUrl: string | null;
  inPerson: string | null;
  questions: ApprovalQuestion[];
  waiver: boolean;
  validDays: number | null;
  pendingDays: number;
  holdHours: number;
  open: boolean;
  /** Coaches the venue lists who may review these applications at their own link. */
  coachIds: number[];
}

export interface ApprovalEvent {
  at: string;
  actor: "customer" | "staff" | "coach" | "system";
  actorName: string;
  action: string;
  reason: string | null;
}

export interface ApprovalDocumentInfo {
  id: number;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface ApprovalRequest {
  id: number;
  requirementId: number;
  venueId: number;
  venueName: string;
  sport: Sport;
  userId: number;
  name: string;
  phone: string;
  status: ApprovalStatus;
  renewalOf: number | null;
  answers: Record<string, string>;
  /** The venue's questions as they stand, to read the answers against. */
  questions: ApprovalQuestion[];
  kind: SignOffKind;
  inPersonStep: string | null;
  declaredAt: string | null;
  videoWatchedAt: string | null;
  waiverSignedAt: string | null;
  declaredAdult: boolean;
  guardianName: string | null;
  guardianDeclaredAt: string | null;
  certReference: string | null;
  certExpiresOn: string | null;
  onlineOkAt: string | null;
  onlineOkBy: string | null;
  inPersonAt: string | null;
  inPersonBy: string | null;
  expiresAt: string;
  decidedAt: string | null;
  validUntil: string | null;
  /** Approved, and past the last day it held: to renew. */
  lapsed: boolean;
  /** Approved, then taken back by the venue (the sign-off it wrote was withdrawn). */
  revoked: boolean;
  slot: { courtId: number; courtName: string; date: string; start: number; end: number; holdUntil: string | null; status: SlotStatus } | null;
  bookingCode: string | null;
  documents: ApprovalDocumentInfo[];
  events: ApprovalEvent[];
  createdAt: string;
}

/** Who decides: the venue's staff, or a coach it authorised, at their own link. */
export type Reviewer =
  | { kind: "staff"; admin: Pick<Admin, "id" | "name"> }
  | { kind: "coach"; coach: { id: number; name: string; venueId: number; active: boolean } };

export type Refused = { ok: false; error: string; code: string; status: number; vars?: Record<string, string | number> };
const refused = (code: string, error: string, status = 400): Refused => ({ ok: false, error, code, status });
const isRefused = (x: unknown): x is Refused => typeof x === "object" && x !== null && (x as Refused).ok === false;

/** At most this many documents on one application, each at most this big as uploaded. */
export const MAX_DOCUMENTS = 3;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
/** A renewal may start this many days before an approval runs out. */
export const RENEW_WITHIN_DAYS = 30;
/** Customers hear this many days ahead that an approval is about to run out. */
export const RENEW_NOTICE_DAYS = 14;

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
const isoOf = (v: unknown): string => iso(v) ?? "";
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const DAY = 86_400_000;
const HOUR = 3_600_000;

// ------------------------------------------------------------ the venue's requirements

interface RequirementRow {
  id: number;
  venue_id: number;
  sport: string;
  kind: SignOffKind;
  intro: string | null;
  declaration: string | null;
  document_label: string | null;
  video_url: string | null;
  in_person: string | null;
  questions: string;
  waiver: number;
  valid_days: number | null;
  pending_days: number;
  hold_hours: number;
  open: number;
}

function parseQuestions(raw: string | null): ApprovalQuestion[] {
  try {
    const list = JSON.parse(raw ?? "[]") as ApprovalQuestion[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function toRequirements(rows: RequirementRow[]): Promise<ApprovalRequirement[]> {
  if (rows.length === 0) return [];
  const reviewers = (await getDb()
    .prepare(`SELECT requirement_id, coach_id FROM approval_reviewers WHERE requirement_id IN (${rows.map(() => "?").join(",")}) ORDER BY coach_id`)
    .all(...rows.map((r) => r.id))) as { requirement_id: number; coach_id: number }[];
  return rows.map((r) => ({
    id: r.id,
    venueId: r.venue_id,
    sport: r.sport,
    kind: r.kind,
    intro: r.intro,
    declaration: r.declaration,
    documentLabel: r.document_label,
    videoUrl: r.video_url,
    inPerson: r.in_person,
    questions: parseQuestions(r.questions),
    waiver: r.waiver === 1,
    validDays: r.valid_days,
    pendingDays: r.pending_days,
    holdHours: r.hold_hours,
    open: r.open === 1,
    coachIds: reviewers.filter((x) => x.requirement_id === r.id).map((x) => x.coach_id),
  }));
}

/** What a venue asks for each activity it takes applications for. */
export async function requirementsAt(venueId: number, opts: { openOnly?: boolean } = {}): Promise<ApprovalRequirement[]> {
  const rows = (await getDb()
    .prepare(`SELECT * FROM approval_requirements WHERE venue_id = ?${opts.openOnly ? " AND open = 1" : ""} ORDER BY sport`)
    .all(venueId)) as RequirementRow[];
  return toRequirements(rows);
}

export async function requirementFor(venueId: number, sport: string): Promise<ApprovalRequirement | null> {
  const row = (await getDb().prepare("SELECT * FROM approval_requirements WHERE venue_id = ? AND sport = ?").get(venueId, sport)) as RequirementRow | undefined;
  return row ? (await toRequirements([row]))[0] : null;
}

/** Words that name identity documents, which the platform never collects (AGENTS.md). */
const IDENTITY_DOCUMENT = /\b(ic|nric|mykad|mykid|passport|pasport|identity|identification|kad pengenalan|pengenalan diri|身份证|护照|அடையாள)\b/i;

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);

/**
 * Take applications online for an activity here, or change what is asked.
 * Managers only (lib/roles.ts). Applications already in keep what they
 * answered; they are decided against what is asked now.
 */
export async function saveRequirement(
  venueId: number,
  input: Record<string, unknown>
): Promise<{ ok: true; requirement: ApprovalRequirement } | { ok: false; error: string }> {
  const sport = typeof input.sport === "string" ? input.sport : "";
  if (!sport || !(await venueMayOffer(venueId, sport))) return { ok: false, error: "Unknown sport." };
  const kind = input.kind ?? "operational";
  if (kind !== "operational" && kind !== "certification") return { ok: false, error: "A sign-off or a certification." };
  const intro = text(input.intro, 1000);
  const declaration = text(input.declaration, 2000);
  if (declaration !== null && declaration.length < 10) return { ok: false, error: "Write the declaration in full, or leave it out." };
  const documentLabel = text(input.documentLabel, 200);
  if (documentLabel !== null && IDENTITY_DOCUMENT.test(documentLabel))
    return { ok: false, error: "Ask only for a document the activity needs, such as a certificate: never an identity document." };
  const videoUrl = text(input.videoUrl, 500);
  if (videoUrl !== null && !/^https:\/\/[^\s]+$/.test(videoUrl)) return { ok: false, error: "The briefing video is a link starting https://." };
  const inPerson = text(input.inPerson, 300);
  const rawQuestions = input.questions === undefined || input.questions === null ? [] : input.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length > 10) return { ok: false, error: "Up to 10 questions." };
  const questions: ApprovalQuestion[] = [];
  for (const [i, q] of (rawQuestions as Record<string, unknown>[]).entries()) {
    const words = text(q?.text, 300);
    if (!words || words.length < 3) return { ok: false, error: "Each question needs its words." };
    questions.push({ id: `q${i + 1}`, text: words, required: q?.required !== false });
  }
  if (!declaration && !documentLabel && !videoUrl && !inPerson && questions.length === 0)
    return { ok: false, error: "Ask for at least one thing: a declaration, a document, a briefing video or an in-person step." };
  if (!declaration && !documentLabel && !videoUrl && !inPerson)
    return { ok: false, error: "Questions alone are not a check: add a declaration, a document, a briefing video or an in-person step." };
  if (kind === "certification" && !documentLabel) return { ok: false, error: "A certification is checked against a document: say which one to send." };
  const num = (v: unknown, fallback: number | null, min: number, max: number): number | null | "bad" => {
    if (v === undefined || v === "") return fallback;
    if (v === null) return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : "bad";
  };
  const validDays = num(input.validDays, null, 1, 3660);
  if (validDays === "bad") return { ok: false, error: "An approval lasts 1 to 3660 days, or until taken back." };
  const pendingDays = num(input.pendingDays, 14, 1, 90);
  if (pendingDays === "bad" || pendingDays === null) return { ok: false, error: "An application nobody acts on lapses after 1 to 90 days." };
  const holdHours = num(input.holdHours, 48, 1, 336);
  if (holdHours === "bad" || holdHours === null) return { ok: false, error: "A slot asked for is held 1 to 336 hours." };
  const coachIds = Array.isArray(input.coachIds) ? [...new Set(input.coachIds.map(Number))] : [];
  const db = getDb();
  if (coachIds.length > 0) {
    const ours = (await db
      .prepare(`SELECT id FROM coaches WHERE venue_id = ? AND id IN (${coachIds.map(() => "?").join(",")})`)
      .all(venueId, ...coachIds)) as { id: number }[];
    if (ours.length !== coachIds.length) return { ok: false, error: "Coach not found." };
  }
  const id = await withTransaction(async () => {
    const row = (await db
      .prepare(
        `INSERT INTO approval_requirements (venue_id, sport, kind, intro, declaration, document_label, video_url, in_person, questions, waiver, valid_days, pending_days, hold_hours, open)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (venue_id, sport) DO UPDATE SET kind = excluded.kind, intro = excluded.intro, declaration = excluded.declaration,
           document_label = excluded.document_label, video_url = excluded.video_url, in_person = excluded.in_person, questions = excluded.questions,
           waiver = excluded.waiver, valid_days = excluded.valid_days, pending_days = excluded.pending_days, hold_hours = excluded.hold_hours,
           open = excluded.open, updated_at = now()
         RETURNING id`
      )
      .get(
        venueId, sport, kind, intro, declaration, documentLabel, videoUrl, inPerson, JSON.stringify(questions),
        input.waiver === true ? 1 : 0, validDays, pendingDays, holdHours, input.open === false ? 0 : 1
      )) as { id: number };
    await db.prepare("DELETE FROM approval_reviewers WHERE requirement_id = ?").run(row.id);
    for (const coach of coachIds) await db.prepare("INSERT INTO approval_reviewers (requirement_id, coach_id) VALUES (?, ?)").run(row.id, coach);
    return row.id;
  });
  const saved = (await getDb().prepare("SELECT * FROM approval_requirements WHERE id = ?").get(id)) as RequirementRow;
  return { ok: true, requirement: (await toRequirements([saved]))[0] };
}

/** No more applications online for it; those in stay to be decided. */
export async function closeRequirement(venueId: number, sport: string): Promise<boolean> {
  const done = await getDb().prepare("UPDATE approval_requirements SET open = 0, updated_at = now() WHERE venue_id = ? AND sport = ?").run(venueId, sport);
  return done.changes === 1;
}

// ------------------------------------------------------------ reading applications

interface RequestRow {
  id: number;
  requirement_id: number;
  venue_id: number;
  venue_name: string;
  sport: string;
  user_id: number;
  name: string;
  phone: string;
  status: ApprovalStatus;
  renewal_of: number | null;
  answers: string;
  declared_at: unknown;
  video_watched_at: unknown;
  waiver_signed_at: unknown;
  declared_adult: number;
  guardian_name: string | null;
  guardian_declared_at: unknown;
  cert_reference: string | null;
  cert_expires_on: string | null;
  online_ok_at: unknown;
  online_ok_by: string | null;
  in_person_at: unknown;
  in_person_by: string | null;
  expires_at: unknown;
  decided_at: unknown;
  valid_until: string | null;
  sign_off_id: number | null;
  court_id: number | null;
  court_name: string | null;
  slot_date: string | null;
  slot_start: number | null;
  slot_end: number | null;
  hold_until: unknown;
  slot_status: SlotStatus | null;
  booking_id: number | null;
  booking_code: string | null;
  created_at: unknown;
  questions: string;
  kind: SignOffKind;
  in_person: string | null;
  sign_off_revoked: unknown;
  sign_off_reason: string | null;
}

const REQUEST_SELECT = `
  SELECT r.*, v.name AS venue_name, c.name AS court_name, b.code AS booking_code,
         q.questions, q.kind, q.in_person,
         -- Taken back by the venue; not merely replaced by a renewal.
         CASE WHEN s.revoked_at IS NOT NULL AND s.revoke_reason IS DISTINCT FROM 'Replaced' THEN s.revoked_at END AS sign_off_revoked,
         s.revoke_reason AS sign_off_reason
    FROM approval_requests r
    JOIN venues v ON v.id = r.venue_id
    JOIN approval_requirements q ON q.id = r.requirement_id
    LEFT JOIN courts c ON c.id = r.court_id
    LEFT JOIN bookings b ON b.id = r.booking_id
    LEFT JOIN sign_offs s ON s.id = r.sign_off_id`;

async function toRequests(rows: RequestRow[]): Promise<ApprovalRequest[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const db = getDb();
  const events = (await db
    .prepare(`SELECT request_id, at, actor, actor_name, action, reason FROM approval_events WHERE request_id IN (${marks}) ORDER BY id`)
    .all(...ids)) as { request_id: number; at: unknown; actor: ApprovalEvent["actor"]; actor_name: string; action: string; reason: string | null }[];
  const docs = (await db
    .prepare(`SELECT id, request_id, content_type, size, created_at FROM approval_documents WHERE request_id IN (${marks}) ORDER BY id`)
    .all(...ids)) as { id: number; request_id: number; content_type: string; size: number; created_at: unknown }[];
  const today = todayISO();
  return rows.map((r) => {
    let answers: Record<string, string> = {};
    try {
      answers = JSON.parse(r.answers) as Record<string, string>;
    } catch {
      answers = {};
    }
    return {
      id: r.id,
      requirementId: r.requirement_id,
      venueId: r.venue_id,
      venueName: r.venue_name,
      sport: r.sport,
      userId: r.user_id,
      name: r.name,
      phone: r.phone,
      status: r.status,
      renewalOf: r.renewal_of,
      answers,
      questions: parseQuestions(r.questions),
      kind: r.kind,
      inPersonStep: r.in_person,
      declaredAt: iso(r.declared_at),
      videoWatchedAt: iso(r.video_watched_at),
      waiverSignedAt: iso(r.waiver_signed_at),
      declaredAdult: r.declared_adult === 1,
      guardianName: r.guardian_name,
      guardianDeclaredAt: iso(r.guardian_declared_at),
      certReference: r.cert_reference,
      certExpiresOn: r.cert_expires_on,
      onlineOkAt: iso(r.online_ok_at),
      onlineOkBy: r.online_ok_by,
      inPersonAt: iso(r.in_person_at),
      inPersonBy: r.in_person_by,
      expiresAt: isoOf(r.expires_at),
      decidedAt: iso(r.decided_at),
      validUntil: r.valid_until,
      lapsed: r.status === "approved" && r.valid_until !== null && r.valid_until < today,
      revoked: r.status === "approved" && (r.sign_off_revoked !== null || (r.sign_off_id === null && r.sign_off_reason === null)),
      slot:
        r.court_id !== null && r.slot_date !== null && r.slot_start !== null && r.slot_end !== null && r.slot_status !== null
          ? {
              courtId: r.court_id,
              courtName: r.court_name ?? "",
              date: r.slot_date,
              start: r.slot_start,
              end: r.slot_end,
              holdUntil: iso(r.hold_until),
              status: r.slot_status,
            }
          : null,
      bookingCode: r.booking_code,
      documents: docs
        .filter((d) => d.request_id === r.id)
        .map((d) => ({ id: d.id, contentType: d.content_type, size: d.size, createdAt: isoOf(d.created_at) })),
      events: events
        .filter((e) => e.request_id === r.id)
        .map((e) => ({ at: isoOf(e.at), actor: e.actor, actorName: e.actor_name, action: e.action, reason: e.reason })),
      createdAt: isoOf(r.created_at),
    };
  });
}

export async function requestById(id: number): Promise<ApprovalRequest | null> {
  const row = (await getDb().prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(id)) as RequestRow | undefined;
  return row ? (await toRequests([row]))[0] : null;
}

/** A customer's own applications, newest first. */
export async function customerApprovals(userId: number): Promise<ApprovalRequest[]> {
  const rows = (await getDb().prepare(`${REQUEST_SELECT} WHERE r.user_id = ? ORDER BY r.id DESC LIMIT 100`).all(userId)) as RequestRow[];
  return toRequests(rows);
}

/** A venue's applications: those waiting on somebody first, then the latest decided. */
export async function venueApprovals(venueId: number, opts: { waitingOnly?: boolean } = {}): Promise<ApprovalRequest[]> {
  const rows = (await getDb()
    .prepare(
      `${REQUEST_SELECT} WHERE r.venue_id = ?${opts.waitingOnly ? " AND r.status IN ('pending', 'in_person_due')" : ""}
        ORDER BY (r.status IN ('pending', 'info_requested', 'in_person_due')) DESC, r.id DESC LIMIT 200`
    )
    .all(venueId)) as RequestRow[];
  return toRequests(rows);
}

/** The applications a coach is authorised to review: for the activities the venue named them for. */
export async function coachApprovals(coachId: number): Promise<ApprovalRequest[]> {
  const rows = (await getDb()
    .prepare(
      `${REQUEST_SELECT}
        JOIN approval_reviewers ar ON ar.requirement_id = r.requirement_id AND ar.coach_id = ?
        JOIN coaches k ON k.id = ar.coach_id AND k.venue_id = r.venue_id
       ORDER BY (r.status IN ('pending', 'info_requested', 'in_person_due')) DESC, r.id DESC LIMIT 100`
    )
    .all(coachId)) as RequestRow[];
  return toRequests(rows);
}

/** How many applications wait on the venue (to review, or an in-person step to record). */
export async function waitingCount(venueId: number): Promise<number> {
  const row = (await getDb()
    .prepare("SELECT COUNT(*)::int AS n FROM approval_requests WHERE venue_id = ? AND status IN ('pending', 'in_person_due')")
    .get(venueId)) as { n: number };
  return row.n;
}

// ------------------------------------------------------------ documents

/** Check an upload and redraw it, as venue photos are (lib/photos.ts): nothing of the file survives but its pixels. */
async function processDocument(data: Buffer): Promise<{ ok: true; content: Buffer } | Refused> {
  const bad = refused("APR_DOCUMENT_BAD", "Send the document as a photo or scan: JPEG, PNG or WebP, up to 10 MB.");
  if (data.length > MAX_DOCUMENT_BYTES) return bad;
  const kind = sniff(data);
  if (!kind) return bad;
  try {
    const opts = { limitInputPixels: MAX_PIXELS, failOn: "error" as const };
    const meta = await sharp(data, opts).metadata();
    if (meta.format !== kind) return bad;
    const content = await sharp(data, opts).rotate().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    return { ok: true, content };
  } catch {
    return bad;
  }
}

async function storeDocuments(requestId: number, files: Buffer[]): Promise<Refused | null> {
  const processed: Buffer[] = [];
  for (const f of files) {
    const p = await processDocument(f);
    if (!p.ok) return p;
    processed.push(p.content);
  }
  const db = getDb();
  const held = ((await db.prepare("SELECT COUNT(*)::int AS n FROM approval_documents WHERE request_id = ?").get(requestId)) as { n: number }).n;
  if (held + processed.length > MAX_DOCUMENTS) return refused("APR_TOO_MANY_DOCUMENTS", `Up to ${MAX_DOCUMENTS} documents.`);
  for (const content of processed)
    await db.prepare("INSERT INTO approval_documents (request_id, content_type, size, content) VALUES (?, 'image/webp', ?, ?)").run(requestId, content.length, content);
  return null;
}

/**
 * A document, for whoever may see it: the customer it belongs to, the venue's
 * staff, or a coach authorised for that activity there.
 */
export async function documentFor(
  documentId: number,
  who: { userId: number } | { venueId: number } | { coachId: number }
): Promise<{ contentType: string; content: Buffer } | null> {
  const row = (await getDb()
    .prepare(
      `SELECT d.content_type, d.content, r.user_id, r.venue_id, r.requirement_id FROM approval_documents d
         JOIN approval_requests r ON r.id = d.request_id WHERE d.id = ?`
    )
    .get(documentId)) as { content_type: string; content: Uint8Array; user_id: number; venue_id: number; requirement_id: number } | undefined;
  if (!row) return null;
  if ("userId" in who && row.user_id !== who.userId) return null;
  if ("venueId" in who && row.venue_id !== who.venueId) return null;
  if ("coachId" in who && !(await coachMayReview(who.coachId, row.requirement_id, row.venue_id))) return null;
  return { contentType: row.content_type, content: Buffer.from(row.content) };
}

async function coachMayReview(coachId: number, requirementId: number, venueId: number): Promise<boolean> {
  return !!(await getDb()
    .prepare(
      `SELECT 1 FROM approval_reviewers ar JOIN coaches k ON k.id = ar.coach_id
        WHERE ar.coach_id = ? AND ar.requirement_id = ? AND k.venue_id = ? AND k.active = 1`
    )
    .get(coachId, requirementId, venueId));
}

// ------------------------------------------------------------ history and telling people

async function addEvent(
  requestId: number,
  actor: { kind: ApprovalEvent["actor"]; name: string; adminId?: number | null; coachId?: number | null },
  action: string,
  reason?: string | null
): Promise<void> {
  await getDb()
    .prepare("INSERT INTO approval_events (request_id, actor, admin_id, coach_id, actor_name, action, reason) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(requestId, actor.kind, actor.adminId ?? null, actor.coachId ?? null, actor.name, action, reason?.slice(0, 1000) ?? null);
}

const reviewerActor = (r: Reviewer) =>
  r.kind === "staff"
    ? { kind: "staff" as const, name: r.admin.name, adminId: r.admin.id }
    : { kind: "coach" as const, name: r.coach.name, coachId: r.coach.id };
const reviewerName = (r: Reviewer) => (r.kind === "staff" ? r.admin.name : `${r.coach.name} (coach)`);

/**
 * The staff activity log: staff through logAction; a coach, at their own
 * link, and the system with no admin account, under their own names.
 */
async function logDecision(by: Reviewer | "system", venueId: number, action: string, detail: string, bookingCode?: string | null): Promise<void> {
  if (by !== "system" && by.kind === "staff") return logAction(by.admin, { venueId, action, detail, bookingCode });
  try {
    await getDb()
      .prepare("INSERT INTO staff_actions (admin_id, admin_name, venue_id, booking_code, action, detail) VALUES (NULL, ?, ?, ?, ?, ?)")
      .run(by === "system" ? "Automatic" : `${by.coach.name} (coach link)`, venueId, bookingCode ?? null, action, detail.slice(0, 500));
  } catch (err) {
    console.error("[mysenam] could not write the staff activity log:", err);
  }
}

type CustomerMail =
  | "submitted"
  | "asked"
  | "inPersonDue"
  | "approved"
  | "rejected"
  | "expired"
  | "holdLapsed"
  | "renew";

/** An email to the customer, in the language their account last used, with a link to their applications. */
async function tellCustomer(
  req: Pick<ApprovalRequest, "id" | "userId" | "venueId" | "venueName" | "sport">,
  mail: CustomerMail,
  extra: { reason?: string | null; until?: string | null; code?: string | null; slotTaken?: boolean; step?: string | null } = {},
  dedupe?: string
): Promise<void> {
  const link = `${await venueBaseUrl(req.venueId)}/account/approvals`;
  const vars = (t: { locale: string }) => ({ venue: req.venueName, activity: activityName(req.sport, t.locale) });
  await emailPlayer({
    venueId: req.venueId,
    userId: req.userId,
    subject: (t) => t(`apr.mail.${mail}Subject` as Phrase, vars(t)),
    body: (t) =>
      [
        t(`apr.mail.${mail}` as Phrase, {
          ...vars(t),
          reason: extra.reason ?? "",
          // Approved: "until <date>", or until taken back; a renewal reminder names the day itself.
          until: extra.until ? (mail === "approved" ? t("apr.untilDate", { date: extra.until }) : extra.until) : t("apr.untilTakenBack"),
          step: extra.step ?? "",
        }),
        extra.code ? t("apr.mail.booked", { code: extra.code }) : null,
        extra.slotTaken ? t("apr.mail.slotTaken") : null,
      ]
        .filter(Boolean)
        .join("\n\n"),
    link,
    dedupeKey: dedupe ?? `approval:${req.id}:${mail}:${Date.now()}`,
  });
}

/** Tell the venue's reviewers (its booking-alert address and the coaches it authorised) that an application needs them. */
async function tellReviewers(req: ApprovalRequest, what: "new" | "answered"): Promise<void> {
  const db = getDb();
  const venue = (await db.prepare("SELECT alert_email FROM venues WHERE id = ?").get(req.venueId)) as { alert_email: string | null } | undefined;
  const coaches = (await db
    .prepare(
      `SELECT k.email FROM approval_reviewers ar JOIN coaches k ON k.id = ar.coach_id
        WHERE ar.requirement_id = ? AND k.active = 1 AND k.email IS NOT NULL`
    )
    .all(req.requirementId)) as { email: string }[];
  const to = [...new Set([venue?.alert_email, ...coaches.map((c) => c.email)].filter((e): e is string => !!e))];
  const activity = activityName(req.sport, "en");
  for (const address of to)
    await emailPlain({
      to: address,
      venueId: req.venueId,
      kind: "staff_alert",
      subject: what === "new" ? `New application: ${activity} at ${req.venueName}` : `Application answered: ${activity} at ${req.venueName}`,
      text:
        what === "new"
          ? `${req.name} has applied online to be approved for ${activity} at ${req.venueName}. Review it in the dashboard (the bookings tab, or Courts & rates → Online applications), or at your coach link.`
          : `${req.name} has answered your question about their application for ${activity} at ${req.venueName}. It is waiting for review again.`,
      dedupeKey: `approval:${req.id}:reviewers:${what}:${address}:${Date.now()}`,
    });
}

// ------------------------------------------------------------ holding a slot

/** A slot asked for, as the customer gave it. */
export interface SlotInput {
  courtId: number;
  date: string;
  start: number;
  end: number;
}

function readSlot(raw: unknown): SlotInput | null | "bad" {
  if (raw === undefined || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const slot = { courtId: Number(s.courtId), date: String(s.date ?? ""), start: Number(s.start), end: Number(s.end) };
  if (!Number.isInteger(slot.courtId) || !isValidDateString(slot.date) || !Number.isInteger(slot.start) || !Number.isInteger(slot.end)) return "bad";
  return slot;
}

/**
 * Hold a slot for an application: checked against the court's booking rules
 * as a booking would be, then claimed for a while, so the database counts it
 * as it counts any booking. Nothing is held past the hold's end, or past the
 * slot's own start.
 */
async function holdSlot(requestId: number, venueId: number, sport: Sport, slot: SlotInput, holdHours: number): Promise<{ ok: true; until: Date } | Refused> {
  const bad = refused("APR_SLOT_BAD", "That slot cannot be asked for: pick a time the venue takes bookings for this activity.");
  const found = await getCourt(slot.courtId);
  if (!found || found.venueId !== venueId || !courtOffers(found, sport)) return bad;
  const court = courtFor(found, sport);
  if (court.classesOnly) return bad;
  const day = await courtDay(court, slot.date);
  if (day.closed) return bad;
  const asked = spanFor({ start: slot.start, end: slot.end }, day.policy);
  if (!asked.ok) return bad;
  const span = asked.span;
  const startsAt = instantOf(slot.date, span.start, day.zone);
  const ahead = (startsAt.getTime() - Date.now()) / 60_000;
  if (ahead <= 0 || !isBookableDate(slot.date, day.zone, await venueAheadDays(venueId))) return bad;
  if (policyBreaches(day.policy, span, day, ahead).length > 0) return bad;
  const until = new Date(Math.min(Date.now() + holdHours * HOUR, startsAt.getTime()));
  try {
    await withTransaction(() =>
      claim({
        court,
        source: { kind: "approval", approvalId: requestId },
        date: slot.date,
        span,
        zone: day.zone,
        places: 1,
        bufferBefore: day.policy.bufferBefore,
        bufferAfter: day.policy.bufferAfter,
        expiresAt: until,
      })
    );
  } catch (err) {
    if (isConflict(err)) return refused("APR_SLOT_TAKEN", "That slot is taken. Pick another time, or apply without one.", 409);
    throw err;
  }
  await getDb()
    .prepare("UPDATE approval_requests SET court_id = ?, slot_date = ?, slot_start = ?, slot_end = ?, hold_until = ?, slot_status = 'held', booking_id = NULL WHERE id = ?")
    .run(court.id, slot.date, span.start, span.end, until.toISOString(), requestId);
  return { ok: true, until };
}

/** Let a request's hold go, saying why it ended. */
async function releaseHold(requestId: number, status: "released" | "lapsed"): Promise<boolean> {
  await release({ kind: "approval", approvalId: requestId });
  const done = await getDb().prepare("UPDATE approval_requests SET slot_status = ? WHERE id = ? AND slot_status = 'held'").run(status, requestId);
  return done.changes > 0;
}

/**
 * Book the slot a request asked for, through the ordinary booking path: its
 * hold let go and the booking claimed in one transaction, under the same
 * constraints as any booking. If its time is gone (the hold lapsed and
 * somebody took it), nothing is overbooked: the request says so.
 */
async function bookSlot(requestId: number, assessment: boolean): Promise<{ booking: Booking | null; why: string | null }> {
  const db = getDb();
  const r = (await db
    .prepare(
      `SELECT r.court_id, r.slot_date, r.slot_start, r.slot_end, r.slot_status, r.booking_id, r.sport, r.user_id, u.name, u.phone, u.email
         FROM approval_requests r JOIN users u ON u.id = r.user_id WHERE r.id = ?`
    )
    .get(requestId)) as
    | { court_id: number | null; slot_date: string | null; slot_start: number | null; slot_end: number | null; slot_status: SlotStatus | null; booking_id: number | null; sport: Sport; user_id: number; name: string; phone: string; email: string }
    | undefined;
  if (!r || r.court_id === null || r.slot_date === null || r.slot_start === null || r.slot_end === null || r.booking_id !== null) return { booking: null, why: null };
  if (r.slot_status !== "held" && r.slot_status !== "lapsed") return { booking: null, why: null };
  const made = await createBookingSeries({
    courtId: r.court_id,
    date: r.slot_date,
    start: r.slot_start,
    end: r.slot_end,
    weeks: 1,
    name: r.name,
    phone: r.phone,
    email: r.email,
    userId: r.user_id,
    sport: r.sport,
    by: "customer",
    approval: { id: requestId, assessment },
  });
  if (made.ok) {
    const booking = made.bookings[0];
    await db.prepare("UPDATE approval_requests SET slot_status = 'booked', booking_id = ? WHERE id = ?").run(booking.id, requestId);
    await addEvent(requestId, { kind: "system", name: "MySenam" }, assessment ? "session_booked" : "slot_booked", booking.code);
    return { booking, why: null };
  }
  await release({ kind: "approval", approvalId: requestId });
  await db.prepare("UPDATE approval_requests SET slot_status = 'taken' WHERE id = ?").run(requestId);
  await addEvent(requestId, { kind: "system", name: "MySenam" }, "slot_taken", made.error);
  return { booking: null, why: made.error };
}

// ------------------------------------------------------------ applying

export interface ApplyInput {
  venueId: number;
  sport: string;
  answers?: unknown;
  declaration?: unknown;
  videoWatched?: unknown;
  waiver?: unknown;
  adult?: unknown;
  guardianName?: unknown;
  guardianDeclaration?: unknown;
  certReference?: unknown;
  certExpiresOn?: unknown;
  slot?: unknown;
}

/** Answers to the venue's questions: every needed one given, each kept to a sensible length. */
function readAnswers(questions: ApprovalQuestion[], raw: unknown): Record<string, string> | Refused {
  const given = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const q of questions) {
    const a = typeof given[q.id] === "string" ? (given[q.id] as string).trim().slice(0, 1000) : "";
    if (q.required && a === "") return refused("APR_ANSWER_NEEDED", "Answer every question marked as needed.");
    if (a !== "") out[q.id] = a;
  }
  return out;
}

/**
 * Apply to be approved for an activity at a venue, from a signed-in account.
 * Everything the venue asks is checked here; a slot asked for is held. The
 * application, its documents and its hold are written together, or not at all.
 */
export async function apply(
  user: { id: number; name: string; email: string; phone: string },
  input: ApplyInput,
  files: Buffer[] = []
): Promise<{ ok: true; request: ApprovalRequest } | Refused> {
  const req = await requirementFor(input.venueId, input.sport);
  if (!req || !req.open) return refused("APR_NOT_OFFERED", "This venue does not take applications for that activity online.", 404);
  const noPhone = await phoneRefusal(user.id);
  if (noPhone) return { ...noPhone, code: noPhone.code ?? "PHONE_NEEDED", status: 403 };
  const db = getDb();
  const live = await db
    .prepare("SELECT 1 FROM approval_requests WHERE user_id = ? AND venue_id = ? AND sport = ? AND status IN ('pending', 'info_requested', 'in_person_due')")
    .get(user.id, req.venueId, req.sport);
  if (live) return refused("APR_ALREADY_LIVE", "You already have an application waiting for this activity here.", 409);
  // Already approved for long enough: nothing to apply for until it is close to running out.
  if (
    await signOffHolds({
      venueId: req.venueId,
      sport: req.sport,
      until: addDays(todayISO(), RENEW_WITHIN_DAYS),
      phone: user.phone,
      userId: user.id,
      channel: "customer",
      need: req.kind === "certification" ? "certification" : "any",
    })
  )
    return refused("APR_ALREADY_APPROVED", "You are already approved for this activity here.", 409);
  const answers = readAnswers(req.questions, input.answers);
  if (isRefused(answers)) return answers;
  if (req.declaration && input.declaration !== true) return refused("APR_DECLARATION_NEEDED", "Tick the declaration to go on.");
  if (req.videoUrl && input.videoWatched !== true) return refused("APR_VIDEO_NEEDED", "Watch the briefing video and confirm you have.");
  if (input.adult !== true && input.adult !== false) return refused("APR_ADULT_NEEDED", "Say whether you are 18 or over.");
  let guardianName: string | null = null;
  if (input.adult === false) {
    guardianName = typeof input.guardianName === "string" ? input.guardianName.trim() : "";
    if (guardianName.length < 2 || guardianName.length > 80 || input.guardianDeclaration !== true)
      return refused(
        "APR_GUARDIAN_NEEDED",
        `Under ${GUARDIAN_AGE}: give a parent or guardian's name, and their declaration that they agree to this application.`
      );
  }
  let certReference: string | null = null;
  let certExpiresOn: string | null = null;
  if (req.kind === "certification") {
    certReference = text(input.certReference, 120);
    certExpiresOn = typeof input.certExpiresOn === "string" ? input.certExpiresOn : null;
    if (!certReference || certReference.length < 3 || !certExpiresOn || !isValidDateString(certExpiresOn) || certExpiresOn < todayISO())
      return refused("APR_CERT_NEEDED", "Give the certification's number and issuer, and the day it runs out (today or later).");
  }
  if (req.documentLabel && files.length === 0) return refused("APR_DOCUMENT_NEEDED", "Add the document the venue asks for.");
  if (!req.documentLabel && files.length > 0) return refused("APR_NO_DOCUMENTS", "This venue asks for no documents for this activity.");
  if (files.length > MAX_DOCUMENTS) return refused("APR_TOO_MANY_DOCUMENTS", `Up to ${MAX_DOCUMENTS} documents.`);
  const waiver = req.waiver ? await currentWaiver(req.venueId) : null;
  if (waiver && input.waiver !== true && !(await waiverSigned(req.venueId, user.phone)))
    return refused("APR_WAIVER_NEEDED", "Agree to the venue's waiver to go on.");
  const slot = readSlot(input.slot);
  if (slot === "bad") return refused("APR_SLOT_BAD", "That slot cannot be asked for: pick a time the venue takes bookings for this activity.");
  if (slot) {
    // The venue's own limits, as for any booking online: a refused number, its house rules, who it is for.
    const limited = await customerMayBook({ venueId: req.venueId, phone: user.phone, signedIn: true, userId: user.id, dates: [slot.date] });
    if (limited) return { ...limited, code: limited.code ?? "APR_SLOT_BAD", status: 403 };
  }
  // The approval this renews, if it is one.
  const previous = (await db
    .prepare("SELECT id FROM approval_requests WHERE user_id = ? AND venue_id = ? AND sport = ? AND status = 'approved' ORDER BY id DESC LIMIT 1")
    .get(user.id, req.venueId, req.sport)) as { id: number } | undefined;

  const outcome = await withTransaction(async (): Promise<{ ok: true; id: number } | Refused> => {
    const row = (await db
      .prepare(
        `INSERT INTO approval_requests (requirement_id, venue_id, sport, user_id, name, phone, status, renewal_of, answers, declared_at, video_watched_at,
           waiver_signed_at, declared_adult, guardian_name, guardian_declared_at, cert_reference, cert_expires_on, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ${req.declaration ? "now()" : "NULL"}, ${req.videoUrl ? "now()" : "NULL"},
           ${waiver ? "now()" : "NULL"}, ?, ?, ${guardianName ? "now()" : "NULL"}, ?, ?, ?)
         RETURNING id`
      )
      .get(
        req.id, req.venueId, req.sport, user.id, user.name, user.phone, previous?.id ?? null, JSON.stringify(answers),
        input.adult === true ? 1 : 0, guardianName, certReference, certExpiresOn, later(req.pendingDays * DAY)
      )) as { id: number };
    const docs = await storeDocuments(row.id, files);
    if (docs) throw docs;
    if (waiver) await signWaiver(req.venueId, { phone: user.phone, name: user.name });
    await addEvent(row.id, { kind: "customer", name: user.name }, previous ? "renewal_submitted" : "submitted");
    if (slot) {
      const held = await holdSlot(row.id, req.venueId, req.sport, slot, req.holdHours);
      if (!held.ok) throw held;
      await addEvent(row.id, { kind: "customer", name: user.name }, "slot_requested");
    }
    return { ok: true, id: row.id };
  }).catch((err: unknown) => {
    if (err && typeof err === "object" && (err as Refused).ok === false) return err as Refused;
    // Two submissions at once: the second meets the one-live-request index.
    if ((err as { code?: string })?.code === "23505") return refused("APR_ALREADY_LIVE", "You already have an application waiting for this activity here.", 409);
    throw err;
  });
  if (!outcome.ok) return outcome;
  const request = (await requestById(outcome.id))!;
  await tellCustomer(request, "submitted", {}, `approval:${request.id}:submitted`);
  await tellReviewers(request, "new");
  return { ok: true, request };
}

// ------------------------------------------------------------ the customer's own actions

/** Lock a request for a decision, so two at once cannot both act on it. */
async function lockRequest(id: number): Promise<{ id: number; status: ApprovalStatus; requirement_id: number; venue_id: number; user_id: number } | undefined> {
  return (await getDb()
    .prepare("SELECT id, status, requirement_id, venue_id, user_id FROM approval_requests WHERE id = ? FOR UPDATE")
    .get(id)) as { id: number; status: ApprovalStatus; requirement_id: number; venue_id: number; user_id: number } | undefined;
}

const notFound = () => refused("APR_NOT_FOUND", "Application not found.", 404);
const wrongStatus = () => refused("APR_WRONG_STATUS", "This application cannot do that now.", 409);

/**
 * What a customer does to their own application: answer a reviewer's
 * question (it goes back for review), withdraw it (its hold let go), or ask
 * for a slot (held; once the online part is accepted, booked at once as the
 * in-person session).
 */
export async function customerAct(
  user: { id: number; name: string },
  id: number,
  action: "answer" | "withdraw" | "slot",
  input: { answer?: unknown; slot?: unknown } = {},
  files: Buffer[] = []
): Promise<{ ok: true; request: ApprovalRequest; booking?: Booking | null } | Refused> {
  const db = getDb();
  let tell: (() => Promise<void>) | null = null;
  let booked: Booking | null = null;
  const outcome = await withTransaction(async (): Promise<{ ok: true } | Refused> => {
    const row = await lockRequest(id);
    if (!row || row.user_id !== user.id) return notFound();
    const req = (await requirementById(row.requirement_id))!;
    if (action === "answer") {
      if (row.status !== "info_requested") return wrongStatus();
      const answer = typeof input.answer === "string" ? input.answer.trim().slice(0, 2000) : "";
      if (answer === "" && files.length === 0) return refused("APR_ANSWER_NEEDED", "Write your answer, or add a document.");
      if (files.length > 0) {
        if (!req.documentLabel) return refused("APR_NO_DOCUMENTS", "This venue asks for no documents for this activity.");
        const docs = await storeDocuments(id, files);
        if (docs) throw docs;
      }
      await db.prepare("UPDATE approval_requests SET status = 'pending', expires_at = ? WHERE id = ?").run(later(req.pendingDays * DAY), id);
      await addEvent(id, { kind: "customer", name: user.name }, "answered", answer || null);
      tell = async () => tellReviewers((await requestById(id))!, "answered");
      return { ok: true };
    }
    if (action === "withdraw") {
      if (!LIVE_STATUSES.includes(row.status)) return wrongStatus();
      await db.prepare("UPDATE approval_requests SET status = 'withdrawn', decided_at = now() WHERE id = ?").run(id);
      await releaseHold(id, "released");
      await addEvent(id, { kind: "customer", name: user.name }, "withdrawn");
      return { ok: true };
    }
    // A slot: asked for, or asked for again after the last one went.
    if (!LIVE_STATUSES.includes(row.status)) return wrongStatus();
    const current = (await db.prepare("SELECT booking_id, slot_status FROM approval_requests WHERE id = ?").get(id)) as { booking_id: number | null; slot_status: SlotStatus | null };
    if (current.booking_id !== null) return wrongStatus();
    const slot = readSlot(input.slot);
    if (!slot || slot === "bad") return refused("APR_SLOT_BAD", "That slot cannot be asked for: pick a time the venue takes bookings for this activity.");
    const phone = ((await db.prepare("SELECT phone FROM users WHERE id = ?").get(user.id)) as { phone: string }).phone;
    const limited = await customerMayBook({ venueId: row.venue_id, phone, signedIn: true, userId: user.id, dates: [slot.date] });
    if (limited) return { ...limited, code: limited.code ?? "APR_SLOT_BAD", status: 403 };
    if (current.slot_status === "held") await releaseHold(id, "released");
    const held = await holdSlot(id, row.venue_id, req.sport, slot, req.holdHours);
    if (!held.ok) throw held;
    await addEvent(id, { kind: "customer", name: user.name }, "slot_requested");
    // The online part already accepted: this is the in-person session, booked now.
    if (row.status === "in_person_due") {
      const made = await bookSlot(id, true);
      if (!made.booking) throw refused("APR_SLOT_TAKEN", "That slot is taken. Pick another time, or apply without one.", 409);
      booked = made.booking;
      await extendForSession(id, made.booking);
    }
    return { ok: true };
  }).catch((err: unknown) => {
    if (err && typeof err === "object" && (err as Refused).ok === false) return err as Refused;
    throw err;
  });
  if (!outcome.ok) return outcome;
  if (tell) await (tell as () => Promise<void>)();
  if (booked) await confirmBooking(booked as Booking, user.id);
  return { ok: true, request: (await requestById(id))!, booking: booked };
}

async function requirementById(id: number): Promise<ApprovalRequirement | null> {
  const row = (await getDb().prepare("SELECT * FROM approval_requirements WHERE id = ?").get(id)) as RequirementRow | undefined;
  return row ? (await toRequirements([row]))[0] : null;
}

/** A request waiting on its in-person session does not lapse before the session is over. */
async function extendForSession(id: number, booking: Booking): Promise<void> {
  const after = new Date(new Date(booking.endsAt ?? Date.now()).getTime() + DAY).toISOString();
  await getDb().prepare("UPDATE approval_requests SET expires_at = GREATEST(expires_at, ?::timestamptz) WHERE id = ?").run(after, id);
}

/** The ordinary confirmation of a booking made from an application, in the customer's language (lib/notify.ts). */
async function confirmBooking(booking: Booking, userId: number): Promise<void> {
  const { notifyBookingConfirmed } = await import("./notify");
  await notifyBookingConfirmed([(await getBookingById(booking.id)) ?? booking], await accountLocale(userId), null);
}

// ------------------------------------------------------------ deciding

export type Decision = "approve" | "reject" | "ask" | "in_person";

/** The last day an approval holds: the venue's period, never past a certification's own end. */
function validUntilFor(req: ApprovalRequirement, certExpiresOn: string | null): string | null {
  const period = req.validDays !== null ? addDays(todayISO(), req.validDays - 1) : null;
  if (req.kind === "certification") {
    const own = certExpiresOn ?? period;
    return period && own && period < own ? period : own;
  }
  return period;
}

/**
 * A reviewer's decision: approve (the online part, where an in-person step
 * is still to come; otherwise the whole of it), reject, ask the customer for
 * more, or record the in-person step. Staff of the venue may decide any of
 * its applications; a coach only those for the activities the venue
 * authorised them for, and nothing else. Every decision is in the
 * application's history and the staff activity log, with who, when and why.
 */
export async function decide(
  reviewer: Reviewer,
  id: number,
  action: Decision,
  input: { reason?: unknown; venueId?: number } = {}
): Promise<{ ok: true; request: ApprovalRequest; booking: Booking | null } | Refused> {
  const reason = typeof input.reason === "string" && input.reason.trim() !== "" ? input.reason.trim().slice(0, 1000) : null;
  if ((action === "reject" || action === "ask") && !reason)
    return refused("APR_REASON_NEEDED", action === "ask" ? "Say what you need to know." : "Say why it is refused.");
  const db = getDb();
  let mail: { kind: CustomerMail; extra: Parameters<typeof tellCustomer>[2] } | null = null;
  let booked: Booking | null = null;
  let logged: { action: string; detail: string; code?: string | null } | null = null;
  const outcome = await withTransaction(async (): Promise<{ ok: true } | Refused> => {
    mail = null;
    booked = null;
    logged = null;
    const row = await lockRequest(id);
    if (!row) return notFound();
    if (reviewer.kind === "staff" && input.venueId !== undefined && row.venue_id !== input.venueId) return notFound();
    if (reviewer.kind === "coach" && (!reviewer.coach.active || reviewer.coach.venueId !== row.venue_id || !(await coachMayReview(reviewer.coach.id, row.requirement_id, row.venue_id))))
      return refused("APR_NOT_REVIEWER", "You may not review applications for this activity.", 403);
    const req = (await requirementById(row.requirement_id))!;
    const r = (await db
      .prepare("SELECT name, cert_expires_on, cert_reference, online_ok_at, in_person_at, slot_status FROM approval_requests WHERE id = ?")
      .get(id)) as { name: string; cert_expires_on: string | null; cert_reference: string | null; online_ok_at: unknown; in_person_at: unknown; slot_status: SlotStatus | null };
    const who = reviewerName(reviewer);
    const actor = reviewerActor(reviewer);
    const activity = activityName(req.sport, "en");

    if (action === "ask") {
      if (row.status !== "pending" && row.status !== "info_requested") return wrongStatus();
      await db.prepare("UPDATE approval_requests SET status = 'info_requested', expires_at = ? WHERE id = ?").run(later(req.pendingDays * DAY), id);
      await addEvent(id, actor, "asked", reason);
      mail = { kind: "asked", extra: { reason } };
      logged = { action: "approval.asked", detail: `Asked ${r.name} for more about their application for ${activity}: ${reason}` };
      return { ok: true };
    }
    if (action === "reject") {
      if (!LIVE_STATUSES.includes(row.status)) return wrongStatus();
      await db.prepare("UPDATE approval_requests SET status = 'rejected', decided_at = now() WHERE id = ?").run(id);
      await releaseHold(id, "released");
      await addEvent(id, actor, "rejected", reason);
      mail = { kind: "rejected", extra: { reason } };
      logged = { action: "approval.rejected", detail: `Refused ${r.name}'s application for ${activity}: ${reason}` };
      return { ok: true };
    }

    const onlineOk = r.online_ok_at !== null;
    let inPersonDone = r.in_person_at !== null;
    if (action === "in_person") {
      if (!req.inPerson) return refused("APR_NO_IN_PERSON", "This activity has no in-person step to record.", 409);
      if (!LIVE_STATUSES.includes(row.status) || inPersonDone) return wrongStatus();
      await db.prepare("UPDATE approval_requests SET in_person_at = now(), in_person_by = ? WHERE id = ?").run(who, id);
      await addEvent(id, actor, "in_person_recorded", reason);
      inPersonDone = true;
      logged = { action: "approval.in_person", detail: `Recorded the in-person step (${req.inPerson}) for ${r.name}, ${activity}` };
      // The online part still to be reviewed: it waits for that.
      if (!onlineOk) return { ok: true };
    } else {
      // approve
      if (row.status !== "pending" && row.status !== "info_requested") return wrongStatus();
      await db.prepare("UPDATE approval_requests SET online_ok_at = now(), online_ok_by = ? WHERE id = ?").run(who, id);
      if (req.inPerson && !inPersonDone) {
        // An online declaration never stands in for an in-person step: the approval stays incomplete until staff record it.
        await db.prepare("UPDATE approval_requests SET status = 'in_person_due', expires_at = ? WHERE id = ?").run(later(req.pendingDays * DAY), id);
        await addEvent(id, actor, "online_accepted", reason);
        logged = { action: "approval.online_accepted", detail: `Accepted the online part of ${r.name}'s application for ${activity}; the in-person step is still to come` };
        const session = r.slot_status === "held" || r.slot_status === "lapsed" ? await bookSlot(id, true) : null;
        if (session?.booking) {
          booked = session.booking;
          await extendForSession(id, session.booking);
          logged.code = session.booking.code;
        }
        mail = { kind: "inPersonDue", extra: { step: req.inPerson, code: session?.booking?.code ?? null, slotTaken: session !== null && !session.booking } };
        return { ok: true };
      }
    }
    // Everything asked for is done: approved, and the sign-off the booking rules check is written.
    const user = (await db
      .prepare("SELECT u.name, u.email, u.phone FROM approval_requests r JOIN users u ON u.id = r.user_id WHERE r.id = ?")
      .get(id)) as { name: string; email: string; phone: string };
    const validUntil = validUntilFor(req, r.cert_expires_on);
    const signed = await addSignOff({
      venueId: req.venueId,
      sport: req.sport,
      phone: user.phone,
      name: user.name,
      email: user.email,
      kind: req.kind,
      reference: req.kind === "certification" ? r.cert_reference : null,
      note: `Approved online (application ${id}) by ${who}`,
      expiresOn: validUntil,
      adminId: reviewer.kind === "staff" ? reviewer.admin.id : null,
    });
    if (!signed.ok) throw new Error(`approval ${id}: ${signed.error}`);
    await db
      .prepare("UPDATE approval_requests SET status = 'approved', decided_at = now(), valid_until = ?, sign_off_id = ?, renew_notice_at = NULL WHERE id = ?")
      .run(validUntil, signed.signOff.id, id);
    await addEvent(id, actor, "approved", action === "approve" ? reason : null);
    const made = await bookSlot(id, false);
    booked = made.booking;
    const detail = `Approved ${r.name} for ${activity}${validUntil ? ` until ${validUntil}` : ""}${action === "in_person" ? " on recording the in-person step" : ""}`;
    logged = { action: "approval.approved", detail, code: made.booking?.code ?? null };
    mail = { kind: "approved", extra: { until: validUntil, code: made.booking?.code ?? null, slotTaken: made.why !== null } };
    return { ok: true };
  }).catch((err: unknown) => {
    if (err && typeof err === "object" && (err as Refused).ok === false) return err as Refused;
    throw err;
  });
  if (!outcome.ok) return outcome;
  const request = (await requestById(id))!;
  const l = logged as { action: string; detail: string; code?: string | null } | null;
  if (l) await logDecision(reviewer, request.venueId, l.action, l.detail, l.code);
  const m = mail as { kind: CustomerMail; extra: Parameters<typeof tellCustomer>[2] } | null;
  if (m) await tellCustomer(request, m.kind, m.extra);
  if (booked) await confirmBooking(booked as Booking, request.userId);
  return { ok: true, request, booking: booked };
}

// ------------------------------------------------------------ the clock

/**
 * Run from the scheduler each minute: holds whose time is up are let go;
 * applications nobody acted on in time lapse, and whatever they held with
 * them; customers hear, ahead of time, that an approval is about to run out.
 */
export async function expireApprovals(): Promise<{ holds: number; expired: number; reminded: number }> {
  const db = getDb();
  let holds = 0;
  const lapsing = (await db
    .prepare("SELECT id FROM approval_requests WHERE slot_status = 'held' AND hold_until <= now() ORDER BY id LIMIT 200")
    .all()) as { id: number }[];
  for (const { id } of lapsing) {
    const done = await withTransaction(async () => {
      if (!(await releaseHold(id, "lapsed"))) return false;
      await addEvent(id, { kind: "system", name: "MySenam" }, "hold_lapsed");
      return true;
    });
    if (!done) continue;
    holds++;
    const r = await requestById(id);
    if (r && LIVE_STATUSES.includes(r.status)) await tellCustomer(r, "holdLapsed", {}, `approval:${id}:holdLapsed:${r.slot?.date}:${r.slot?.start}`);
  }

  let expired = 0;
  const due = (await db
    .prepare("SELECT id FROM approval_requests WHERE status IN ('pending', 'info_requested', 'in_person_due') AND expires_at <= now() ORDER BY id LIMIT 200")
    .all()) as { id: number }[];
  for (const { id } of due) {
    const done = await withTransaction(async () => {
      const row = await lockRequest(id);
      if (!row || !LIVE_STATUSES.includes(row.status)) return false;
      await db.prepare("UPDATE approval_requests SET status = 'expired', decided_at = now() WHERE id = ? AND expires_at <= now()").run(id);
      await releaseHold(id, "released");
      await addEvent(id, { kind: "system", name: "MySenam" }, "expired");
      return true;
    });
    if (!done) continue;
    expired++;
    const r = (await requestById(id))!;
    await logDecision("system", r.venueId, "approval.expired", `${r.name}'s application for ${activityName(r.sport, "en")} lapsed: nobody acted on it in time`);
    await tellCustomer(r, "expired", {}, `approval:${id}:expired`);
  }

  let reminded = 0;
  const today = todayISO();
  const ending = (await db
    .prepare(
      `SELECT r.id FROM approval_requests r
        WHERE r.status = 'approved' AND r.renew_notice_at IS NULL AND r.valid_until IS NOT NULL AND r.valid_until >= ? AND r.valid_until <= ?
          AND NOT EXISTS (SELECT 1 FROM approval_requests n WHERE n.user_id = r.user_id AND n.venue_id = r.venue_id AND n.sport = r.sport AND n.id > r.id)
        ORDER BY r.id LIMIT 200`
    )
    .all(today, addDays(today, RENEW_NOTICE_DAYS))) as { id: number }[];
  for (const { id } of ending) {
    const claimed = await db.prepare("UPDATE approval_requests SET renew_notice_at = now() WHERE id = ? AND renew_notice_at IS NULL").run(id);
    if (claimed.changes === 0) continue;
    const r = (await requestById(id))!;
    if (r.revoked) continue;
    await tellCustomer(r, "renew", { until: r.validUntil }, `approval:${id}:renew`);
    reminded++;
  }
  return { holds, expired, reminded };
}

// ------------------------------------------------------------ personal data

/** Everything held about a customer's applications, documents included, for their data export (lib/privacy.ts). */
export async function approvalsExport(userId: number): Promise<unknown[]> {
  const list = await customerApprovals(userId);
  const out: unknown[] = [];
  for (const r of list) {
    const docs = (await getDb().prepare("SELECT id, content_type, content, created_at FROM approval_documents WHERE request_id = ? ORDER BY id").all(r.id)) as {
      id: number;
      content_type: string;
      content: Uint8Array;
      created_at: unknown;
    }[];
    out.push({
      venue: r.venueName,
      activity: r.sport,
      status: r.status,
      appliedAt: r.createdAt,
      answers: r.questions.map((q) => ({ question: q.text, answer: r.answers[q.id] ?? null })),
      declaredAt: r.declaredAt,
      videoWatchedAt: r.videoWatchedAt,
      waiverSignedAt: r.waiverSignedAt,
      declaredAdult: r.declaredAdult,
      guardianName: r.guardianName,
      guardianDeclaredAt: r.guardianDeclaredAt,
      certification: r.certReference ? { reference: r.certReference, expiresOn: r.certExpiresOn } : null,
      onlinePartAcceptedAt: r.onlineOkAt,
      inPersonStepAt: r.inPersonAt,
      decidedAt: r.decidedAt,
      validUntil: r.validUntil,
      slot: r.slot ? { court: r.slot.courtName, date: r.slot.date, start: r.slot.start, end: r.slot.end, status: r.slot.status } : null,
      bookingCode: r.bookingCode,
      history: r.events,
      documents: docs.map((d) => ({ uploadedAt: iso(d.created_at), contentType: d.content_type, base64: Buffer.from(d.content).toString("base64") })),
    });
  }
  return out;
}

/** Applications at these venues from this number, for a venue's own answer to somebody asking in person (no document contents). */
export async function approvalsForPhone(venueIds: number[], phone: string): Promise<unknown[]> {
  if (venueIds.length === 0) return [];
  const rows = (await getDb()
    .prepare(
      `${REQUEST_SELECT} WHERE r.venue_id IN (${venueIds.map(() => "?").join(",")}) AND phone_key(r.phone) = phone_key(?) ORDER BY r.id DESC LIMIT 100`
    )
    .all(...venueIds, phone)) as RequestRow[];
  return (await toRequests(rows)).map((r) => ({
    venue: r.venueName,
    activity: r.sport,
    name: r.name,
    status: r.status,
    appliedAt: r.createdAt,
    answers: r.questions.map((q) => ({ question: q.text, answer: r.answers[q.id] ?? null })),
    declaredAdult: r.declaredAdult,
    guardianName: r.guardianName,
    decidedAt: r.decidedAt,
    validUntil: r.validUntil,
    documents: r.documents.length,
    history: r.events,
  }));
}

/** On erasure: the customer's applications, answers, documents and holds go with the account. */
export async function eraseApprovals(userId: number): Promise<void> {
  const db = getDb();
  await db.prepare("UPDATE claims SET active = false WHERE approval_id IN (SELECT id FROM approval_requests WHERE user_id = ?) AND active").run(userId);
  await db.prepare("DELETE FROM approval_requests WHERE user_id = ?").run(userId);
}

// ------------------------------------------------------------ reading a request's body

/**
 * An application or answer as sent: a form upload (`data`, JSON, and
 * `document` files) or plain JSON. Sizes are checked before anything is read
 * whole where the size is declared.
 */
export async function readSubmission(req: Request): Promise<{ ok: true; body: Record<string, unknown>; files: Buffer[] } | { ok: false; error: string; status: number }> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.startsWith("multipart/form-data")) {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    return body && typeof body === "object" ? { ok: true, body, files: [] } : { ok: false, error: "Invalid JSON body.", status: 400 };
  }
  if (Number(req.headers.get("content-length") ?? 0) > MAX_DOCUMENTS * MAX_DOCUMENT_BYTES + 256 * 1024)
    return { ok: false, error: "Send the document as a photo or scan: JPEG, PNG or WebP, up to 10 MB.", status: 413 };
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return { ok: false, error: "Send the application as a form upload.", status: 400 };
  }
  let body: Record<string, unknown> = {};
  const data = form.get("data");
  if (typeof data === "string") {
    try {
      body = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return { ok: false, error: "Invalid JSON body.", status: 400 };
    }
  }
  const files: Buffer[] = [];
  for (const f of form.getAll("document")) {
    if (!(f instanceof Blob)) continue;
    if (f.size > MAX_DOCUMENT_BYTES) return { ok: false, error: "Send the document as a photo or scan: JPEG, PNG or WebP, up to 10 MB.", status: 413 };
    files.push(Buffer.from(await f.arrayBuffer()));
  }
  if (files.length > MAX_DOCUMENTS) return { ok: false, error: `Up to ${MAX_DOCUMENTS} documents.`, status: 400 };
  return { ok: true, body: body && typeof body === "object" ? body : {}, files };
}

/** A refusal as a route answers it. */
export function refusalBody(r: Refused): { error: string; code: string; vars?: Record<string, string | number> } {
  return { error: r.error, code: r.code, ...(r.vars ? { vars: r.vars } : {}) };
}
