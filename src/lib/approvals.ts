import { logAction } from "./activity";
import { activityName } from "./activity-registry";
import { MAX_DOCUMENT_BYTES, prepareDocument, uploaded, type DocumentDownload, type UploadedFile } from "./approval-documents";
import { initialScanStatus, RELEASED, scanDocuments, type ScanStatus } from "./document-scanning";
import { retentionPolicy, type RetentionPolicy } from "./retention-policy";
import { forgetApplicant, removedApplications } from "./approval-retention";
import { venueMayOffer } from "./activities";
import type { Admin } from "./admin-auth";
import { claimBuffers, policyBreaches } from "./booking-policy";
import { claim, isConflict, release, releaseBooking } from "./claims";
import { courtFor, courtOffers } from "./court-activities";
import { getDb, withTransaction } from "./db";
import { holdNewBookings, holdPolicy } from "./holds";
import { venueAheadDays } from "./house-rules";
import { instantOf } from "./interval";
import { customerMayBook } from "./limits";
import { accountLocale, emailPlain, emailPlayer } from "./outbox";
import { phoneRefusal } from "./phone-check";
import { addSignOff, revokeSignOff, signOffHolds, type SignOffKind } from "./sign-offs";
import { courtDay, createBookingSeries, getBookingById, getCourt, offerSlotPlace, settleCancelled, spanFor } from "./store";
import { venueBaseUrl } from "./storefront";
import { addDays, isBookableDate, isValidDateString, todayISO } from "./time";
import { GUARDIAN_AGE } from "./tournaments";
import type { Phrase } from "./i18n";
import type { Booking, Sport } from "./types";
import { currentWaiver, signWaiver, waiverSigned, waiverSignedFor } from "./waivers";
import { managedPerson, type Relationship } from "./managed-people";
import { CUSTOMER_TAKES_PART, PARTICIPANT_TAKES_PART } from "./participants";
import { venueZoneOf } from "./zones";

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
 * another time. Nothing is charged while an application waits.
 *
 * Approval establishes eligibility, never payment (ADR 0020). Where the
 * venue asks payment online to hold a booking, the booking made on approval
 * is held by the ordinary booking hold (lib/holds.ts) for the activity's
 * payment hours, confirmed when paid and let go when not; the approval
 * stands either way. A payment that lands after the hold was let go becomes
 * the booking again if the slot is still free, or stays owed back.
 *
 * Who may grant an approval is the venue's to say per activity: a safety
 * assessment only a manager, a coach it names (signed in to their own
 * account) or front-desk staff it delegates; an administrative check any of
 * its staff. Revoking takes the sign-off back, lets go of a booking still
 * waiting for its payment, and flags the person's confirmed bookings for
 * staff rather than cancelling them.
 */

export type ApprovalStatus = "pending" | "info_requested" | "in_person_due" | "approved" | "rejected" | "withdrawn" | "expired";
/** Statuses an application is still open in. */
export const LIVE_STATUSES: ApprovalStatus[] = ["pending", "info_requested", "in_person_due"];
/**
 * A slot asked for: held while the application waits; then booked,
 * `awaiting_payment` (booked and held by the ordinary booking hold until paid,
 * where the venue asks payment to hold), `payment_lapsed` (not paid in time,
 * let go), or gone (`lapsed`, `released`, `taken`).
 */
export type SlotStatus = "held" | "lapsed" | "released" | "booked" | "taken" | "awaiting_payment" | "payment_lapsed";
/** Whose decision an approval is: a safety assessment, or an administrative check (ADR 0020). */
export type ReviewLevel = "administrative" | "safety";

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
  /** Coaches the venue lists who may review these applications, signed in to their own account. */
  coachIds: number[];
  /** A safety assessment (the default) or an administrative check. */
  reviewLevel: ReviewLevel;
  /** Front-desk staff delegated by name to make this activity's safety decisions. */
  delegateIds: number[];
  /** Hours an approved customer has to pay for the slot booked, where the venue asks payment to hold. */
  payHours: number;
  /** Why the venue needs the document it asks for, shown to applicants (lib/approval-documents.ts). */
  documentPurpose: string | null;
  /** The activity's own, shorter retention periods in days; null: the install's (lib/approval-retention.ts). */
  reviewDays: number | null;
  documentDays: number | null;
  recordDays: number | null;
  /**
   * An adult applying for somebody they manage needs staff to record that
   * they reviewed the adult's authority before approval (ADR 0022). Off
   * unless the venue sets it; never automatic.
   */
  guardianCheck: boolean;
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
  /** As uploaded, made safe; for a redrawn image, ending .webp. */
  fileName: string;
  /** A PDF's page count; null for an image. */
  pages: number | null;
  createdAt: string;
  /**
   * Where its malware scan stands (lib/document-scanning.ts): only `clean`,
   * or `not_scanned` where the operator turned scanning off, can be opened.
   */
  scan: ScanStatus;
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
  /** The administrative check (complete; a membership held), by whom: apart from the safety decision. */
  adminCheckedAt: string | null;
  adminCheckedBy: string | null;
  inPersonAt: string | null;
  inPersonBy: string | null;
  expiresAt: string;
  decidedAt: string | null;
  validUntil: string | null;
  /** Approved, and past the last day it held: to renew. */
  lapsed: boolean;
  /** Approved, then taken back by the venue (the sign-off it wrote was withdrawn). */
  revoked: boolean;
  /** Why it was taken back, where the venue said. */
  revokeReason: string | null;
  slot: {
    courtId: number;
    courtName: string;
    date: string;
    start: number;
    end: number;
    holdUntil: string | null;
    status: SlotStatus;
    /** Booked and waiting for payment: pay by then (UTC, `YYYY-MM-DD HH:MM:SS`), or it is let go. */
    payBy: string | null;
    /** What is left to pay on the booking. */
    due: number | null;
  } | null;
  bookingCode: string | null;
  documents: ApprovalDocumentInfo[];
  events: ApprovalEvent[];
  createdAt: string;
  /**
   * Made by the account's adult for somebody they manage (ADR 0022): who it
   * is for, the relationship the adult declared, and when they declared
   * their authority for it. Declared, never verified. Null: the adult's own.
   */
  forPerson: { id: number | null; name: string; relationship: Relationship | null; birthYear: number | null } | null;
  /** The account that applied: the adult, for somebody they manage. */
  appliedBy: string | null;
  authorityDeclaredAt: string | null;
  /** Where the activity asks for it, the staff review of the adult's authority. */
  guardianCheck: boolean;
  authorityReviewedAt: string | null;
  authorityReviewedBy: string | null;
}

/**
 * Who decides: the venue's staff, or a coach it authorised, signed in to the
 * account the venue linked to the coach record (`userId`). What each may do
 * is read from the database, never from this object.
 */
export type Reviewer =
  | { kind: "staff"; admin: Pick<Admin, "id" | "name"> }
  | { kind: "coach"; coach: { id: number; name: string; venueId: number; active: boolean }; userId: number };

export type Refused = { ok: false; error: string; code: string; status: number; vars?: Record<string, string | number> };
const refused = (code: string, error: string, status = 400): Refused => ({ ok: false, error, code, status });
const isRefused = (x: unknown): x is Refused => typeof x === "object" && x !== null && (x as Refused).ok === false;

/** At most this many documents on one application, each at most this big as uploaded. */
export const MAX_DOCUMENTS = 3;
export { MAX_DOCUMENT_BYTES };
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
  review_level: ReviewLevel;
  pay_hours: number;
  document_purpose: string | null;
  review_days: number | null;
  document_days: number | null;
  record_days: number | null;
  guardian_check?: number | null;
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
  const delegates = (await getDb()
    .prepare(`SELECT requirement_id, admin_id FROM approval_delegates WHERE requirement_id IN (${rows.map(() => "?").join(",")}) ORDER BY admin_id`)
    .all(...rows.map((r) => r.id))) as { requirement_id: number; admin_id: number }[];
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
    reviewLevel: r.review_level === "administrative" ? "administrative" : "safety",
    delegateIds: delegates.filter((x) => x.requirement_id === r.id).map((x) => x.admin_id),
    payHours: r.pay_hours ?? 24,
    documentPurpose: r.document_purpose,
    reviewDays: r.review_days,
    documentDays: r.document_days,
    recordDays: r.record_days,
    guardianCheck: r.guardian_check === 1,
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
  const documentRules = readDocumentRules(input, documentLabel, await retentionPolicy());
  if (!documentRules.ok) return documentRules;
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
  const payHours = num(input.payHours, 24, 1, 168);
  if (payHours === "bad" || payHours === null) return { ok: false, error: "An approved customer has 1 to 168 hours to pay for the slot booked." };
  const reviewLevel = input.reviewLevel ?? "safety";
  if (reviewLevel !== "safety" && reviewLevel !== "administrative") return { ok: false, error: "A safety assessment or an administrative check." };
  const coachIds = Array.isArray(input.coachIds) ? [...new Set(input.coachIds.map(Number))] : [];
  const delegateIds = Array.isArray(input.delegateIds) ? [...new Set(input.delegateIds.map(Number))] : [];
  const db = getDb();
  if (coachIds.length > 0) {
    const ours = (await db
      .prepare(`SELECT id FROM coaches WHERE venue_id = ? AND id IN (${coachIds.map(() => "?").join(",")})`)
      .all(venueId, ...coachIds)) as { id: number }[];
    if (ours.length !== coachIds.length) return { ok: false, error: "Coach not found." };
  }
  // Delegated by name: the venue's own front desk (a manager decides already).
  if (delegateIds.length > 0) {
    const desk = (await db
      .prepare(`SELECT id FROM admins WHERE venue_id = ? AND role = 'desk' AND id IN (${delegateIds.map(() => "?").join(",")})`)
      .all(venueId, ...delegateIds)) as { id: number }[];
    if (desk.length !== delegateIds.length) return { ok: false, error: "Only this venue's front-desk staff can be delegated." };
  }
  const id = await withTransaction(async () => {
    const row = (await db
      .prepare(
        `INSERT INTO approval_requirements (venue_id, sport, kind, intro, declaration, document_label, video_url, in_person, questions, waiver, valid_days, pending_days, hold_hours, open, review_level, pay_hours)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (venue_id, sport) DO UPDATE SET kind = excluded.kind, intro = excluded.intro, declaration = excluded.declaration,
           document_label = excluded.document_label, video_url = excluded.video_url, in_person = excluded.in_person, questions = excluded.questions,
           waiver = excluded.waiver, valid_days = excluded.valid_days, pending_days = excluded.pending_days, hold_hours = excluded.hold_hours,
           open = excluded.open, review_level = excluded.review_level, pay_hours = excluded.pay_hours, updated_at = now()
         RETURNING id`
      )
      .get(
        venueId, sport, kind, intro, declaration, documentLabel, videoUrl, inPerson, JSON.stringify(questions),
        input.waiver === true ? 1 : 0, validDays, pendingDays, holdHours, input.open === false ? 0 : 1, reviewLevel, payHours
      )) as { id: number };
    await db.prepare("DELETE FROM approval_reviewers WHERE requirement_id = ?").run(row.id);
    for (const coach of coachIds) await db.prepare("INSERT INTO approval_reviewers (requirement_id, coach_id) VALUES (?, ?)").run(row.id, coach);
    await db.prepare("DELETE FROM approval_delegates WHERE requirement_id = ?").run(row.id);
    for (const admin of delegateIds) await db.prepare("INSERT INTO approval_delegates (requirement_id, admin_id) VALUES (?, ?)").run(row.id, admin);
    await writeDocumentRules(row.id, documentRules);
    // An adult applying for somebody they manage: staff review their authority first, where the venue asks.
    await db.prepare("UPDATE approval_requirements SET guardian_check = ? WHERE id = ?").run(input.guardianCheck === true ? 1 : 0, row.id);
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
  admin_checked_at: unknown;
  admin_checked_by: string | null;
  booking_hold_until: string | null;
  booking_due: number | string | null;
  managed_person_id: number | null;
  relationship: Relationship | null;
  authority_declared_at: unknown;
  authority_reviewed_at: unknown;
  authority_reviewed_by: string | null;
  applied_by: string | null;
  guardian_check: number | null;
  person_birth_year: number | null;
}

const REQUEST_SELECT = `
  SELECT r.*, v.name AS venue_name, c.name AS court_name, b.code AS booking_code,
         au.name AS applied_by, q.guardian_check, mp.birth_year AS person_birth_year,
         b.hold_until AS booking_hold_until,
         CASE WHEN b.status = 'confirmed' AND b.payment_status = 'unpaid' THEN b.total_price - b.shares_paid END AS booking_due,
         q.questions, q.kind, q.in_person,
         -- Taken back by the venue; not merely replaced by a renewal.
         CASE WHEN s.revoked_at IS NOT NULL AND s.revoke_reason IS DISTINCT FROM 'Replaced' THEN s.revoked_at END AS sign_off_revoked,
         s.revoke_reason AS sign_off_reason
    FROM approval_requests r
    JOIN venues v ON v.id = r.venue_id
    JOIN approval_requirements q ON q.id = r.requirement_id
    LEFT JOIN courts c ON c.id = r.court_id
    LEFT JOIN bookings b ON b.id = r.booking_id
    LEFT JOIN sign_offs s ON s.id = r.sign_off_id
    LEFT JOIN users au ON au.id = r.user_id
    LEFT JOIN participants mp ON mp.id = r.managed_person_id`;

async function toRequests(rows: RequestRow[]): Promise<ApprovalRequest[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const db = getDb();
  const events = (await db
    .prepare(`SELECT request_id, at, actor, actor_name, action, reason FROM approval_events WHERE request_id IN (${marks}) ORDER BY id`)
    .all(...ids)) as { request_id: number; at: unknown; actor: ApprovalEvent["actor"]; actor_name: string; action: string; reason: string | null }[];
  const docs = (await db
    .prepare(`SELECT id, request_id, content_type, size, file_name, pages, created_at, scan_status FROM approval_documents WHERE request_id IN (${marks}) ORDER BY id`)
    .all(...ids)) as {
    id: number;
    request_id: number;
    content_type: string;
    size: number;
    file_name: string | null;
    pages: number | null;
    created_at: unknown;
    scan_status: ScanStatus;
  }[];
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
      adminCheckedAt: iso(r.admin_checked_at),
      adminCheckedBy: r.admin_checked_by,
      inPersonAt: iso(r.in_person_at),
      inPersonBy: r.in_person_by,
      expiresAt: isoOf(r.expires_at),
      decidedAt: iso(r.decided_at),
      validUntil: r.valid_until,
      lapsed: r.status === "approved" && r.valid_until !== null && r.valid_until < today,
      revoked: r.status === "approved" && (r.sign_off_revoked !== null || (r.sign_off_id === null && r.sign_off_reason === null)),
      revokeReason: r.status === "approved" && r.sign_off_revoked !== null ? r.sign_off_reason : null,
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
              payBy: r.slot_status === "awaiting_payment" ? r.booking_hold_until : null,
              due: r.slot_status === "awaiting_payment" && r.booking_due !== null ? Math.round(Number(r.booking_due) * 100) / 100 : null,
            }
          : null,
      bookingCode: r.booking_code,
      documents: docs
        .filter((d) => d.request_id === r.id)
        .map((d) => ({
          id: d.id,
          contentType: d.content_type,
          size: d.size,
          fileName: documentName(d),
          pages: d.pages,
          createdAt: isoOf(d.created_at),
          scan: d.scan_status,
        })),
      events: events
        .filter((e) => e.request_id === r.id)
        .map((e) => ({ at: isoOf(e.at), actor: e.actor, actorName: e.actor_name, action: e.action, reason: e.reason })),
      createdAt: isoOf(r.created_at),
      forPerson:
        r.managed_person_id !== null || r.relationship !== null
          ? { id: r.managed_person_id, name: r.name, relationship: r.relationship, birthYear: r.person_birth_year ?? null }
          : null,
      appliedBy: r.applied_by ?? null,
      authorityDeclaredAt: iso(r.authority_declared_at),
      guardianCheck: r.guardian_check === 1,
      authorityReviewedAt: iso(r.authority_reviewed_at),
      authorityReviewedBy: r.authority_reviewed_by ?? null,
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

/**
 * The applications a coach is authorised to review: for the activities the
 * venue named them for, at that venue, while the coach is active. A child
 * appears to a coach only here, as an applicant they are named reviewer for,
 * and in their own lessons (lib/coach-schedule.ts): never every child at the
 * venue, another venue's, or a guardian's other records.
 */
export async function coachApprovals(coachId: number): Promise<ApprovalRequest[]> {
  const rows = (await getDb()
    .prepare(
      `${REQUEST_SELECT}
        JOIN approval_reviewers ar ON ar.requirement_id = r.requirement_id AND ar.coach_id = ?
        JOIN coaches k ON k.id = ar.coach_id AND k.venue_id = r.venue_id AND k.active = 1
       ORDER BY (r.status IN ('pending', 'info_requested', 'in_person_due')) DESC, r.id DESC LIMIT 100`
    )
    .all(coachId)) as RequestRow[];
  return toRequests(rows);
}

// ------------------------------------------------------------ coaches, signed in to their own account

export interface ReviewerCoach {
  id: number;
  name: string;
  venueId: number;
  venueName: string;
  active: boolean;
}

/** The coach records, at any venue, a manager linked to this account: active ones only. */
export async function reviewerCoaches(userId: number): Promise<ReviewerCoach[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT k.id, k.name, k.venue_id, v.name AS venue_name FROM coaches k JOIN venues v ON v.id = k.venue_id
        WHERE k.user_id = ? AND k.active = 1 ORDER BY k.id`
    )
    .all(userId)) as { id: number; name: string; venue_id: number; venue_name: string }[];
  return rows.map((r) => ({ id: r.id, name: r.name, venueId: r.venue_id, venueName: r.venue_name, active: true }));
}

/** Applications a signed-in coach may review: for the activities each venue that linked them named them for. */
export async function accountReviews(userId: number): Promise<ApprovalRequest[]> {
  const out: ApprovalRequest[] = [];
  for (const coach of await reviewerCoaches(userId)) out.push(...(await coachApprovals(coach.id)));
  return out;
}

/** The coach record (linked to this account) that may review this application, if any. */
export async function coachReviewerFor(userId: number, requestId: number): Promise<Reviewer | null> {
  const row = (await getDb()
    .prepare(
      `SELECT k.id, k.name, k.venue_id FROM approval_requests r
         JOIN approval_reviewers ar ON ar.requirement_id = r.requirement_id
         JOIN coaches k ON k.id = ar.coach_id AND k.venue_id = r.venue_id
        WHERE r.id = ? AND k.user_id = ? AND k.active = 1 LIMIT 1`
    )
    .get(requestId, userId)) as { id: number; name: string; venue_id: number } | undefined;
  return row ? { kind: "coach", coach: { id: row.id, name: row.name, venueId: row.venue_id, active: true }, userId } : null;
}

/** The coach records linked to this account that may see this document's application. */
export async function coachIdsFor(userId: number): Promise<number[]> {
  return (await reviewerCoaches(userId)).map((c) => c.id);
}

/**
 * Link a coach record to the coach's own MySenam account (named by its
 * email), or unlink it (`email` null): from then on that account, signed
 * in, reviews what the venue names the coach for. Managers only.
 */
export async function linkCoachAccount(
  venueId: number,
  coachId: number,
  email: unknown
): Promise<{ ok: true; coachName: string; email: string | null } | { ok: false; error: string; status: number }> {
  const db = getDb();
  const coach = (await db.prepare("SELECT name FROM coaches WHERE id = ? AND venue_id = ?").get(coachId, venueId)) as { name: string } | undefined;
  if (!coach) return { ok: false, error: "Coach not found.", status: 404 };
  if (email === null || email === "") {
    await db.prepare("UPDATE coaches SET user_id = NULL WHERE id = ?").run(coachId);
    return { ok: true, coachName: coach.name, email: null };
  }
  if (typeof email !== "string") return { ok: false, error: "No account has that email.", status: 400 };
  const user = (await db.prepare("SELECT id, email FROM users WHERE lower(email) = lower(?)").get(email.trim())) as { id: number; email: string } | undefined;
  if (!user) return { ok: false, error: "No account has that email.", status: 400 };
  const taken = await db.prepare("SELECT 1 FROM coaches WHERE venue_id = ? AND user_id = ? AND id <> ?").get(venueId, user.id, coachId);
  if (taken) return { ok: false, error: "That account is already linked to another coach here.", status: 409 };
  await db.prepare("UPDATE coaches SET user_id = ? WHERE id = ?").run(user.id, coachId);
  return { ok: true, coachName: coach.name, email: user.email };
}

/** The account email each of a venue's coaches is linked to, for the settings screen. */
export async function coachAccounts(venueId: number): Promise<Record<number, string | null>> {
  const rows = (await getDb()
    .prepare("SELECT k.id, u.email FROM coaches k LEFT JOIN users u ON u.id = k.user_id WHERE k.venue_id = ?")
    .all(venueId)) as { id: number; email: string | null }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.email]));
}

// ------------------------------------------------------------ who may grant

/**
 * May this member of staff grant (approve, or record the in-person
 * assessment of) an approval for this activity here? A manager (or whoever
 * runs the business or the platform) may; front desk only where the activity
 * is an administrative check, or where a manager delegated them by name.
 * Read from the database, never from the session object alone.
 */
async function staffGrants(adminId: number, req: Pick<ApprovalRequirement, "reviewLevel" | "delegateIds">): Promise<boolean> {
  const row = (await getDb().prepare("SELECT role, venue_id FROM admins WHERE id = ?").get(adminId)) as { role: string | null; venue_id: number | null } | undefined;
  if (!row) return false;
  if (row.venue_id === null || row.role !== "desk") return true;
  return req.reviewLevel === "administrative" || req.delegateIds.includes(adminId);
}

/**
 * May this member of staff record a sign-off directly (the Sign-offs tab)
 * for this activity (null: anything here)? Not past what the venue's
 * approval settings say: front desk records one for a safety-assessed
 * activity only where delegated for it.
 */
export async function staffMayGrant(adminId: number, venueId: number, sport: string | null): Promise<boolean> {
  const reqs = (await requirementsAt(venueId)).filter((r) => sport === null || r.sport === sport);
  for (const r of reqs) if (!(await staffGrants(adminId, r))) return false;
  return true;
}

/** How many applications wait on the venue (to review, or an in-person step to record). */
export async function waitingCount(venueId: number): Promise<number> {
  const row = (await getDb()
    .prepare("SELECT COUNT(*)::int AS n FROM approval_requests WHERE venue_id = ? AND status IN ('pending', 'in_person_due')")
    .get(venueId)) as { n: number };
  return row.n;
}

// ------------------------------------------------------------ documents

/**
 * What a venue that asks for a document must also say, and how long its
 * applications are kept if shorter than the install's periods
 * (lib/approval-retention.ts): read with the rest of saveRequirement.
 */
type DocumentRules = { ok: true; purpose: string | null; reviewDays: number | null; documentDays: number | null; recordDays: number | null };

function readDocumentRules(input: Record<string, unknown>, documentLabel: string | null, install: RetentionPolicy): DocumentRules | { ok: false; error: string } {
  const purpose = documentLabel ? text(input.documentPurpose, 300) : null;
  // Nothing is collected merely because an upload exists: what is asked for, and why.
  if (documentLabel && (!purpose || purpose.length < 10)) return { ok: false, error: "Say why you need the document, in a sentence applicants will read." };
  if (purpose && IDENTITY_DOCUMENT.test(purpose))
    return { ok: false, error: "Ask only for a document the activity needs, such as a certificate: never an identity document." };
  const days = (v: unknown, min: number, max: number): number | null | "bad" => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : "bad";
  };
  // Up to the install's own periods (lib/retention-policy.ts): an activity keeps less, never more.
  const reviewDays = days(input.reviewDays, 1, install.documentDays);
  if (reviewDays === "bad") return { ok: false, error: `Documents of a refused, withdrawn or lapsed application are kept 1 to ${install.documentDays} days.` };
  const documentDays = days(input.documentDays, 1, install.documentDays);
  if (documentDays === "bad") return { ok: false, error: `Documents are kept 1 to ${install.documentDays} days after the decision.` };
  const recordDays = days(input.recordDays, Math.min(30, install.recordDays), install.recordDays);
  if (recordDays === "bad") return { ok: false, error: `A closed application is kept 30 to ${install.recordDays} days.` };
  return { ok: true, purpose, reviewDays, documentDays, recordDays };
}

async function writeDocumentRules(requirementId: number, rules: DocumentRules): Promise<void> {
  await getDb()
    .prepare("UPDATE approval_requirements SET document_purpose = ?, review_days = ?, document_days = ?, record_days = ? WHERE id = ?")
    .run(rules.purpose, rules.reviewDays, rules.documentDays, rules.recordDays, requirementId);
}

/** A stored document's name, or one made up for those stored before names were kept. */
function documentName(d: { id: number; file_name: string | null; content_type: string }): string {
  return d.file_name ?? `document-${d.id}.${d.content_type === "application/pdf" ? "pdf" : "webp"}`;
}

/** Documents cannot be taken without a malware scanner, unless the operator turned scanning off on purpose (ADR 0024). */
export const SCAN_UNAVAILABLE =
  "Documents cannot be taken just now: they could not be checked for malware. Try again later, or ask the venue.";

/**
 * Check uploads and store them with an application (lib/approval-documents.ts):
 * images redrawn, PDFs checked and kept as sent, only where the venue has
 * said what it needs and why. Stored in quarantine (`pending`) for the
 * malware scan (lib/document-scanning.ts), which runs once the transaction
 * has committed; returns their ids for it. Refused, never stored unscanned,
 * when there is no scanner and scanning was not turned off on purpose.
 */
async function storeDocuments(requestId: number, files: Buffer[]): Promise<Refused | number[]> {
  if (files.length === 0) return [];
  const scan = initialScanStatus();
  if (!scan) return refused("SCAN_UNAVAILABLE", SCAN_UNAVAILABLE, 503);
  const db = getDb();
  const asked = (await db
    .prepare("SELECT q.document_label, q.document_purpose FROM approval_requests r JOIN approval_requirements q ON q.id = r.requirement_id WHERE r.id = ?")
    .get(requestId)) as { document_label: string | null; document_purpose: string | null } | undefined;
  if (!asked?.document_label) return refused("APR_NO_DOCUMENTS", "This venue asks for no documents for this activity.");
  if (!asked.document_purpose)
    return refused("APRDOC_NO_PURPOSE", "The venue has not said why it needs this document, so it cannot take one yet. Ask the venue.", 409);
  const prepared = [];
  for (const f of files) {
    const p = await prepareDocument(f as UploadedFile);
    if (!p.ok) return refused(p.code, p.error, p.code === "APRDOC_TOO_BIG" ? 413 : 400);
    prepared.push(p.document);
  }
  const held = ((await db.prepare("SELECT COUNT(*)::int AS n FROM approval_documents WHERE request_id = ?").get(requestId)) as { n: number }).n;
  if (held + prepared.length > MAX_DOCUMENTS) return refused("APR_TOO_MANY_DOCUMENTS", `Up to ${MAX_DOCUMENTS} documents.`);
  const ids: number[] = [];
  for (const d of prepared) {
    const row = (await db
      .prepare(
        `INSERT INTO approval_documents (request_id, content_type, size, content, file_name, pages, sha256, scan_status, scanned_at, scan_next_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${scan === "pending" ? "NULL, now()" : "now(), NULL"}) RETURNING id`
      )
      .get(requestId, d.contentType, d.content.length, d.content, d.fileName, d.pages, d.sha256, scan)) as { id: number };
    ids.push(row.id);
  }
  return ids;
}

const isRefusal = (v: Refused | number[]): v is Refused => !Array.isArray(v);

/**
 * A document, for whoever may see it: the customer it belongs to, the venue's
 * staff, or a coach authorised for that activity there.
 */
export async function documentFor(
  documentId: number,
  who: { userId: number } | { venueId: number } | { coachId: number }
): Promise<{ contentType: string; content: Buffer; scan: ScanStatus } | null> {
  const row = (await getDb()
    .prepare(
      `SELECT d.content_type, d.scan_status, r.user_id, r.venue_id, r.requirement_id FROM approval_documents d
         JOIN approval_requests r ON r.id = d.request_id WHERE d.id = ?`
    )
    .get(documentId)) as { content_type: string; scan_status: ScanStatus; user_id: number; venue_id: number; requirement_id: number } | undefined;
  if (!row) return null;
  if ("userId" in who && row.user_id !== who.userId) return null;
  if ("venueId" in who && row.venue_id !== who.venueId) return null;
  if ("coachId" in who && !(await coachMayReview(who.coachId, row.requirement_id, row.venue_id))) return null;
  // Not released (still in quarantine, refused or unscannable): not handed to anybody, its bytes not even read.
  if (!RELEASED.includes(row.scan_status)) return { contentType: row.content_type, content: Buffer.alloc(0), scan: row.scan_status };
  const content = (await getDb().prepare("SELECT content FROM approval_documents WHERE id = ?").get(documentId)) as { content: Uint8Array };
  return { contentType: row.content_type, content: Buffer.from(content.content), scan: row.scan_status };
}

/** Who is opening a document, as the record of accesses names them. */
export type DocumentViewer =
  | { kind: "customer"; userId: number; name: string }
  | { kind: "staff"; adminId: number; name: string; venueId: number }
  | { kind: "coach"; coachId: number; name: string };

/** Why an entitled viewer cannot open a document (yet): where its malware scan stands. */
export const NOT_RELEASED = "This document has not passed its malware scan, so it cannot be opened.";

/**
 * A document handed to somebody entitled to it (documentFor decides who is),
 * with its name, and the access recorded: who, which document, when. Served
 * by the routes with lib/approval-documents.ts downloadHeaders. Null for
 * somebody not entitled, as for a document that does not exist; for somebody
 * entitled, a document not released by its malware scan is withheld, and
 * the routes say so.
 */
export async function openDocument(documentId: number, viewer: DocumentViewer): Promise<DocumentDownload | { withheld: ScanStatus } | null> {
  const who = viewer.kind === "customer" ? { userId: viewer.userId } : viewer.kind === "staff" ? { venueId: viewer.venueId } : { coachId: viewer.coachId };
  const doc = await documentFor(documentId, who);
  if (!doc) return null;
  if (!RELEASED.includes(doc.scan)) return { withheld: doc.scan };
  const db = getDb();
  const meta = (await db
    .prepare("SELECT d.id, d.file_name, d.content_type, d.request_id, r.venue_id FROM approval_documents d JOIN approval_requests r ON r.id = d.request_id WHERE d.id = ?")
    .get(documentId)) as { id: number; file_name: string | null; content_type: string; request_id: number; venue_id: number };
  await db
    .prepare("INSERT INTO approval_document_access (document_id, request_id, venue_id, viewer, user_id, admin_id, coach_id, viewer_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      documentId,
      meta.request_id,
      meta.venue_id,
      viewer.kind,
      viewer.kind === "customer" ? viewer.userId : null,
      viewer.kind === "staff" ? viewer.adminId : null,
      viewer.kind === "coach" ? viewer.coachId : null,
      viewer.name.slice(0, 200)
    );
  return { contentType: doc.contentType, content: doc.content, fileName: documentName(meta) };
}

/** Who opened an application's documents, and when (for the customer's export). */
async function documentAccesses(requestId: number): Promise<{ at: string | null; viewer: string; name: string }[]> {
  const rows = (await getDb()
    .prepare("SELECT at, viewer, viewer_name FROM approval_document_access WHERE request_id = ? ORDER BY id")
    .all(requestId)) as { at: unknown; viewer: string; viewer_name: string }[];
  return rows.map((a) => ({ at: iso(a.at), viewer: a.viewer, name: a.viewer_name }));
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
  actor: { kind: ApprovalEvent["actor"]; name: string; adminId?: number | null; coachId?: number | null; userId?: number | null },
  action: string,
  reason?: string | null
): Promise<void> {
  await getDb()
    .prepare("INSERT INTO approval_events (request_id, actor, admin_id, coach_id, user_id, actor_name, action, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(requestId, actor.kind, actor.adminId ?? null, actor.coachId ?? null, actor.userId ?? null, actor.name, action, reason?.slice(0, 1000) ?? null);
}

const reviewerActor = (r: Reviewer) =>
  r.kind === "staff"
    ? { kind: "staff" as const, name: r.admin.name, adminId: r.admin.id }
    : { kind: "coach" as const, name: r.coach.name, coachId: r.coach.id, userId: r.userId };
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
      .run(by === "system" ? "Automatic" : `${by.coach.name} (coach, own account)`, venueId, bookingCode ?? null, action, detail.slice(0, 500));
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
  | "renew"
  | "revoked"
  | "paymentLapsed"
  | "latePaymentBooked"
  | "latePaymentRefund";

/** A booking hold's end (UTC, as lib/holds.ts writes it) as the venue's local date and time. */
async function venueTime(venueId: number, utc: string): Promise<string> {
  const row = (await getDb().prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(venueId)) as
    | { time_zone: string | null; lat: number | null; lng: number | null }
    | undefined;
  const at = new Date(`${utc.replace(" ", "T").replace(/Z?$/, "Z")}`);
  if (Number.isNaN(at.getTime())) return utc;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: venueZoneOf(row ?? {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const p = (type: string) => parts.find((x) => x.type === type)?.value ?? "";
  return `${p("year")}-${p("month")}-${p("day")} ${p("hour")}:${p("minute")}`;
}

/**
 * An email to the customer, in the language their account last used, with a
 * link to their applications. Through the outbox (lib/outbox.ts), which
 * retries a failed delivery itself; a failure even to queue it never undoes
 * the decision it reports, which their account page shows anyway.
 */
async function tellCustomer(
  req: Pick<ApprovalRequest, "id" | "userId" | "venueId" | "venueName" | "sport"> & { forPerson?: ApprovalRequest["forPerson"] },
  mail: CustomerMail,
  extra: { reason?: string | null; until?: string | null; code?: string | null; slotTaken?: boolean; step?: string | null; payBy?: string | null } = {},
  dedupe?: string
): Promise<void> {
  try {
    const link = `${await venueBaseUrl(req.venueId)}/account/approvals`;
    const payBy = extra.payBy ? await venueTime(req.venueId, extra.payBy) : null;
    const vars = (t: { locale: string }) => ({ venue: req.venueName, activity: activityName(req.sport, t.locale) });
    await emailPlayer({
      venueId: req.venueId,
      userId: req.userId,
      subject: (t) => t(`apr.mail.${mail}Subject` as Phrase, vars(t)),
      body: (t) =>
        [
          // Applied for by the adult for somebody they manage: which of them it is about.
          req.forPerson ? t("guard.mail.about", { name: req.forPerson.name }) : null,
          t(`apr.mail.${mail}` as Phrase, {
            ...vars(t),
            reason: extra.reason ?? "",
            // Approved: "until <date>", or until taken back; a renewal reminder names the day itself.
            until: extra.until ? (mail === "approved" ? t("apr.untilDate", { date: extra.until }) : extra.until) : t("apr.untilTakenBack"),
            step: extra.step ?? "",
            code: extra.code ?? "",
          }),
          // Booked and held for payment: not theirs until paid, by then.
          extra.code && payBy ? t("apr.mail.payBy", { code: extra.code, time: payBy }) : extra.code && mail !== "latePaymentBooked" ? t("apr.mail.booked", { code: extra.code }) : null,
          extra.slotTaken ? t("apr.mail.slotTaken") : null,
        ]
          .filter(Boolean)
          .join("\n\n"),
      link,
      dedupeKey: dedupe ?? `approval:${req.id}:${mail}:${Date.now()}`,
    });
  } catch (err) {
    console.error(`[mysenam] could not queue the approval email (${mail}) for application ${req.id}:`, err);
  }
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
  // An adult applying for somebody they manage: both named, the relationship as declared (not verified).
  const applicant = req.forPerson
    ? `${req.appliedBy ?? "An adult"} (declared ${req.forPerson.relationship ?? "guardian"}, not verified), for ${req.name},`
    : req.name;
  for (const address of to)
    await emailPlain({
      to: address,
      venueId: req.venueId,
      kind: "staff_alert",
      subject: what === "new" ? `New application: ${activity} at ${req.venueName}` : `Application answered: ${activity} at ${req.venueName}`,
      text:
        what === "new"
          ? `${applicant} has applied online to be approved for ${activity} at ${req.venueName}. Review it in the dashboard (the bookings tab, or Courts & rates → Online applications), or, as a coach, signed in to your own MySenam account (your account's approvals page).`
          : `${applicant} has answered your question about their application for ${activity} at ${req.venueName}. It is waiting for review again.`,
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
        // Held as the booking it may become will be: separation, operational time and turnover by the court's rules.
        ...claimBuffers(day.policy),
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
 * How the booking a slot becomes is paid, by the venue's own policy: held for
 * payment (`deadline`: the activity's payment hours, for a customer told by
 * email; `present`: the venue's own minutes, for a customer booking it there
 * and then), or, on a member of staff's say, an exception paid at the counter.
 */
type PayMode = "deadline" | "present" | "exception";

/**
 * Book the slot a request asked for, through the ordinary booking path: its
 * hold let go and the booking claimed in one transaction, under the same
 * constraints as any booking. If its time is gone (the hold lapsed and
 * somebody took it), nothing is overbooked: the request says so.
 *
 * Where the venue asks payment online to hold a booking (lib/holds.ts), the
 * booking is held by the ordinary booking hold until paid, never confirmed
 * unpaid: `payBy` says until when. Elsewhere it stands unpaid, to be paid as
 * the venue takes payment (at the counter), as any booking there does.
 */
async function bookSlot(
  requestId: number,
  assessment: boolean,
  pay: PayMode = "deadline",
  payHours = 24
): Promise<{ booking: Booking | null; why: string | null; payBy: string | null }> {
  const db = getDb();
  const r = (await db
    .prepare(
      `SELECT r.court_id, r.slot_date, r.slot_start, r.slot_end, r.slot_status, r.booking_id, r.sport, r.user_id, r.venue_id, u.name, u.phone, u.email,
              r.managed_person_id, mp.display_name AS person_name
         FROM approval_requests r JOIN users u ON u.id = r.user_id LEFT JOIN participants mp ON mp.id = r.managed_person_id WHERE r.id = ?`
    )
    .get(requestId)) as
    | { court_id: number | null; slot_date: string | null; slot_start: number | null; slot_end: number | null; slot_status: SlotStatus | null; booking_id: number | null; sport: Sport; user_id: number; venue_id: number; name: string; phone: string; email: string; managed_person_id: number | null; person_name: string | null }
    | undefined;
  if (!r || r.court_id === null || r.slot_date === null || r.slot_start === null || r.slot_end === null || r.booking_id !== null) return { booking: null, why: null, payBy: null };
  if (r.slot_status !== "held" && r.slot_status !== "lapsed") return { booking: null, why: null, payBy: null };
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
    // For somebody the adult manages: booked by the adult, for them, on their eligibility.
    ...(r.managed_person_id !== null ? { participant: { id: r.managed_person_id, name: r.person_name ?? "" } } : {}),
  });
  if (made.ok) {
    const booking = made.bookings[0];
    let payBy: string | null = null;
    if (pay !== "exception" && booking.totalPrice > 0 && booking.paymentStatus === "unpaid") {
      const hold = await holdPolicy(r.venue_id);
      if (hold.active) {
        // Never held past the slot's own start.
        const toStart = Math.floor((new Date(booking.startsAt ?? Date.now()).getTime() - Date.now()) / 60_000);
        const minutes = Math.max(1, Math.min(pay === "present" ? hold.minutes : payHours * 60, toStart));
        payBy = await holdNewBookings([booking.id], minutes);
      }
    }
    await db
      .prepare("UPDATE approval_requests SET slot_status = ?, booking_id = ?, slot_assessment = ? WHERE id = ?")
      .run(payBy ? "awaiting_payment" : "booked", booking.id, assessment, requestId);
    await addEvent(requestId, { kind: "system", name: "MySenam" }, assessment ? "session_booked" : "slot_booked", booking.code);
    if (payBy) await addEvent(requestId, { kind: "system", name: "MySenam" }, "payment_requested", payBy);
    return { booking: payBy ? { ...booking, holdUntil: payBy } : booking, why: null, payBy };
  }
  await release({ kind: "approval", approvalId: requestId });
  await db.prepare("UPDATE approval_requests SET slot_status = 'taken' WHERE id = ?").run(requestId);
  await addEvent(requestId, { kind: "system", name: "MySenam" }, "slot_taken", made.error);
  return { booking: null, why: made.error, payBy: null };
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
  /** For somebody the account's adult manages (lib/managed-people.ts): their id. */
  forPerson?: unknown;
  /** The adult's declaration of their authority to apply for that person, for this application. */
  authority?: unknown;
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
 *
 * With `forPerson`, the account's adult applies for somebody they manage
 * (ADR 0022): the application is that person's (one live per person), the
 * adult is its applicant and the guardian on it (from their account, not
 * typed), declaring their authority for this application; documents, status
 * and email all go to the adult, and the waiver is agreed on the person's
 * behalf.
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
  // For somebody this adult manages: only their own, not archived, and with the adult's authority declared for it.
  const person = input.forPerson === undefined || input.forPerson === null ? null : await managedPerson(user.id, input.forPerson, { live: true });
  if (input.forPerson !== undefined && input.forPerson !== null && !person) return refused("GUARD_NOT_FOUND", "Not one of the people you manage.", 404);
  if (person && input.authority !== true)
    return refused("GUARD_AUTHORITY_NEEDED", "Confirm that you are their parent, legal guardian or another person with authority to apply for them.");
  const forId = person?.id ?? null;
  const db = getDb();
  // One live application per person: the adult's own, or a participant's whichever of their guardians made it.
  const live = await db
    .prepare(
      `SELECT 1 FROM approval_requests WHERE venue_id = ? AND sport = ? AND status IN ('pending', 'info_requested', 'in_person_due')
          AND (managed_person_id = ? OR (?::integer IS NULL AND managed_person_id IS NULL AND user_id = ?))`
    )
    .get(req.venueId, req.sport, forId, forId, user.id);
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
      participant: forId,
    })
  )
    return refused("APR_ALREADY_APPROVED", "You are already approved for this activity here.", 409);
  const answers = readAnswers(req.questions, input.answers);
  if (isRefused(answers)) return answers;
  if (req.declaration && input.declaration !== true) return refused("APR_DECLARATION_NEEDED", "Tick the declaration to go on.");
  if (req.videoUrl && input.videoWatched !== true) return refused("APR_VIDEO_NEEDED", "Watch the briefing video and confirm you have.");
  // The adult applying for somebody they manage is the guardian on it: from their account, not typed.
  if (!person && input.adult !== true && input.adult !== false) return refused("APR_ADULT_NEEDED", "Say whether you are 18 or over.");
  let guardianName: string | null = person ? user.name : null;
  if (!person && input.adult === false) {
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
  if (waiver && input.waiver !== true && !(person ? await waiverSignedFor(req.venueId, person.id) : await waiverSigned(req.venueId, user.phone)))
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
    .prepare(
      `SELECT id FROM approval_requests WHERE venue_id = ? AND sport = ? AND status = 'approved'
          AND (managed_person_id = ? OR (?::integer IS NULL AND managed_person_id IS NULL AND user_id = ?)) ORDER BY id DESC LIMIT 1`
    )
    .get(req.venueId, req.sport, forId, forId, user.id)) as { id: number } | undefined;

  // Documents stored in quarantine, scanned once the application has committed.
  let stored: number[] = [];
  const outcome = await withTransaction(async (): Promise<{ ok: true; id: number } | Refused> => {
    stored = [];
    const row = (await db
      .prepare(
        `INSERT INTO approval_requests (requirement_id, venue_id, sport, user_id, name, phone, status, renewal_of, answers, declared_at, video_watched_at,
           waiver_signed_at, declared_adult, guardian_name, guardian_declared_at, cert_reference, cert_expires_on, expires_at,
           managed_person_id, relationship, authority_declared_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ${req.declaration ? "now()" : "NULL"}, ${req.videoUrl ? "now()" : "NULL"},
           ${waiver ? "now()" : "NULL"}, ?, ?, ${guardianName ? "now()" : "NULL"}, ?, ?, ?, ?, ?, ${person ? "now()" : "NULL"})
         RETURNING id`
      )
      .get(
        req.id, req.venueId, req.sport, user.id, person ? person.displayName : user.name, user.phone, previous?.id ?? null, JSON.stringify(answers),
        // For somebody managed, the adult applies as their guardian: no declaration of the person's own age.
        !person && input.adult === true ? 1 : 0, guardianName, certReference, certExpiresOn, later(req.pendingDays * DAY),
        forId, person?.relationship ?? null
      )) as { id: number };
    const docs = await storeDocuments(row.id, files);
    if (isRefusal(docs)) throw docs;
    stored = docs;
    // The adult signs; for somebody they manage, on that person's behalf.
    if (waiver) await signWaiver(req.venueId, { phone: user.phone, name: user.name, participant: person ? { id: person.id, name: person.displayName } : null });
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
  // Scanned now, by the server's own call to the scanner; whatever cannot be scanned now is retried by the scheduler.
  await scanDocuments(stored);
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
  let stored: number[] = [];
  const outcome = await withTransaction(async (): Promise<{ ok: true } | Refused> => {
    stored = [];
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
        if (isRefusal(docs)) throw docs;
        stored = docs;
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
      // Booked there and then: held for payment for the venue's own minutes, where it asks payment to hold.
      const made = await bookSlot(id, true, "present", req.payHours);
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
  await scanDocuments(stored);
  if (tell) await (tell as () => Promise<void>)();
  // Held for payment: confirmed when paid (lib/payments.ts), as any held booking.
  if (booked && !(booked as Booking).holdUntil) await confirmBooking(booked as Booking, user.id);
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
  try {
    const { notifyBookingConfirmed } = await import("./notify");
    await notifyBookingConfirmed([(await getBookingById(booking.id)) ?? booking], await accountLocale(userId), null);
  } catch (err) {
    // The booking stands; its account page and the booking lookup show it.
    console.error(`[mysenam] could not queue the confirmation of booking ${booking.code}:`, err);
  }
}

// ------------------------------------------------------------ deciding

/**
 * What a reviewer can do: approve (the online part, where an in-person step
 * is still to come; otherwise the whole of it), reject, ask the customer for
 * more, record the in-person step, record the administrative check, or
 * revoke an approval in force; and, for an application an adult made for
 * somebody they manage, record that the adult's authority was reviewed.
 */
export type Decision = "approve" | "reject" | "ask" | "in_person" | "check" | "revoke" | "authority";
/** The decisions that grant eligibility: for a safety-assessed activity, only those authorised for it (ADR 0020). */
const GRANTS: Decision[] = ["approve", "in_person"];

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
 * Is this coach, as the database has it, linked to the account deciding,
 * active, of the application's venue, and named for its activity? Nothing
 * a caller passes in counts but the ids.
 */
async function coachDecides(reviewer: Extract<Reviewer, { kind: "coach" }>, requirementId: number, venueId: number): Promise<boolean> {
  const k = (await getDb().prepare("SELECT venue_id, active, user_id FROM coaches WHERE id = ?").get(reviewer.coach.id)) as
    | { venue_id: number; active: number; user_id: number | null }
    | undefined;
  if (!k || k.active !== 1 || k.venue_id !== venueId || k.user_id === null || k.user_id !== reviewer.userId) return false;
  return coachMayReview(reviewer.coach.id, requirementId, venueId);
}

/**
 * A reviewer's decision. Staff of the venue may review any of its
 * applications, a coach (signed in to their own account) only those for the
 * activities the venue named them for, and nothing else. Granting (approve,
 * the in-person step) a safety-assessed activity needs a manager, a named
 * coach or front-desk staff delegated for it; asking, the administrative
 * check, refusing and revoking grant nothing, and any reviewer may. Every
 * decision is in the application's history and the staff activity log, with
 * who, when and why.
 *
 * `payLater` (staff only): the booking a slot becomes is not held for
 * payment, where the venue asks payment to hold; an exception, recorded as
 * one, paid at the counter.
 *
 * An application an adult made for somebody they manage (ADR 0022): where
 * the activity asks for it (`guardianCheck`), granting waits until a
 * reviewer who may grant it records that they reviewed the adult's
 * authority (`authority`), never automatically; the sign-off approval writes
 * is that person's alone.
 */
export async function decide(
  reviewer: Reviewer,
  id: number,
  action: Decision,
  input: { reason?: unknown; venueId?: number; payLater?: unknown } = {}
): Promise<{ ok: true; request: ApprovalRequest; booking: Booking | null } | Refused> {
  const reason = typeof input.reason === "string" && input.reason.trim() !== "" ? input.reason.trim().slice(0, 1000) : null;
  if ((action === "reject" || action === "ask" || action === "revoke") && !reason)
    return refused("APR_REASON_NEEDED", action === "ask" ? "Say what you need to know." : action === "revoke" ? "Say why it is taken back." : "Say why it is refused.");
  const payLater = input.payLater === true;
  if (payLater && reviewer.kind !== "staff") return refused("APR_NOT_REVIEWER", "You may not review applications for this activity.", 403);
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
    if (reviewer.kind === "coach" && !(await coachDecides(reviewer, row.requirement_id, row.venue_id)))
      return refused("APR_NOT_REVIEWER", "You may not review applications for this activity.", 403);
    const req = (await requirementById(row.requirement_id))!;
    // Reviewing the authority of an adult applying for somebody else is part of granting: the same people.
    if ((GRANTS.includes(action) || action === "authority") && reviewer.kind === "staff" && !(await staffGrants(reviewer.admin.id, req)))
      return refused(
        "APR_SAFETY_AUTHORITY",
        "This is a safety assessment: a manager, a coach named for this activity, or staff delegated for it decides. You can ask for more, record the administrative check, or refuse.",
        403
      );
    const r = (await db
      .prepare(
        `SELECT name, cert_expires_on, cert_reference, online_ok_at, in_person_at, admin_checked_at, slot_status, sign_off_id, booking_id, user_id, phone, sport, venue_id,
                managed_person_id, authority_reviewed_at, (SELECT u.name FROM users u WHERE u.id = approval_requests.user_id) AS applicant_name
           FROM approval_requests WHERE id = ?`
      )
      .get(id)) as {
      managed_person_id: number | null;
      authority_reviewed_at: unknown;
      applicant_name: string | null;
      name: string;
      cert_expires_on: string | null;
      cert_reference: string | null;
      online_ok_at: unknown;
      in_person_at: unknown;
      admin_checked_at: unknown;
      slot_status: SlotStatus | null;
      sign_off_id: number | null;
      booking_id: number | null;
      user_id: number;
      phone: string;
      sport: Sport;
      venue_id: number;
    };
    const who = reviewerName(reviewer);
    const actor = reviewerActor(reviewer);
    const activity = activityName(req.sport, "en");
    const pay: PayMode = payLater ? "exception" : "deadline";
    // For somebody an adult manages: named with who applied, in the activity log.
    const forPerson = r.managed_person_id !== null;
    const named = forPerson ? `${r.name} (applied for by ${r.applicant_name ?? "their adult"})` : r.name;

    if (action === "authority") {
      if (!forPerson) return refused("APR_CHILD_OWN", "This application is the applicant's own: there is no authority to review.", 409);
      if (!LIVE_STATUSES.includes(row.status) || r.authority_reviewed_at !== null) return wrongStatus();
      await db.prepare("UPDATE approval_requests SET authority_reviewed_at = now(), authority_reviewed_by = ? WHERE id = ?").run(who, id);
      await addEvent(id, actor, "authority_reviewed", reason);
      logged = { action: "approval.authority_reviewed", detail: `Reviewed the authority of ${r.applicant_name ?? "the adult"} to apply for ${r.name} (${activity})` };
      return { ok: true };
    }
    // The venue asks staff to review an adult's authority before approving somebody they manage: never skipped.
    if (GRANTS.includes(action) && forPerson && req.guardianCheck && r.authority_reviewed_at === null)
      return refused("APR_CHILD_AUTHORITY_UNREVIEWED", "Record that you reviewed the authority of the adult who applied before approving.", 409);
    // A document the activity asks for must have passed its malware scan, and none may still be waiting for it (ADR 0024).
    if (GRANTS.includes(action) && req.documentLabel) {
      const scans = (await db.prepare("SELECT scan_status FROM approval_documents WHERE request_id = ?").all(id)) as { scan_status: ScanStatus }[];
      if (scans.some((d) => d.scan_status === "pending") || !scans.some((d) => RELEASED.includes(d.scan_status)))
        return refused(
          "SCAN_NOT_CLEAN",
          "The document this activity needs has not passed its malware scan, so this cannot be approved yet. Wait for the scan, or ask the applicant for another file.",
          409
        );
    }

    if (action === "ask") {
      if (row.status !== "pending" && row.status !== "info_requested") return wrongStatus();
      await db.prepare("UPDATE approval_requests SET status = 'info_requested', expires_at = ? WHERE id = ?").run(later(req.pendingDays * DAY), id);
      await addEvent(id, actor, "asked", reason);
      mail = { kind: "asked", extra: { reason } };
      logged = { action: "approval.asked", detail: `Asked ${named} for more about their application for ${activity}: ${reason}` };
      return { ok: true };
    }
    if (action === "reject") {
      if (!LIVE_STATUSES.includes(row.status)) return wrongStatus();
      await db.prepare("UPDATE approval_requests SET status = 'rejected', decided_at = now() WHERE id = ?").run(id);
      await releaseHold(id, "released");
      await addEvent(id, actor, "rejected", reason);
      mail = { kind: "rejected", extra: { reason } };
      logged = { action: "approval.rejected", detail: `Refused ${named}'s application for ${activity}: ${reason}` };
      return { ok: true };
    }
    if (action === "check") {
      // The administrative check: complete, a membership held. It grants nothing on its own.
      if (!LIVE_STATUSES.includes(row.status) || r.admin_checked_at !== null) return wrongStatus();
      await db.prepare("UPDATE approval_requests SET admin_checked_at = now(), admin_checked_by = ? WHERE id = ?").run(who, id);
      await addEvent(id, actor, "checked", reason);
      logged = { action: "approval.checked", detail: `Checked ${named}'s application for ${activity} (administrative)` };
      return { ok: true };
    }
    if (action === "revoke") return revokeInside(reviewer, id, row.status, { ...r, name: named }, req, reason!, (m, l) => ((mail = m), (logged = l)));

    const onlineOk = r.online_ok_at !== null;
    let inPersonDone = r.in_person_at !== null;
    if (action === "in_person") {
      if (!req.inPerson) return refused("APR_NO_IN_PERSON", "This activity has no in-person step to record.", 409);
      if (!LIVE_STATUSES.includes(row.status) || inPersonDone) return wrongStatus();
      await db.prepare("UPDATE approval_requests SET in_person_at = now(), in_person_by = ? WHERE id = ?").run(who, id);
      await addEvent(id, actor, "in_person_recorded", reason);
      inPersonDone = true;
      logged = { action: "approval.in_person", detail: `Recorded the in-person step (${req.inPerson}) for ${named}, ${activity}` };
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
        logged = { action: "approval.online_accepted", detail: `Accepted the online part of ${named}'s application for ${activity}; the in-person step is still to come` };
        const session = r.slot_status === "held" || r.slot_status === "lapsed" ? await bookSlot(id, true, pay, req.payHours) : null;
        if (session?.booking) {
          booked = session.booking;
          await extendForSession(id, session.booking);
          logged.code = session.booking.code;
          if (payLater) await notePayException(id, actor, who, session.booking, logged, req.venueId);
        }
        mail = {
          kind: "inPersonDue",
          extra: { step: req.inPerson, code: session?.booking?.code ?? null, payBy: session?.payBy ?? null, slotTaken: session !== null && !session.booking },
        };
        return { ok: true };
      }
    }
    // Everything asked for is done: approved, and the sign-off the booking rules check is written.
    const user = (await db
      .prepare("SELECT u.name, u.email, u.phone FROM approval_requests r JOIN users u ON u.id = r.user_id WHERE r.id = ?")
      .get(id)) as { name: string; email: string; phone: string };
    const validUntil = validUntilFor(req, r.cert_expires_on);
    // For somebody the adult manages: theirs alone, linked to the adult's account and reached on the adult's number.
    const signed = await addSignOff({
      venueId: req.venueId,
      sport: req.sport,
      phone: user.phone,
      name: forPerson ? r.name : user.name,
      email: user.email,
      kind: req.kind,
      reference: req.kind === "certification" ? r.cert_reference : null,
      note: `Approved online (application ${id}) by ${who}${forPerson ? `; for somebody ${user.name} manages` : ""}`,
      expiresOn: validUntil,
      adminId: reviewer.kind === "staff" ? reviewer.admin.id : null,
      managedPersonId: r.managed_person_id,
    });
    if (!signed.ok) throw new Error(`approval ${id}: ${signed.error}`);
    await db
      .prepare("UPDATE approval_requests SET status = 'approved', decided_at = now(), valid_until = ?, sign_off_id = ?, renew_notice_at = NULL WHERE id = ?")
      .run(validUntil, signed.signOff.id, id);
    await addEvent(id, actor, "approved", action === "approve" ? reason : null);
    const made = await bookSlot(id, false, pay, req.payHours);
    booked = made.booking;
    const detail = `Approved ${named} for ${activity}${validUntil ? ` until ${validUntil}` : ""}${action === "in_person" ? " on recording the in-person step" : ""}`;
    logged = { action: "approval.approved", detail, code: made.booking?.code ?? null };
    if (payLater && made.booking) await notePayException(id, actor, who, made.booking, logged, req.venueId);
    mail = { kind: "approved", extra: { until: validUntil, code: made.booking?.code ?? null, payBy: made.payBy, slotTaken: made.why !== null } };
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
  // Held for payment: confirmed when paid (lib/payments.ts), as any held booking.
  if (booked && !(booked as Booking).holdUntil) await confirmBooking(booked as Booking, request.userId);
  if (action === "revoke") await offerFreedSlot(request);
  return { ok: true, request, booking: booked };
}

/** A member of staff let a booking made on approval go unheld at a venue asking payment to hold: on record. */
async function notePayException(
  id: number,
  actor: ReturnType<typeof reviewerActor>,
  who: string,
  booking: Booking,
  logged: { action: string; detail: string; code?: string | null },
  venueId: number
): Promise<void> {
  if (booking.paymentStatus !== "unpaid" || booking.totalPrice <= 0 || !(await holdPolicy(venueId)).active) return;
  await addEvent(id, actor, "pay_exception", booking.code);
  logged.detail += `; not held for payment, on ${who}'s say (paid at the counter)`;
}

/**
 * Take an approval back: the sign-off it wrote is revoked (online booking of
 * the activity and its door codes stop at once); a booking it made that is
 * still waiting for its payment is let go (it was never confirmed); the
 * person's confirmed bookings of the activity here from today on are flagged
 * for staff to decide (cancel, supervise, or keep), never cancelled silently.
 */
async function revokeInside(
  reviewer: Reviewer,
  id: number,
  status: ApprovalStatus,
  r: { name: string; sign_off_id: number | null; booking_id: number | null; slot_status: SlotStatus | null; user_id: number; phone: string; sport: Sport; venue_id: number; managed_person_id: number | null },
  req: ApprovalRequirement,
  reason: string,
  done: (mail: { kind: CustomerMail; extra: Parameters<typeof tellCustomer>[2] }, logged: { action: string; detail: string }) => void
): Promise<{ ok: true } | Refused> {
  if (status !== "approved" || r.sign_off_id === null) return wrongStatus();
  const taken = await revokeSignOff(r.venue_id, r.sign_off_id, { adminId: reviewer.kind === "staff" ? reviewer.admin.id : null, reason });
  if (!taken) return wrongStatus();
  await addEvent(id, reviewerActor(reviewer), "revoked", reason);
  const flagged = await afterRevocation(id, r);
  done(
    { kind: "revoked", extra: { reason } },
    {
      action: "approval.revoked",
      detail: `Revoked ${r.name}'s approval for ${activityName(req.sport, "en")}: ${reason}${flagged ? `; ${flagged} booking(s) flagged for staff` : ""}`,
    }
  );
  return { ok: true };
}

type RevokedRow = { booking_id: number | null; slot_status: SlotStatus | null; user_id: number; phone: string; sport: Sport; venue_id: number; managed_person_id: number | null };

/** What follows a revocation, however it was made: returns how many bookings were flagged for staff. */
async function afterRevocation(id: number, r: RevokedRow): Promise<number> {
  const db = getDb();
  // Its own booking, still held for payment: not confirmed, so let go (a payment landing later is owed back).
  if (r.slot_status === "awaiting_payment" && r.booking_id !== null) {
    const let_go = await db
      .prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'confirmed' AND payment_status = 'unpaid' AND hold_until IS NOT NULL")
      .run(r.booking_id);
    if (let_go.changes > 0) {
      await releaseBooking(r.booking_id);
      await settleCancelled(r.booking_id);
      await db.prepare("UPDATE approval_requests SET slot_status = 'released' WHERE id = ?").run(id);
      await addEvent(id, { kind: "system", name: "MySenam" }, "booking_released");
    }
  }
  // Confirmed bookings of this activity here, from today on: for staff to decide. The person's own:
  // for a participant, every booking they take a place on, whoever booked it; for the adult, their own
  // bookings that they take part in themself, none taken by somebody else alone (lib/participants.ts).
  const future = (await db
    .prepare(
      `SELECT b.id FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id = ? AND b.sport = ? AND b.status = 'confirmed' AND b.date >= ?
          AND ${
            r.managed_person_id !== null
              ? PARTICIPANT_TAKES_PART("b")
              : `(b.user_id = ? OR b.phone_key = phone_key(?)) AND ${CUSTOMER_TAKES_PART("b")}`
          }`
    )
    .all(r.venue_id, r.sport, todayISO(), ...(r.managed_person_id !== null ? [r.managed_person_id] : [r.user_id, r.phone]))) as { id: number }[];
  for (const b of future)
    await db
      .prepare("INSERT INTO approval_booking_flags (request_id, booking_id, venue_id) VALUES (?, ?, ?) ON CONFLICT (request_id, booking_id) DO NOTHING")
      .run(id, b.id, r.venue_id);
  if (future.length > 0) await addEvent(id, { kind: "system", name: "MySenam" }, "bookings_flagged", String(future.length));
  return future.length;
}

/**
 * A sign-off an approval wrote was taken back in the Sign-offs tab
 * (lib/sign-offs.ts): the same follows as for revoking the approval itself,
 * so no path takes eligibility back without it.
 */
export async function signOffRevoked(signOffId: number, admin: Pick<Admin, "id" | "name">, reason: string | null): Promise<void> {
  const db = getDb();
  const found = (await db.prepare("SELECT id FROM approval_requests WHERE sign_off_id = ? AND status = 'approved'").get(signOffId)) as { id: number } | undefined;
  if (!found) return;
  const id = found.id;
  await withTransaction(async () => {
    await lockRequest(id);
    const r = (await db
      .prepare("SELECT booking_id, slot_status, user_id, phone, sport, venue_id, managed_person_id FROM approval_requests WHERE id = ?")
      .get(id)) as RevokedRow;
    await addEvent(id, { kind: "staff", name: admin.name, adminId: admin.id }, "revoked", reason ?? "Taken back in Sign-offs");
    await afterRevocation(id, r);
  });
  const request = await requestById(id);
  if (request) {
    await tellCustomer(request, "revoked", { reason: reason ?? "" });
    await offerFreedSlot(request);
  }
}

/** A booking let go on revocation frees its slot: offered to whoever waits for it, as a hold let go is. */
async function offerFreedSlot(request: ApprovalRequest): Promise<void> {
  if (request.slot?.status !== "released" || !request.events.some((e) => e.action === "booking_released")) return;
  try {
    await offerSlotPlace(request.slot.courtId, request.slot.date);
  } catch (err) {
    console.error(`[mysenam] could not offer the place freed by application ${request.id}:`, err);
  }
}

// ------------------------------------------------------------ bookings flagged after a revocation

export interface FlaggedBooking {
  id: number;
  requestId: number;
  name: string;
  sport: Sport;
  bookingCode: string;
  date: string;
  start: number;
  end: number;
  courtName: string;
  bookingStatus: string;
  supervised: boolean;
  revokeReason: string | null;
  createdAt: string;
}

/** Bookings still to be decided after an approval was revoked, at a venue. */
export async function flaggedBookings(venueId: number): Promise<FlaggedBooking[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT f.id, f.request_id, r.name, r.sport, b.code, b.date, b.start_min, b.end_min, c.name AS court_name, b.status, b.staff_supervised,
              s.revoke_reason, f.created_at
         FROM approval_booking_flags f
         JOIN approval_requests r ON r.id = f.request_id
         JOIN bookings b ON b.id = f.booking_id
         JOIN courts c ON c.id = b.court_id
         LEFT JOIN sign_offs s ON s.id = r.sign_off_id
        WHERE f.venue_id = ? AND f.resolved_at IS NULL
        ORDER BY b.date, b.start_min LIMIT 200`
    )
    .all(venueId)) as {
    id: number;
    request_id: number;
    name: string;
    sport: Sport;
    code: string;
    date: string;
    start_min: number;
    end_min: number;
    court_name: string;
    status: string;
    staff_supervised: boolean;
    revoke_reason: string | null;
    created_at: unknown;
  }[];
  return rows.map((f) => ({
    id: f.id,
    requestId: f.request_id,
    name: f.name,
    sport: f.sport,
    bookingCode: f.code,
    date: f.date,
    start: f.start_min,
    end: f.end_min,
    courtName: f.court_name,
    bookingStatus: f.status,
    supervised: f.staff_supervised === true,
    revokeReason: f.revoke_reason,
    createdAt: isoOf(f.created_at),
  }));
}

/** Staff have dealt with a flagged booking (cancelled it, arranged supervision, or kept it): on record, with a note. */
export async function resolveFlag(admin: Pick<Admin, "id" | "name">, venueId: number, flagId: number, note: unknown): Promise<boolean> {
  const text = typeof note === "string" && note.trim() !== "" ? note.trim().slice(0, 300) : null;
  if (!text) return false;
  const done = await getDb()
    .prepare("UPDATE approval_booking_flags SET resolved_at = now(), resolved_by = ?, resolution = ? WHERE id = ? AND venue_id = ? AND resolved_at IS NULL")
    .run(admin.name, text, flagId, venueId);
  return done.changes === 1;
}

// ------------------------------------------------------------ supervised attendance

/**
 * A manager arranges (or stops) staff-supervised attendance on a booking: on
 * record in the activity log. A supervised booking is never given a door
 * code, and it is no sign-off: it authorises no unmanned use, then or later
 * (lib/store.ts `accessCodeFor`).
 */
export async function setSupervised(
  admin: Pick<Admin, "id" | "name">,
  venueId: number,
  code: unknown,
  on: boolean,
  note: unknown
): Promise<{ ok: true; code: string } | Refused> {
  if (typeof code !== "string" || code.trim() === "") return refused("APR_BOOKING_NOT_FOUND", "Booking not found.", 404);
  const why = typeof note === "string" && note.trim() !== "" ? note.trim().slice(0, 300) : null;
  if (on && !why) return refused("APR_REASON_NEEDED", "Say who supervises, under which procedure.");
  const row = (await getDb()
    .prepare(
      `SELECT b.id, b.code FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE UPPER(b.code) = UPPER(?) AND c.venue_id = ? AND b.status = 'confirmed'`
    )
    .get(code.trim(), venueId)) as { id: number; code: string } | undefined;
  if (!row) return refused("APR_BOOKING_NOT_FOUND", "Booking not found.", 404);
  await getDb().prepare("UPDATE bookings SET staff_supervised = ? WHERE id = ?").run(on, row.id);
  await logAction(admin, {
    venueId,
    action: on ? "booking.supervised" : "booking.unsupervised",
    detail: on ? `Arranged staff-supervised attendance for ${row.code}: ${why}` : `No longer staff-supervised: ${row.code}${why ? ` (${why})` : ""}`,
    bookingCode: row.code,
  });
  return { ok: true, code: row.code };
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

  // Bookings made on approval and held for payment: paid, let go, or cancelled since.
  await syncApprovalBookings();
  // Payments that landed after their hold was let go and were not yet turned back into the booking.
  await recoverLatePayments();

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

// ------------------------------------------------------------ payment after approval

/**
 * Bring applications whose booking was held for payment up to date with
 * that booking: paid (or a deposit paid, which stands it) → `booked`; let go
 * unpaid → `payment_lapsed`, the customer told their approval stands and the
 * slot is free again; cancelled otherwise (by staff, or on revocation) →
 * `released`. Each moves once, under the application's row lock. Called as
 * a payment settles (lib/payments.ts) and on the scheduler's tick.
 */
export async function syncApprovalBookings(bookingIds?: number[]): Promise<number> {
  const db = getDb();
  if (bookingIds && bookingIds.length === 0) return 0;
  const rows = (await db
    .prepare(
      `SELECT r.id FROM approval_requests r JOIN bookings b ON b.id = r.booking_id
        WHERE r.slot_status = 'awaiting_payment'
          AND (b.status = 'cancelled' OR b.hold_until IS NULL OR b.payment_status = 'paid' OR b.deposit_paid > 0)
          ${bookingIds ? `AND r.booking_id IN (${bookingIds.map(() => "?").join(",")})` : ""}
        ORDER BY r.id LIMIT 200`
    )
    .all(...(bookingIds ?? []))) as { id: number }[];
  let moved = 0;
  for (const { id } of rows) {
    let told: { mail: CustomerMail; code: string } | null = null;
    await withTransaction(async () => {
      await lockRequest(id);
      const b = (await db
        .prepare(
          `SELECT b.code, b.status, b.payment_status, b.hold_until, b.released_unpaid, b.deposit_paid::float AS deposit_paid
             FROM approval_requests r JOIN bookings b ON b.id = r.booking_id
            WHERE r.id = ? AND r.slot_status = 'awaiting_payment'`
        )
        .get(id)) as { code: string; status: string; payment_status: string; hold_until: string | null; released_unpaid: number; deposit_paid: number } | undefined;
      if (!b) return;
      const sys = { kind: "system" as const, name: "MySenam" };
      // Paid, a deposit paid (which stands it), or no longer held at all (staff took it off hold).
      if (b.status === "confirmed" && (b.hold_until === null || b.payment_status === "paid" || Number(b.deposit_paid) > 0)) {
        await db.prepare("UPDATE approval_requests SET slot_status = 'booked' WHERE id = ?").run(id);
        await addEvent(id, sys, "paid", b.code);
      } else if (b.status === "cancelled" && b.released_unpaid === 1) {
        await db.prepare("UPDATE approval_requests SET slot_status = 'payment_lapsed' WHERE id = ?").run(id);
        await addEvent(id, sys, "payment_lapsed", b.code);
        told = { mail: "paymentLapsed", code: b.code };
      } else if (b.status === "cancelled") {
        await db.prepare("UPDATE approval_requests SET slot_status = 'released' WHERE id = ?").run(id);
        await addEvent(id, sys, "booking_cancelled", b.code);
      } else return;
      moved++;
    });
    const t = told as { mail: CustomerMail; code: string } | null;
    if (t) {
      const r = await requestById(id);
      if (r) await tellCustomer(r, t.mail, { code: t.code }, `approval:${id}:${t.mail}:${t.code}`);
    }
  }
  return moved;
}

/**
 * A payment that landed after its booking's hold was let go (the gateway's
 * page could not be closed, or the money came late). Never left as money
 * without anything for it: if the approval still stands and the slot is
 * still free, the booking is made again through the ordinary booking path,
 * paid with that payment, and what was owed back is reduced by what it now
 * costs, all in one transaction; if not, it stays owed back (lib/payments.ts
 * *Refunds owed*) and the customer is told. A full payment only: a late
 * deposit stays owed back. Once per payment and booking, whoever asks
 * (the payment settling, or the scheduler after an interruption): the
 * outcome is in the application's history, keyed to the payment.
 */
export async function recoverLatePayments(paymentId?: number): Promise<{ booked: number; owed: number }> {
  const db = getDb();
  const candidates = (await db
    .prepare(
      `SELECT p.id AS payment_id, pb.booking_id, pb.amount::float AS billed, r.id AS request_id
         FROM online_payments p
         JOIN online_payment_bookings pb ON pb.payment_id = p.id
         JOIN bookings b ON b.id = pb.booking_id AND b.status = 'cancelled' AND b.released_unpaid = 1
         JOIN approval_requests r ON r.booking_id = b.id AND r.slot_status IN ('awaiting_payment', 'payment_lapsed')
        WHERE p.status = 'paid' AND p.purpose = 'booking' AND p.deposit = 0 AND p.refund_due > p.refunded
          ${paymentId !== undefined ? "AND p.id = ?" : "AND p.paid_at > datetime('now', '-2 days')"}
          AND NOT EXISTS (SELECT 1 FROM approval_events e WHERE e.request_id = r.id
                           AND e.action IN ('late_payment_booked', 'late_payment_refund') AND e.reason = 'payment:' || p.id)
        ORDER BY p.id LIMIT 100`
    )
    .all(...(paymentId !== undefined ? [paymentId] : []))) as { payment_id: number; booking_id: number; billed: number | null; request_id: number }[];
  let booked = 0;
  let owed = 0;
  for (const c of candidates) {
    const key = `payment:${c.payment_id}`;
    let made: Booking | null = null;
    const why = await withTransaction(async (): Promise<string | null> => {
      const row = await lockRequest(c.request_id);
      if (!row) return "gone";
      const seen = await db
        .prepare("SELECT 1 FROM approval_events WHERE request_id = ? AND action IN ('late_payment_booked', 'late_payment_refund') AND reason = ?")
        .get(c.request_id, key);
      if (seen) return "seen";
      const r = (await db
        .prepare(
          `SELECT r.booking_id, r.slot_status, r.slot_assessment, r.court_id, r.slot_date, r.slot_start, r.slot_end, r.sport, r.user_id, r.venue_id,
                  u.name, u.phone, u.email, r.managed_person_id, mp.display_name AS person_name
             FROM approval_requests r JOIN users u ON u.id = r.user_id LEFT JOIN participants mp ON mp.id = r.managed_person_id WHERE r.id = ?`
        )
        .get(c.request_id)) as {
        booking_id: number;
        slot_status: SlotStatus;
        slot_assessment: boolean;
        court_id: number | null;
        slot_date: string;
        slot_start: number;
        slot_end: number;
        sport: Sport;
        user_id: number;
        venue_id: number;
        name: string;
        phone: string;
        email: string;
        managed_person_id: number | null;
        person_name: string | null;
      };
      if (r.booking_id !== c.booking_id || r.court_id === null) return "moved on";
      // Still eligible: an approval in force for that day, or (the in-person session) the application still waiting on it.
      const eligible =
        r.slot_assessment === true
          ? row.status === "in_person_due"
          : row.status === "approved" &&
            (await signOffHolds({
              venueId: r.venue_id,
              sport: r.sport,
              until: r.slot_date,
              phone: r.phone,
              userId: r.user_id,
              channel: "customer",
              need: "any",
              participant: r.managed_person_id,
            }));
      const owedBack = async (why: string) => {
        await addEvent(c.request_id, { kind: "system", name: "MySenam" }, "late_payment_refund", key);
        return why;
      };
      if (!eligible) return owedBack("not eligible");
      const pay = (await db.prepare("SELECT refund_due::float AS due, refunded::float AS refunded FROM online_payments WHERE id = ? FOR UPDATE").get(c.payment_id)) as {
        due: number;
        refunded: number;
      };
      const again = await createBookingSeries({
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
        approval: { id: c.request_id, assessment: r.slot_assessment === true },
        ...(r.managed_person_id !== null ? { participant: { id: r.managed_person_id, name: r.person_name ?? "" } } : {}),
      });
      if (!again.ok) return owedBack("taken");
      const booking = again.bookings[0];
      const cost = Math.round((booking.totalPrice - (booking.sharesPaid ?? 0)) * 100) / 100;
      const billed = c.billed ?? cost;
      // Only what this payment covers, and only out of what is still owed back on it.
      if (cost > billed + 0.005 || pay.due - pay.refunded < cost - 0.005) throw new LateRecoveryRefused();
      await db.prepare("UPDATE bookings SET payment_status = 'paid', paid_at = ?, paid_via = 'online' WHERE id = ?").run(new Date().toISOString(), booking.id);
      await db.prepare("INSERT INTO online_payment_bookings (payment_id, booking_id, amount) VALUES (?, ?, ?)").run(c.payment_id, booking.id, cost);
      const cut = await db
        .prepare("UPDATE online_payments SET refund_due = refund_due - ? WHERE id = ? AND refund_due - ? >= refunded - 0.005")
        .run(cost, c.payment_id, cost);
      if (cut.changes !== 1) throw new LateRecoveryRefused();
      await db.prepare("UPDATE approval_requests SET booking_id = ?, slot_status = 'booked' WHERE id = ?").run(booking.id, c.request_id);
      await addEvent(c.request_id, { kind: "system", name: "MySenam" }, "late_payment_booked", key);
      made = booking;
      return null;
    }).catch((err: unknown) => {
      if (err instanceof LateRecoveryRefused) return "price";
      throw err;
    });
    if (why === "seen" || why === "gone" || why === "moved on") continue;
    const request = await requestById(c.request_id);
    if (!request) continue;
    if (why === null && made) {
      booked++;
      const b = made as Booking;
      await logDecision("system", request.venueId, "approval.late_payment", `${request.name}'s payment came after their hold was let go; booked again as ${b.code}, paid`, b.code);
      await tellCustomer(request, "latePaymentBooked", { code: b.code }, `approval:${c.request_id}:latePaymentBooked:${key}`);
      await confirmBooking((await getBookingById(b.id)) ?? b, request.userId);
      continue;
    }
    // Stays owed back: written down once (the price case after its rollback), and the customer told.
    if (why === "price") await addEvent(c.request_id, { kind: "system", name: "MySenam" }, "late_payment_refund", key);
    owed++;
    await logDecision("system", request.venueId, "approval.late_payment", `${request.name}'s payment came after their hold was let go and could not become the booking (${why}); it is owed back`);
    await tellCustomer(request, "latePaymentRefund", {}, `approval:${c.request_id}:latePaymentRefund:${key}`);
  }
  return { booked, owed };
}

/**
 * A booking payment has just settled (lib/payments.ts `settleBill`): bring
 * any application whose booking it paid up to date, and turn a late one back
 * into its booking where it still can be. Never throws: the payment is
 * recorded already, and the scheduler does the same on its next tick.
 */
export async function approvalPaymentSettled(paymentId: number): Promise<void> {
  try {
    const ids = (
      (await getDb().prepare("SELECT booking_id FROM online_payment_bookings WHERE payment_id = ?").all(paymentId)) as { booking_id: number }[]
    ).map((r) => r.booking_id);
    if (ids.length === 0) return;
    if (!(await getDb().prepare(`SELECT 1 FROM approval_requests WHERE booking_id IN (${ids.map(() => "?").join(",")}) LIMIT 1`).get(...ids))) return;
    await syncApprovalBookings(ids);
    await recoverLatePayments(paymentId);
  } catch (err) {
    console.error(`[mysenam] approval follow-up of payment ${paymentId} failed (the scheduler retries it):`, err);
  }
}

/** Rolls back a late payment's booking that the payment does not cover. */
class LateRecoveryRefused extends Error {}

// ------------------------------------------------------------ personal data

/** Everything held about a customer's applications, documents included, for their data export (lib/privacy.ts). */
export async function approvalsExport(userId: number): Promise<unknown[]> {
  const list = await customerApprovals(userId);
  const out: unknown[] = [];
  for (const r of list) {
    // A document's bytes only once its malware scan released it: one in quarantine, refused or unscannable is listed, not copied.
    const docs = (await getDb()
      .prepare(
        "SELECT id, content_type, CASE WHEN scan_status IN ('clean', 'not_scanned') THEN content END AS content, file_name, pages, created_at, scan_status FROM approval_documents WHERE request_id = ? ORDER BY id"
      )
      .all(r.id)) as {
      id: number;
      content_type: string;
      content: Uint8Array | null;
      file_name: string | null;
      pages: number | null;
      created_at: unknown;
      scan_status: ScanStatus;
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
      // Made for somebody this account manages: who, the relationship and authority as declared, and any staff review of it.
      forPerson: r.forPerson ? { name: r.forPerson.name, declaredRelationship: r.forPerson.relationship } : null,
      authorityDeclaredAt: r.authorityDeclaredAt,
      authorityReviewedAt: r.authorityReviewedAt,
      onlinePartAcceptedAt: r.onlineOkAt,
      inPersonStepAt: r.inPersonAt,
      decidedAt: r.decidedAt,
      validUntil: r.validUntil,
      slot: r.slot ? { court: r.slot.courtName, date: r.slot.date, start: r.slot.start, end: r.slot.end, status: r.slot.status } : null,
      bookingCode: r.bookingCode,
      history: r.events,
      documents: docs.map((d) => ({
        uploadedAt: iso(d.created_at),
        fileName: documentName(d),
        contentType: d.content_type,
        pages: d.pages,
        malwareScan: d.scan_status,
        base64: d.content === null ? null : Buffer.from(d.content).toString("base64"),
      })),
      documentsOpened: await documentAccesses(r.id),
    });
  }
  // Applications whose record has gone: what is still kept of each (lib/approval-retention.ts).
  out.push(...(await removedApplications(userId)));
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
    forPerson: r.forPerson ? { name: r.forPerson.name, appliedBy: r.appliedBy, declaredRelationship: r.forPerson.relationship } : null,
    decidedAt: r.decidedAt,
    validUntil: r.validUntil,
    documents: r.documents.length,
    history: r.events,
  }));
}

/** On erasure: the customer's applications, answers, documents and holds go with the account. */
export async function eraseApprovals(userId: number): Promise<void> {
  const db = getDb();
  // The bare facts of each decision stay, linked to nobody (lib/approval-retention.ts).
  await forgetApplicant(userId);
  await db.prepare("UPDATE claims SET active = false WHERE approval_id IN (SELECT id FROM approval_requests WHERE user_id = ?) AND active").run(userId);
  await db.prepare("DELETE FROM approval_requests WHERE user_id = ?").run(userId);
}

/**
 * A guardian's relationship to a participant ended or was revoked
 * (lib/participants.ts): their applications for that participant still
 * waiting are withdrawn, any slot held let go, so nothing new is made by
 * them for the participant. Decided ones stay as they are, and their history.
 */
export async function guardianEnded(userId: number, participantId: number, by: string): Promise<number> {
  const db = getDb();
  const live = (await db
    .prepare(`SELECT id FROM approval_requests WHERE user_id = ? AND managed_person_id = ? AND status IN (${LIVE_STATUSES.map(() => "?").join(",")})`)
    .all(userId, participantId, ...LIVE_STATUSES)) as { id: number }[];
  for (const { id } of live)
    await withTransaction(async () => {
      const row = await lockRequest(id);
      if (!row || !LIVE_STATUSES.includes(row.status)) return;
      await db.prepare("UPDATE approval_requests SET status = 'withdrawn', decided_at = now() WHERE id = ?").run(id);
      await releaseHold(id, "released");
      await addEvent(id, { kind: "system", name: "MySenam" }, "withdrawn", `Guardian relationship ended (${by})`);
    });
  return live.length;
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
  const limit = MAX_DOCUMENTS * MAX_DOCUMENT_BYTES + 256 * 1024;
  if (Number(req.headers.get("content-length") ?? 0) > limit) return { ok: false, error: "That file is over 10 MB. Send a smaller one.", status: 413 };
  let form: FormData;
  try {
    // Read at most the limit, whatever the request declared (a body sent without a length, or longer than it said),
    // so an upload cannot exhaust memory before its size is known (ADR 0024).
    const raw = await readCapped(req, limit);
    if (raw === null) return { ok: false, error: "That file is over 10 MB. Send a smaller one.", status: 413 };
    form = await new Response(new Uint8Array(raw), { headers: { "content-type": type } }).formData();
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
    if (f.size > MAX_DOCUMENT_BYTES) return { ok: false, error: "That file is over 10 MB. Send a smaller one.", status: 413 };
    // What the browser said it is, to check against what it is (lib/approval-documents.ts).
    files.push(uploaded(Buffer.from(await f.arrayBuffer()), f instanceof File ? f.name : null, f.type));
  }
  if (files.length > MAX_DOCUMENTS) return { ok: false, error: `Up to ${MAX_DOCUMENTS} documents.`, status: 400 };
  return { ok: true, body: body && typeof body === "object" ? body : {}, files };
}

/** A request's body, read up to `limit` bytes; null as soon as it goes past. In memory, never to disk. */
async function readCapped(req: Request, limit: number): Promise<Buffer | null> {
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** A refusal as a route answers it. */
export function refusalBody(r: Refused): { error: string; code: string; vars?: Record<string, string | number> } {
  return { error: r.error, code: r.code, ...(r.vars ? { vars: r.vars } : {}) };
}
