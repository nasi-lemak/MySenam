import crypto from "crypto";
import { getDb, isUniqueViolation, withTransaction } from "./db";
import { offeredLocales, isLocale, translator, type Locale } from "./i18n";
import { agreeForContactInside, finishActivation, lockParticipant, notifyGuardianChange, type Activated, type Change } from "./guardian-requests";
import { enqueue } from "./outbox";
import {
  INVITE_DAYS,
  KNOWN_TO,
  NEEDS_REVIEW,
  OPEN_INVITE,
  REVIEW_DATE_DUE,
  guardianshipOf,
  iso,
  knownArgs,
  newInviteCode,
  participantAtVenue,
  participantEvent,
  refused,
  toParticipant,
  underLimit,
  type OpenInvite,
  type Participant,
  type ParticipantRefusal,
  type ParticipantRow,
} from "./participants";
import { MAX_TRIES, SENDS_PER_NUMBER_PER_DAY, phoneChecksOn, phoneMethods, phoneNumber, sendCodeToNumber } from "./phone-check";
import { keyedHash } from "./secrets";
import { siteName } from "./site";
import { todayISO } from "./time";
import { whatsappAvailable } from "./whatsapp-credit";

/**
 * Guardians a venue recorded by name and number only (ADR 0023, amended
 * 27 October 2026; docs/features/venue-operations.md#guardians-without-an-account).
 *
 * A family walks in; staff record the child with the parent's name, number
 * and declaration (lib/participants.ts createAtVenue). That parent has no
 * account, so they could not agree to another adult becoming a guardian,
 * were never told of a change, and had no way to take the relationship over
 * if they registered later. A name and a number grant nothing on their own:
 * a number proves, at most, that whoever holds the phone can read a message
 * sent to it. So each step here is done through the venue's staff, for a
 * participant that venue knows, and proved:
 *
 * - **A one-time code to the number recorded for them** (`sendContactCode`,
 *   `confirmContactCode`): six digits, ten minutes, five tries, through the
 *   install's existing phone-check delivery (lib/phone-check.ts: SMS, or
 *   WhatsApp's authentication template), and under its limits. The message
 *   carries the code and the venue's name, nothing about the child. Read
 *   back to staff, it is that guardian's agreement to a request
 *   (`staff_assisted_phone_code`, with the staff member who entered it), or
 *   their own withdrawal of their relationship, or just that the number
 *   reaches them. Either way the number is then known to reach them.
 * - **No phone messaging on this install**: a manager (never front desk)
 *   may record the guardian's agreement given in person, with a reason
 *   (`recordInPersonAgreement`): recorded as such, never as proof of
 *   authority, and the relationship it makes is flagged for review.
 * - **Registering later** (`issueClaimCode`, `claimRelationship`): the
 *   relationship takes on their account (the same row, its history kept;
 *   no new participant, no new relationship) only when the account has
 *   proved the number recorded for them (lib/phone-check.ts) and accepts a
 *   single-use code staff gave them in person, or one another guardian with
 *   an account gave. Either alone is not enough.
 * - **Told of changes** (`noticeContactGuardians`): only a number a code has
 *   come back from, and only on WhatsApp (the outbox has no SMS), with the
 *   venue's name and that a child's guardians changed; otherwise a task for
 *   the venue's staff to tell them, shown under *Needs attention*.
 * - **Reporting a mistake** (`reportForContact`): through staff, flagged for
 *   a manager like a report from a guardian with an account.
 */

export type ContactPurpose = "agree" | "withdraw" | "verify";
const PURPOSES: ContactPurpose[] = ["agree", "withdraw", "verify"];

/** Minutes a code stays good. */
export const CONTACT_CODE_MINUTES = 10;
/** Codes one relationship may be sent in an hour. */
export const CONTACT_CODES_PER_HOUR = 3;
/** Days a code's row (its hash, the number it went to, who sent it) is kept. */
export const CODES_KEPT_DAYS = 30;

export type StaffAt = { venueId: number; admin: { id: number | null; name: string } };

/** Can this install send a code to a number at all (SMS, WhatsApp, or the development log)? */
export function contactCodesAvailable(): boolean {
  return phoneMethods().code;
}

/**
 * Whether a guardian a venue recorded by name and number can take their
 * relationship over with an account here: that needs the account to prove the
 * recorded number, which only phone checks allow. Without them the claim code
 * is refused (and not offered), so nobody is sent round in a circle: staff
 * invite the guardian's account as another guardian instead.
 */
export function claimsPossible(): boolean {
  return phoneChecksOn();
}

export const claimNeedsPhoneChecks = (): ParticipantRefusal =>
  refused(
    "GW5_NO_PHONE_CHECKS",
    "This site cannot check phone numbers, so a guardian cannot take their relationship over with an account: invite their account as another guardian instead.",
    409
  );

const reasonOf = (v: unknown): string | null => {
  const r = typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, 300) : "";
  return r.length >= 5 ? r : null;
};

interface ContactRow {
  id: number;
  participant_id: number;
  user_id: number | null;
  contact_name: string;
  contact_phone: string;
  venue_id: number | null;
  suspended_at: unknown;
  revoked_at: unknown;
}

const notRecorded = () => refused("GW5_NOT_RECORDED_GUARDIAN", "No guardian recorded by name and number acts for them under that id.", 404);

/** A relationship a venue recorded by name and number (no account), still standing, of this participant. */
async function contactGuardian(participantId: number, guardianshipId: unknown, forUpdate = false): Promise<ContactRow | null> {
  const id = Number(guardianshipId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = (await getDb()
    .prepare(
      `SELECT id, participant_id, user_id, contact_name, contact_phone, venue_id, suspended_at, revoked_at FROM participant_guardians
        WHERE id = ? AND participant_id = ? AND user_id IS NULL AND revoked_at IS NULL${forUpdate ? " FOR UPDATE" : ""}`
    )
    .get(id, participantId)) as ContactRow | undefined;
  return row ?? null;
}

const venueName = async (venueId: number | null): Promise<string> =>
  venueId ? (((await getDb().prepare("SELECT name FROM venues WHERE id = ?").get(venueId)) as { name: string } | undefined)?.name ?? siteName()) : siteName();

const localeOf = (v: unknown): Locale => (typeof v === "string" && isLocale(v) && offeredLocales().includes(v) ? v : offeredLocales()[0]);

const PURPOSE_TEXT: Record<ContactPurpose, string> = {
  agree: "agree to a request to add a guardian",
  withdraw: "end their own relationship",
  verify: "check that the number reaches them",
};

// ------------------------------------------------------------------ a code to the number recorded

/**
 * Send a one-time code to the number recorded for a guardian without an
 * account, for staff to collect it back from them (in person, or as they
 * read it out on the phone). Front desk or a manager, for a participant
 * their venue knows. The message: the code and the venue's name, nothing
 * about the participant. Refused where nothing can send a code, over the
 * daily limits a customer's own codes are held to, or past three an hour
 * for one relationship.
 */
export async function sendContactCode(
  at: StaffAt,
  input: { participantId: unknown; guardianshipId: unknown; purpose: unknown; requestId?: unknown; locale?: unknown }
): Promise<{ ok: true; expiresAt: string; channel: "sms" | "whatsapp" | "log" } | ParticipantRefusal> {
  const purpose = input.purpose as ContactPurpose;
  if (!PURPOSES.includes(purpose)) return refused("GW5_PURPOSE", "A code to agree to a request, to end their own relationship, or to check their number.");
  const p = await participantAtVenue(at.venueId, input.participantId);
  if (!p) return refused("PTC_NOT_FOUND", "No such participant here.", 404);
  const g = await contactGuardian(p.id, input.guardianshipId);
  if (!g) return notRecorded();
  if (g.suspended_at && purpose !== "withdraw") return refused("GW5_GUARDIAN_PAUSED", "This guardian's relationship is paused while a manager looks at it.", 409);
  const db = getDb();
  let requestId: number | null = null;
  if (purpose === "agree") {
    const r = (await db
      .prepare("SELECT id, participant_id, status, initiated_as, consented_at FROM guardian_requests WHERE id = ?")
      .get(Number(input.requestId) || 0)) as { id: number; participant_id: number; status: string; initiated_as: string; consented_at: unknown } | undefined;
    if (!r || r.participant_id !== p.id) return refused("GV_REQUEST_NOT_FOUND", "No such request.", 404);
    if (r.status !== "invited" && r.status !== "awaiting_consent") return refused("GV_REQUEST_CLOSED", "This request is no longer waiting for an answer.", 409);
    if (r.initiated_as !== "staff" || r.consented_at) return refused("GW5_ALREADY_AGREED", "A guardian has already agreed to this request.", 409);
    requestId = r.id;
  }
  const number = phoneNumber(g.contact_phone);
  if (!number) return refused("GW5_BAD_NUMBER", "The number recorded for them is not one a code can be sent to.", 409);
  if (!contactCodesAvailable()) return refused("GW5_NO_PHONE_CODES", "No SMS or WhatsApp is set up here to send a code with.", 409);
  // Codes are kept no longer than their limits and the counter's questions need: what each did is in the participant's history.
  await db.prepare(`DELETE FROM guardian_contact_codes WHERE created_at < now() - interval '${CODES_KEPT_DAYS} days'`).run();
  const { hour } = (await db
    .prepare("SELECT COUNT(*)::int AS hour FROM guardian_contact_codes WHERE guardianship_id = ? AND created_at > now() - interval '1 hour'")
    .get(g.id)) as { hour: number };
  if (hour >= CONTACT_CODES_PER_HOUR) return refused("PHONE_CODE_LIMIT", "That is a few codes already. Try again in an hour.", 429);
  const { day } = (await db
    .prepare(
      `SELECT ((SELECT COUNT(*) FROM guardian_contact_codes WHERE number = ? AND created_at > now() - interval '1 day')
             + (SELECT COUNT(*) FROM phone_codes WHERE number = ? AND created_at > datetime('now', '-1 day')))::int AS day`
    )
    .get(number, number)) as { day: number };
  if (day >= SENDS_PER_NUMBER_PER_DAY) return refused("PHONE_CODE_LIMIT", "That number has been sent enough codes for today. Try again tomorrow.", 429);
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const locale = localeOf(input.locale);
  // Sent before anything is written: a message that never left leaves nothing to enter.
  const sent = await sendCodeToNumber(number, code, translator(locale)("gw5.sms.code", { venue: await venueName(at.venueId), code }), locale);
  if (!sent.ok) return refused(sent.code, sent.error, sent.code === "PHONE_CODES_PAUSED" ? 429 : 503);
  return withTransaction(async () => {
    await db
      .prepare("UPDATE guardian_contact_codes SET cancelled_at = now() WHERE guardianship_id = ? AND purpose = ? AND used_at IS NULL AND cancelled_at IS NULL")
      .run(g.id, purpose);
    const row = (await db
      .prepare(
        `INSERT INTO guardian_contact_codes (guardianship_id, participant_id, purpose, request_id, venue_id, number, code_hash, channel, sent_by_admin_id, sent_by_name, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now() + interval '${CONTACT_CODE_MINUTES} minutes') RETURNING expires_at`
      )
      .get(g.id, p.id, purpose, requestId, at.venueId, number, codeHash(g.id, purpose, number, code), sent.channel, at.admin.id, at.admin.name)) as { expires_at: unknown };
    await participantEvent(p.id, "guardian.code_sent", { adminId: at.admin.id, name: at.admin.name }, {
      venueId: at.venueId,
      detail: `a code to the number recorded for ${g.contact_name}, to ${PURPOSE_TEXT[purpose]}; it carries the code and the venue's name, nothing about them`,
    });
    return { ok: true as const, expiresAt: iso(row.expires_at) ?? "", channel: sent.channel };
  });
}

const codeHash = (guardianshipId: number, purpose: ContactPurpose, number: string, code: string) =>
  keyedHash("guardian-contact-code", `${guardianshipId}:${purpose}:${number}:${code}`);

/** Thrown to undo a transaction that found, part way, that it must be refused. */
class Undone extends Error {
  constructor(readonly refusal: ParticipantRefusal) {
    super(refusal.error);
  }
}

/**
 * Staff enter the code the guardian read back. Wrong (five tries), run out,
 * already used or replaced: refused, nothing done. Right: the number is
 * known to reach them, and the purpose is done in the same transaction:
 * their agreement to the request (the relationship is made now if the adult
 * has accepted, the other guardians told), their own relationship ended
 * (the other guardians told), or nothing more.
 */
export async function confirmContactCode(
  at: StaffAt,
  input: { participantId: unknown; guardianshipId: unknown; purpose: unknown; code: unknown; requestId?: unknown }
): Promise<{ ok: true; purpose: ContactPurpose; active?: boolean } | ParticipantRefusal> {
  const purpose = input.purpose as ContactPurpose;
  if (!PURPOSES.includes(purpose)) return refused("GW5_PURPOSE", "A code to agree to a request, to end their own relationship, or to check their number.");
  const given = typeof input.code === "string" ? input.code.replace(/\D/g, "") : "";
  const db = getDb();
  type Done = { ok: true; participantId: number; guardian: ContactRow; activated: Activated | null; ended: boolean };
  const done = await withTransaction(async (): Promise<Done | ParticipantRefusal> => {
    const p = await participantAtVenue(at.venueId, input.participantId);
    if (!p) return refused("PTC_NOT_FOUND", "No such participant here.", 404);
    // A paused guardian agrees to nothing; their code is kept for when they are not.
    if (purpose === "agree" && (await contactGuardian(p.id, input.guardianshipId))?.suspended_at)
      return refused("GW5_GUARDIAN_PAUSED", "This guardian's relationship is paused while a manager looks at it.", 409);
    const c = (await db
      .prepare(
        `SELECT id, guardianship_id, request_id, number, code_hash, attempts, expires_at > now() AS live FROM guardian_contact_codes
          WHERE guardianship_id = ? AND participant_id = ? AND purpose = ? AND used_at IS NULL AND cancelled_at IS NULL
          ORDER BY id DESC LIMIT 1 FOR UPDATE`
      )
      .get(Number(input.guardianshipId) || 0, p.id, purpose)) as
      | { id: number; guardianship_id: number; request_id: number | null; number: string; code_hash: string; attempts: number; live: boolean }
      | undefined;
    if (!c || !c.live) return refused("GW5_CODE_EXPIRED", "That code has run out, or was used already. Send a new one.", 409);
    if (purpose === "agree" && c.request_id !== Number(input.requestId)) return refused("GV_REQUEST_NOT_FOUND", "No such request.", 404);
    if (c.attempts >= MAX_TRIES) return refused("GW5_CODE_EXPIRED", "That code has run out, or was used already. Send a new one.", 409);
    const expected = Buffer.from(c.code_hash, "hex");
    const actual = Buffer.from(codeHash(c.guardianship_id, purpose, c.number, given), "hex");
    if (given.length !== 6 || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      await db.prepare("UPDATE guardian_contact_codes SET attempts = attempts + 1 WHERE id = ?").run(c.id);
      return refused("GW5_CODE_WRONG", "That is not the code. Check it and try again.", 409);
    }
    await db.prepare("UPDATE guardian_contact_codes SET used_at = now(), used_by_admin_id = ?, used_by_name = ? WHERE id = ?").run(at.admin.id, at.admin.name, c.id);
    const g = await contactGuardian(p.id, c.guardianship_id, true);
    if (!g) throw new Undone(notRecorded());
    // The number reaches them: a message came back from it (only while it is still the number recorded).
    if (phoneNumber(g.contact_phone) === c.number)
      await db.prepare("UPDATE participant_guardians SET contact_verified_at = now(), contact_verified_number = ? WHERE id = ?").run(c.number, g.id);
    if (purpose === "agree") {
      if (g.suspended_at) throw new Undone(refused("GW5_GUARDIAN_PAUSED", "This guardian's relationship is paused while a manager looks at it.", 409));
      const agreed = await agreeForContactInside({
        requestId: c.request_id,
        participantId: p.id,
        guardian: { id: g.id, name: g.contact_name },
        staff: at.admin,
        venueId: at.venueId,
        method: "staff_assisted_phone_code",
      });
      // The request closed or was agreed to meanwhile: nothing is kept, the code included.
      if (!agreed.ok) throw new Undone(agreed);
      return { ok: true as const, participantId: p.id, guardian: g, activated: agreed.activated, ended: false };
    }
    if (purpose === "withdraw") {
      await endInside(g, at, `Ended by ${g.contact_name} at the counter, by a code sent to their number, entered by ${at.admin.name}`);
      return { ok: true as const, participantId: p.id, guardian: g, activated: null, ended: true };
    }
    await participantEvent(p.id, "guardian.contact_verified", { adminId: at.admin.id, name: at.admin.name }, {
      venueId: at.venueId,
      detail: `a code sent to the number recorded for ${g.contact_name} came back`,
    });
    return { ok: true as const, participantId: p.id, guardian: g, activated: null, ended: false };
  }).catch((err: unknown) => {
    if (err instanceof Undone) return err.refusal;
    throw err;
  });
  if (!done.ok) return done;
  if (done.activated) await finishActivation(done.activated, done.guardian.id);
  if (done.ended) await notifyGuardianChange(done.participantId, "ended", { exceptUserIds: [], venueId: at.venueId, about: done.guardian.id });
  return { ok: true, purpose, ...(purpose === "agree" ? { active: done.activated !== null } : {}) };
}

/** A relationship recorded by name and number ended by that guardian themself, through staff: for good, history kept. */
async function endInside(g: ContactRow, at: StaffAt, why: string): Promise<void> {
  const db = getDb();
  await db
    .prepare(
      `UPDATE participant_guardians SET revoked_at = now(), revoked_by_admin_id = ?, revoked_by_name = ?, revoke_reason = ?,
         reviewed_at = CASE WHEN review_reason IS NOT NULL AND reviewed_at IS NULL THEN now() ELSE reviewed_at END,
         reviewed_by_name = CASE WHEN review_reason IS NOT NULL AND reviewed_at IS NULL THEN ? ELSE reviewed_by_name END,
         review_outcome = CASE WHEN review_reason IS NOT NULL AND reviewed_at IS NULL THEN 'ended by the guardian' ELSE review_outcome END
       WHERE id = ?`
    )
    .run(at.admin.id, g.contact_name, why.slice(0, 300), at.admin.name, g.id);
  await db.prepare("UPDATE participant_invites SET cancelled_at = now() WHERE guardianship_id = ? AND used_at IS NULL AND cancelled_at IS NULL").run(g.id);
  await db.prepare("UPDATE guardian_contact_codes SET cancelled_at = now() WHERE guardianship_id = ? AND used_at IS NULL AND cancelled_at IS NULL").run(g.id);
  await participantEvent(g.participant_id, "guardian.ended", { adminId: at.admin.id, name: at.admin.name }, { venueId: at.venueId, detail: why });
}

/**
 * Where no code can be sent from this install, a manager records the
 * agreement a guardian recorded by name and number gave in person to a
 * request, with a reason. Recorded as an in-person agreement, never as proof
 * of authority; the relationship it makes is flagged for a manager's review.
 * Refused where a code can be sent: then the code is the way.
 */
export async function recordInPersonAgreement(
  at: StaffAt,
  input: { participantId: unknown; guardianshipId: unknown; requestId: unknown; reason: unknown }
): Promise<{ ok: true; active: boolean } | ParticipantRefusal> {
  if (contactCodesAvailable()) return refused("GW5_USE_PHONE_CODE", "A code can be sent to their number from here: use that instead.", 409);
  const why = reasonOf(input.reason);
  if (!why) return refused("PTC_REASON_NEEDED", "Say why, in a few words.");
  const done = await withTransaction(async (): Promise<{ ok: true; activated: Activated | null; guardianId: number } | ParticipantRefusal> => {
    const p = await participantAtVenue(at.venueId, input.participantId);
    if (!p) return refused("PTC_NOT_FOUND", "No such participant here.", 404);
    const g = await contactGuardian(p.id, input.guardianshipId, true);
    if (!g) return notRecorded();
    if (g.suspended_at) return refused("GW5_GUARDIAN_PAUSED", "This guardian's relationship is paused while a manager looks at it.", 409);
    const agreed = await agreeForContactInside({
      requestId: input.requestId,
      participantId: p.id,
      guardian: { id: g.id, name: g.contact_name },
      staff: at.admin,
      venueId: at.venueId,
      method: "staff_in_person",
      reason: why,
    });
    if (!agreed.ok) return agreed;
    return { ok: true as const, activated: agreed.activated, guardianId: g.id };
  });
  if (!done.ok) return done;
  if (done.activated) await finishActivation(done.activated, done.guardianId);
  return { ok: true, active: done.activated !== null };
}

// ------------------------------------------------------------------ registering later

/**
 * A single-use code, shown once to staff to hand over in person, for a
 * guardian recorded by name and number to take their relationship over with
 * their own account (`claimRelationship`). Front desk or a manager, for a
 * participant their venue knows. A week; only its hash is kept; a new one
 * replaces an earlier unused one for the same relationship.
 */
export async function issueClaimCode(
  at: StaffAt,
  input: { participantId: unknown; guardianshipId: unknown }
): Promise<{ ok: true; code: string; expiresAt: string } | ParticipantRefusal> {
  if (!claimsPossible()) return claimNeedsPhoneChecks();
  const { shown, hash } = newInviteCode();
  return withTransaction(async () => {
    const p = await participantAtVenue(at.venueId, input.participantId);
    if (!p) return refused("PTC_NOT_FOUND", "No such participant here.", 404);
    const g = await contactGuardian(p.id, input.guardianshipId, true);
    if (!g) return notRecorded();
    if (g.suspended_at) return refused("GW5_GUARDIAN_PAUSED", "This guardian's relationship is paused while a manager looks at it.", 409);
    const db = getDb();
    await db.prepare("UPDATE participant_invites SET cancelled_at = now() WHERE guardianship_id = ? AND purpose = 'claim' AND used_at IS NULL AND cancelled_at IS NULL").run(g.id);
    const row = (await db
      .prepare(
        `INSERT INTO participant_invites (participant_id, purpose, code_hash, created_by_admin_id, created_by_name, guardianship_id, expires_at)
         VALUES (?, 'claim', ?, ?, ?, ?, now() + interval '${INVITE_DAYS} days') RETURNING expires_at`
      )
      .get(p.id, hash, at.admin.id, at.admin.name, g.id)) as { expires_at: unknown };
    await participantEvent(p.id, "invite.claim", { adminId: at.admin.id, name: at.admin.name }, {
      venueId: at.venueId,
      detail: `a code for ${g.contact_name} to take their relationship over with their own account, given in person; it also needs the number recorded for them proved on that account`,
    });
    return { ok: true as const, code: shown, expiresAt: iso(row.expires_at) ?? "" };
  });
}

/**
 * A guardian recorded by name and number, now registered, takes their
 * relationship over (lib/participants.ts acceptInvite sends a `claim` code
 * here), signed in, declaring their authority again. Both are needed: the
 * account has proved the number recorded for them (lib/phone-check.ts), and
 * the code came from staff (for that relationship) or from another guardian
 * still acting for the participant. The same relationship row takes on the
 * account, the name and number staff recorded kept as how it began; no new
 * participant and no new relationship. The other guardians are told.
 */
export async function claimRelationship(
  user: { id: number; name?: string | null },
  codeHash: string,
  input: Record<string, unknown>
): Promise<{ ok: true; participant: Participant; as: "claimed" } | ParticipantRefusal> {
  const invalid = () => refused("PTC_INVITE_INVALID", "That code is not one we know, or it has run out.", 404);
  if (input.authority !== true) return refused("GUARD_AUTHORITY_NEEDED", "Confirm that you are their parent, legal guardian or another person with authority to act for them.");
  const db = getDb();
  type Done = { ok: true; participantId: number; guardianshipId: number; venueId: number | null };
  let done: Done | ParticipantRefusal;
  try {
    done = await withTransaction(async (): Promise<Done | ParticipantRefusal> => {
      const inv = (await db.prepare(`${OPEN_INVITE} FOR UPDATE OF i`).get(codeHash)) as OpenInvite | undefined;
      if (!inv || inv.purpose !== "claim") return invalid();
      // Who gave it must still be able to: another guardian acting for them now, or staff for one relationship.
      if (inv.created_by_user_id !== null ? !(await guardianshipOf(inv.created_by_user_id, inv.participant_id, { live: true })) : inv.guardianship_id === null)
        return invalid();
      const p = await lockParticipant(inv.participant_id);
      if (!p) return invalid();
      const account = (await db.prepare("SELECT phone, verified_phone FROM users WHERE id = ?").get(user.id)) as { phone: string | null; verified_phone: string | null } | undefined;
      const proved = account?.verified_phone && account.phone ? (phoneNumber(account.phone) === account.verified_phone ? account.verified_phone : null) : null;
      if (!proved) return refused("GW5_PHONE_UNPROVEN", "Prove the phone number on your account first (on your account page), then enter the code again.", 409);
      const rows = (await db
        .prepare(
          `SELECT id, participant_id, user_id, contact_name, contact_phone, venue_id, suspended_at, revoked_at FROM participant_guardians
            WHERE participant_id = ? AND user_id IS NULL AND revoked_at IS NULL AND suspended_at IS NULL
            ORDER BY id FOR UPDATE`
        )
        .all(p.id)) as ContactRow[];
      const candidates = inv.guardianship_id !== null ? rows.filter((r) => r.id === inv.guardianship_id) : rows;
      // Staff's code for a relationship that has since ended, been paused or taken over: void.
      if (inv.guardianship_id !== null && candidates.length === 0) return invalid();
      const theirs = candidates.filter((r) => phoneNumber(r.contact_phone) === proved);
      if (theirs.length !== 1)
        return refused("GW5_NOT_THEIR_NUMBER", "The number proved on your account is not the one recorded for this guardian. Ask the venue.", 409);
      const g = theirs[0];
      if (p.linked_user_id === user.id) return refused("PTC_LINK_SELF", "This is their own login: it cannot be their guardian too.", 409);
      if (await db.prepare("SELECT 1 FROM participant_guardians WHERE participant_id = ? AND user_id = ? AND revoked_at IS NULL").get(p.id, user.id))
        return refused("PTC_ALREADY_GUARDIAN", "You already manage them.", 409);
      const limit = await underLimit(user.id);
      if (limit) return limit;
      await db
        .prepare(
          `UPDATE participant_guardians SET user_id = ?, claimed_at = now(), claim_method = ?, claim_code_by_name = ?, contact_verified_at = COALESCE(contact_verified_at, now()),
             contact_verified_number = COALESCE(contact_verified_number, ?) WHERE id = ? AND user_id IS NULL`
        )
        .run(user.id, inv.created_by_user_id !== null ? "guardian_code" : "staff_code", inv.by_name, proved, g.id);
      await db.prepare("UPDATE participant_invites SET used_at = now(), used_by_user_id = ? WHERE id = ?").run(user.id, inv.id);
      await db.prepare("UPDATE participant_invites SET cancelled_at = now() WHERE guardianship_id = ? AND used_at IS NULL AND cancelled_at IS NULL").run(g.id);
      await db.prepare("UPDATE guardian_contact_codes SET cancelled_at = now() WHERE guardianship_id = ? AND used_at IS NULL AND cancelled_at IS NULL").run(g.id);
      // Tasks to tell them in person lapse: they are told by email from now on.
      await db
        .prepare("UPDATE guardian_notice_tasks SET done_at = now(), done_by_name = 'MySenam', done_how = 'not_needed' WHERE guardianship_id = ? AND done_at IS NULL")
        .run(g.id);
      // A request of their own for the same participant, still waiting, is overtaken.
      await db
        .prepare(
          `UPDATE guardian_requests SET status = 'cancelled', closed_at = now(), closed_by_name = 'MySenam', close_reason = 'They took over the relationship recorded for them'
            WHERE participant_id = ? AND accepted_by_user_id = ? AND status = 'awaiting_consent'`
        )
        .run(p.id, user.id);
      await participantEvent(p.id, "guardian.claimed", { userId: user.id, name: user.name }, {
        venueId: g.venue_id,
        detail: `${g.contact_name} (recorded by name and number) took their relationship over with their own account (${user.name ?? "an account"}), signed in, having proved the number recorded for them, with a code ${inv.by_name} gave`,
      });
      return { ok: true as const, participantId: p.id, guardianshipId: g.id, venueId: g.venue_id };
    });
  } catch (err) {
    if (isUniqueViolation(err, "participant_guardians")) return refused("PTC_ALREADY_GUARDIAN", "You already manage them.", 409);
    throw err;
  }
  if (!done.ok) return done;
  await notifyGuardianChange(done.participantId, "claimed", { exceptUserIds: [user.id], venueId: done.venueId, about: done.guardianshipId });
  const row = (await db.prepare("SELECT * FROM participants WHERE id = ?").get(done.participantId)) as ParticipantRow;
  return { ok: true, participant: toParticipant(row), as: "claimed" };
}

// ------------------------------------------------------------------ reporting through staff

/**
 * A guardian recorded by name and number reports another guardian's
 * relationship to the participant as a mistake, through staff (front desk or
 * a manager): flagged for a manager's review with their note, as a report
 * from a guardian with an account is (lib/guardian-requests.ts reportMistake).
 * Nothing else changes until a manager decides.
 */
export async function reportForContact(
  at: StaffAt,
  input: { participantId: unknown; reporterId: unknown; guardianshipId: unknown; note?: unknown }
): Promise<{ ok: true } | ParticipantRefusal> {
  const text = typeof input.note === "string" ? input.note.trim().replace(/\s+/g, " ").slice(0, 500) : "";
  const db = getDb();
  return withTransaction(async () => {
    const p = await participantAtVenue(at.venueId, input.participantId);
    if (!p) return refused("PTC_NOT_FOUND", "No such participant here.", 404);
    const reporter = await contactGuardian(p.id, input.reporterId);
    if (!reporter || reporter.suspended_at) return notRecorded();
    const gid = Number(input.guardianshipId);
    const g = (await db
      .prepare("SELECT id, venue_id FROM participant_guardians WHERE id = ? AND participant_id = ? AND revoked_at IS NULL FOR UPDATE")
      .get(Number.isInteger(gid) && gid > 0 ? gid : 0, p.id)) as { id: number; venue_id: number | null } | undefined;
    if (!g || g.id === reporter.id) return refused("GV_CHANGE_NOT_FOUND", "No such change to report.", 404);
    await db
      .prepare(
        `UPDATE participant_guardians SET review_reason = 'reported', review_flagged_at = now(), review_note = ?,
           reviewed_at = NULL, reviewed_by_name = NULL, review_outcome = NULL WHERE id = ?`
      )
      .run(`Reported as a mistake by ${reporter.contact_name} (recorded by name and number), told to ${at.admin.name}${text ? `: ${text}` : ""}`.slice(0, 600), g.id);
    await participantEvent(p.id, "guardian.reported", { adminId: at.admin.id, name: at.admin.name }, {
      venueId: at.venueId,
      detail: `for ${reporter.contact_name} (recorded by name and number)${text ? `: ${text}` : ""}`,
    });
    return { ok: true as const };
  });
}

// ------------------------------------------------------------------ telling them

/**
 * Tell a participant's guardians recorded by name and number (acting for
 * them now, not paused; not those in `exceptGuardianshipIds`) that who acts
 * for them changed (lib/guardian-requests.ts notifyGuardianChange calls
 * this). Only a number a code has come back from (`contact_verified_at`,
 * still the number recorded) is sent anything, and only on WhatsApp, the
 * outbox's channel for numbers: the venue's name and that a child's
 * guardians changed, to ask at the counter or sign in. Never the child's
 * name or anything else about them. Every other is a task for the venue that
 * recorded them: tell them in person or by phone, and mark it done. Returns
 * how many messages were queued.
 */
export async function noticeContactGuardians(
  participantId: number,
  change: Change,
  opts: { venueId: number | null; about?: number; exceptGuardianshipIds: number[] }
): Promise<number> {
  const db = getDb();
  const rows = (await db
    .prepare(
      `SELECT g.id, g.contact_phone, g.contact_verified_at IS NOT NULL AS verified, g.contact_verified_number, g.venue_id
         FROM participant_guardians g
        WHERE g.participant_id = ? AND g.user_id IS NULL AND g.revoked_at IS NULL AND g.suspended_at IS NULL ORDER BY g.id`
    )
    .all(participantId)) as { id: number; contact_phone: string; verified: boolean; contact_verified_number: string | null; venue_id: number | null }[];
  const to = rows.filter((r) => !opts.exceptGuardianshipIds.includes(r.id));
  if (to.length === 0) return 0;
  const sent: number[] = [];
  let tasks = 0;
  const channel = whatsappAvailable();
  for (const g of to) {
    const reaches = g.verified && g.contact_verified_number !== null && phoneNumber(g.contact_phone) === g.contact_verified_number;
    const venueId = g.venue_id ?? opts.venueId;
    if (reaches && channel) {
      const locale = offeredLocales()[0];
      const m = await enqueue({
        venueId,
        kind: "guardian_notice",
        channel: "whatsapp",
        recipient: g.contact_phone,
        locale,
        body: "gw5.msg.notice",
        vars: { venue: await venueName(venueId) },
        dedupeKey: opts.about !== undefined ? `guardian-notice-${change}:${participantId}:${opts.about}:${g.id}` : undefined,
      });
      // Whom it was for and about what: should it not arrive, that guardian becomes the venue's task (taskUndeliveredNotices).
      await db
        .prepare(
          `INSERT INTO guardian_notice_messages (message_id, participant_id, guardianship_id, venue_id, change, about) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`
        )
        .run(m.id, participantId, g.id, venueId, change, opts.about ?? null);
      sent.push(m.id);
    } else {
      const made = await db
        .prepare(
          `INSERT INTO guardian_notice_tasks (participant_id, guardianship_id, venue_id, change, why, about) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`
        )
        .run(participantId, g.id, venueId, change, reaches ? "no_channel" : "unverified_number", opts.about ?? null);
      tasks += made.changes;
    }
  }
  await participantEvent(participantId, "guardian.notified_contact", { system: true }, {
    venueId: opts.venueId,
    detail: `${change}: ${sent.length} guardian(s) recorded by name and number told on WhatsApp${sent.length ? ` (messages ${sent.join(", ")})` : ""}; ${tasks} left for the venue's staff to tell`,
  });
  // One given up at once (over the day's limit for that number) is the venue's task now, not at the next look.
  if (sent.length > 0) await taskUndeliveredNotices();
  return sent.length;
}

/**
 * Notices that did not reach the guardian: given up by the outbox (out of
 * tries, out of the venue's WhatsApp credit, over the day's limit for the
 * number, run out) or reported undelivered by WhatsApp afterwards. Each
 * becomes the task staff get when nothing could be sent (why
 * `not_delivered`), for the venue that recorded the guardian: tell them, and
 * mark it done. Once per message, however often this runs (lib/notify.ts
 * tickOutbox calls it after each drain); a task already open or done for the
 * same guardian and change is left as it is. Returns how many tasks it made.
 */
export async function taskUndeliveredNotices(): Promise<number> {
  return withTransaction(async () => {
    const db = getDb();
    const rows = (await db
      .prepare(
        `SELECT gm.message_id, gm.participant_id, gm.guardianship_id, gm.venue_id, gm.change, gm.about
           FROM guardian_notice_messages gm JOIN messages m ON m.id = gm.message_id
          WHERE gm.tasked_at IS NULL AND (m.status = 'abandoned' OR m.delivery_error IS NOT NULL)
          ORDER BY gm.message_id LIMIT 100
          FOR UPDATE OF gm SKIP LOCKED`
      )
      .all()) as { message_id: number; participant_id: number; guardianship_id: number; venue_id: number | null; change: Change; about: number | null }[];
    let made = 0;
    for (const r of rows) {
      const task = await db
        .prepare(
          `INSERT INTO guardian_notice_tasks (participant_id, guardianship_id, venue_id, change, why, about, message_id)
           SELECT ?, ?, ?, ?, 'not_delivered', ?, ? WHERE EXISTS (SELECT 1 FROM participant_guardians g WHERE g.id = ? AND g.revoked_at IS NULL)
           ON CONFLICT DO NOTHING`
        )
        .run(r.participant_id, r.guardianship_id, r.venue_id, r.change, r.about, r.message_id, r.guardianship_id);
      await db.prepare("UPDATE guardian_notice_messages SET tasked_at = now() WHERE message_id = ?").run(r.message_id);
      if (task.changes === 0) continue;
      made++;
      await participantEvent(r.participant_id, "guardian.notice_undelivered", { system: true }, {
        venueId: r.venue_id,
        detail: `${r.change}: the WhatsApp notice to a guardian recorded by name and number (message ${r.message_id}) did not reach them; left for the venue's staff to tell`,
      });
    }
    return made;
  });
}

export interface NoticeTask {
  id: number;
  participantId: number;
  displayName: string;
  /** The guardian to tell, as staff recorded them, and their number. */
  guardianName: string;
  phone: string;
  venueId: number | null;
  venueName: string | null;
  change: Change;
  why: "unverified_number" | "no_channel" | "not_delivered";
  createdAt: string;
}

/** Tasks still open to tell a guardian recorded by name and number, for the venues given (null: every venue, the platform owner). */
export async function openNoticeTasks(venueIds: number[] | null, participantIds?: number[]): Promise<NoticeTask[]> {
  if (venueIds !== null && venueIds.length === 0) return [];
  const where: string[] = ["t.done_at IS NULL"];
  const args: unknown[] = [];
  if (venueIds !== null) {
    where.push(`t.venue_id IN (${venueIds.map(() => "?").join(",")})`);
    args.push(...venueIds);
  }
  if (participantIds) {
    if (participantIds.length === 0) return [];
    where.push(`t.participant_id IN (${participantIds.map(() => "?").join(",")})`);
    args.push(...participantIds);
  }
  const rows = (await getDb()
    .prepare(
      `SELECT t.id, t.participant_id, p.display_name, g.contact_name, g.contact_phone, t.venue_id, v.name AS venue_name, t.change, t.why, t.created_at
         FROM guardian_notice_tasks t JOIN participants p ON p.id = t.participant_id JOIN participant_guardians g ON g.id = t.guardianship_id
         LEFT JOIN venues v ON v.id = t.venue_id
        WHERE ${where.join(" AND ")} ORDER BY t.id LIMIT 100`
    )
    .all(...args)) as {
    id: number;
    participant_id: number;
    display_name: string;
    contact_name: string;
    contact_phone: string;
    venue_id: number | null;
    venue_name: string | null;
    change: Change;
    why: NoticeTask["why"];
    created_at: unknown;
  }[];
  return rows.map((r) => ({
    id: r.id,
    participantId: r.participant_id,
    displayName: r.display_name,
    guardianName: r.contact_name,
    phone: r.contact_phone,
    venueId: r.venue_id,
    venueName: r.venue_name,
    change: r.change,
    why: r.why,
    createdAt: iso(r.created_at) ?? "",
  }));
}

/** Staff told them (or it is no longer needed), with who: the task closed. Only a task of a venue they work at (null: the platform owner). */
export async function closeNoticeTask(
  venueIds: number[] | null,
  admin: { id: number | null; name: string },
  taskId: unknown,
  how: unknown
): Promise<{ ok: true; venueId: number | null } | ParticipantRefusal> {
  const id = Number(taskId);
  if (how !== "told" && how !== "not_needed") return refused("GW5_TOLD_HOW", "Say whether you told them, or it is no longer needed.");
  return withTransaction(async () => {
    const db = getDb();
    const t = (await db
      .prepare("SELECT id, participant_id, venue_id, change FROM guardian_notice_tasks WHERE id = ? AND done_at IS NULL FOR UPDATE")
      .get(Number.isInteger(id) && id > 0 ? id : 0)) as { id: number; participant_id: number; venue_id: number | null; change: string } | undefined;
    if (!t || (venueIds !== null && (t.venue_id === null || !venueIds.includes(t.venue_id)))) return refused("GW5_TASK_NOT_FOUND", "No such task.", 404);
    await db.prepare("UPDATE guardian_notice_tasks SET done_at = now(), done_by_admin_id = ?, done_by_name = ?, done_how = ? WHERE id = ?").run(admin.id, admin.name, how, t.id);
    await participantEvent(t.participant_id, "guardian.contact_told", { adminId: admin.id, name: admin.name }, {
      venueId: t.venue_id,
      detail: `${t.change}: ${how === "told" ? "a guardian recorded by name and number told by staff" : "no longer needed"}`,
    });
    return { ok: true as const, venueId: t.venue_id };
  });
}

// ------------------------------------------------------------------ a manager's reminders

export interface GuardianReviews {
  venueId: number | null;
  venueName: string;
  /** Participants with a relationship flagged, paused, or whose exception's review date has come. */
  waiting: number;
  /** Of those relationships: an exception's date to look at it again has come. */
  datesDue: number;
}

/**
 * What a venue's managers are reminded of each day under *Needs attention*:
 * how many participants the venue knows have a relationship waiting for a
 * review (flagged, paused, or an exception's review date come), and how
 * many exception review dates have come. The platform owner (null) sees it
 * across every participant, a family's own records included.
 */
export async function guardianReviews(venueIds: number[] | null): Promise<GuardianReviews[]> {
  const db = getDb();
  const today = todayISO();
  const count = async (venueId: number | null) => {
    const known = venueId !== null ? ` AND ${KNOWN_TO}` : "";
    const args = venueId !== null ? knownArgs(venueId) : [];
    const { waiting } = (await db
      .prepare(
        `SELECT COUNT(DISTINCT p.id)::int AS waiting FROM participants p JOIN participant_guardians g ON g.participant_id = p.id AND g.revoked_at IS NULL
          WHERE ${NEEDS_REVIEW}${known}`
      )
      .get(today, ...args)) as { waiting: number };
    const { due } = (await db
      .prepare(
        `SELECT COUNT(*)::int AS due FROM participants p JOIN participant_guardians g ON g.participant_id = p.id AND g.revoked_at IS NULL
          WHERE ${REVIEW_DATE_DUE}${known}`
      )
      .get(today, ...args)) as { due: number };
    return { waiting, datesDue: due };
  };
  if (venueIds === null) {
    const c = await count(null);
    return c.waiting > 0 ? [{ venueId: null, venueName: siteName(), ...c }] : [];
  }
  const out: GuardianReviews[] = [];
  for (const venueId of venueIds) {
    const c = await count(venueId);
    if (c.waiting > 0) out.push({ venueId, venueName: await venueName(venueId), ...c });
  }
  return out;
}
