import crypto from "crypto";
import { getDb } from "./db";
import { hashPassword } from "./auth";
import { createVenue } from "./store";
import { sendPlainEmail } from "./transports";
import { baseUrl } from "./outbox";
import { siteName } from "./site";
import { startBilling } from "./billing";
import { tellOwners } from "./owner-alerts";
import { RETENTION } from "./privacy";
import { REVIEW_CHECKS } from "./review-checks";
import type { Admin } from "./admin-auth";
import { areaMatches, distanceM, findAddress, formatDistance, geocoderOn, inMalaysia, placeAt, readPoint, type Point } from "./geo";

/**
 * Venues asking to join the marketplace.
 *
 * Anybody can apply; nobody is in until the platform owner says so. An
 * application holds everything needed to set the venue up — its details and
 * the password its first operator chose, already hashed — so approving it is
 * one click that makes the venue and the account together, and nobody has to
 * send a password to anybody.
 *
 * Before that click, three kinds of evidence that the venue is real:
 *
 *   - Where it is. The applicant drops a pin on a map. Their address is looked
 *     up (lib/geo.ts) and set beside the pin, along with what the map calls
 *     the place at the pin and any venue already listed right there.
 *   - That they can be reached. Nothing reaches the platform owner until the
 *     applicant has followed a link emailed to the address they gave.
 *   - What the platform owner checked. Approving asks them to tick that they
 *     looked at the map, phoned the venue, and found the business somewhere
 *     besides this form — and records that they did.
 */

export type ApplicationStatus = "pending" | "approved" | "rejected";

/** See db/migrations/0007_application_checks.sql. */
export type EmailCheck = "waiting" | "confirmed" | "unsent" | "account" | "not asked";

export { REVIEW_CHECKS, type ReviewCheck } from "./review-checks";

/** A pin further than this from where its address leads is worth a look. */
export const FAR_FROM_ADDRESS_M = 1000;
/** Another business's venue this close to a pin may be the same building. */
export const SAME_SPOT_M = 150;

/** Where an application says it is, and what doesn't add up. */
export interface LocationReport {
  /** Pin to where the address leads, in metres; null if either is missing. */
  distanceM: number | null;
  /** Venues of other businesses already listed near the pin. */
  nearby: { id: number; name: string; distanceM: number }[];
  /** Everything worth a second look, in words. Empty: nothing found wrong. */
  warnings: string[];
}

export interface VenueApplication {
  id: number;
  businessName: string;
  area: string;
  address: string;
  venuePhone: string;
  contactName: string;
  email: string;
  message: string | null;
  status: ApplicationStatus;
  reason: string | null;
  venueId: number | null;
  createdAt: string;
  decidedAt: string | null;
  /** A new branch for this business already on the platform; null for a new venue. */
  businessId: number | null;
  forBusiness: string | null;
  /** The pin the applicant dropped; null for applications from before pins. */
  pin: Point | null;
  /** Where the address they typed leads, if it could be found. */
  found: Point | null;
  /** What the map calls the place at the pin. */
  pinPlace: string | null;
  emailCheck: EmailCheck;
  /** What was ticked when it was approved; ["auto"] for a branch approved on its own. */
  reviewChecks: string[];
  /** For one still waiting: what the location checks found. */
  location?: LocationReport;
}

interface Row {
  id: number;
  business_name: string;
  area: string;
  address: string;
  venue_phone: string;
  contact_name: string;
  email: string;
  password_hash: string;
  message: string | null;
  status: ApplicationStatus;
  reason: string | null;
  venue_id: number | null;
  created_at: string;
  decided_at: string | null;
  business_id: number | null;
  for_business: string | null;
  lat: number | null;
  lng: number | null;
  found_lat: number | null;
  found_lng: number | null;
  pin_place: string | null;
  email_check: EmailCheck;
  review_checks: string | null;
}

/** Applications with the name of the business a branch is for. */
const APPLICATION_SELECT = `SELECT va.*, b.name AS for_business FROM venue_applications va LEFT JOIN businesses b ON b.id = va.business_id`;

function toApplication(r: Row): VenueApplication {
  return {
    id: r.id,
    businessName: r.business_name,
    area: r.area,
    address: r.address,
    venuePhone: r.venue_phone,
    contactName: r.contact_name,
    email: r.email,
    message: r.message,
    status: r.status,
    reason: r.reason,
    venueId: r.venue_id,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    businessId: r.business_id,
    forBusiness: r.for_business,
    pin: r.lat !== null && r.lng !== null ? { lat: r.lat, lng: r.lng } : null,
    found: r.found_lat !== null && r.found_lng !== null ? { lat: r.found_lat, lng: r.found_lng } : null,
    pinPlace: r.pin_place,
    emailCheck: r.email_check,
    reviewChecks: r.review_checks ? r.review_checks.split(",") : [],
  };
}

/** A pin from a form, checked: on the map, and in Malaysia. */
function readPin(lat: unknown, lng: unknown): { ok: true; pin: Point } | { ok: false; error: string } {
  const pin = readPoint(lat, lng);
  if (!pin) return { ok: false, error: "Drop a pin on the map where the venue is." };
  if (!inMalaysia(pin)) return { ok: false, error: "The pin is outside Malaysia. Move it onto the venue." };
  return { ok: true, pin };
}

/**
 * Look the address up, and the place at the pin, while the applicant waits.
 * Either may come back empty; that is for the person approving to weigh.
 */
async function lookUp(address: string, area: string, pin: Point) {
  const found = (await findAddress(`${address}, ${area}`)) ?? (await findAddress(address));
  const place = await placeAt(pin);
  return { found, place };
}

/** What doesn't add up about where an application says it is. */
export async function locationReport(a: VenueApplication): Promise<LocationReport> {
  const warnings: string[] = [];
  if (!a.pin) return { distanceM: null, nearby: [], warnings: ["No pin on the map: it applied before pins were asked for."] };

  const distance = a.found ? distanceM(a.pin, a.found) : null;
  if (!geocoderOn()) warnings.push("Addresses are not looked up on this install (MYSENAM_GEOCODER=off).");
  else if (!a.found) warnings.push("The address could not be found on the map. Look it up yourself.");
  else if (distance! > FAR_FROM_ADDRESS_M)
    warnings.push(`The pin is ${formatDistance(distance!)} from where the address leads.`);
  if (a.pinPlace && !areaMatches(a.area, a.pinPlace))
    warnings.push(`The map puts the pin in ${a.pinPlace.split(", ").slice(0, 3).join(", ")}, which doesn't mention "${a.area}".`);

  // A degree of latitude is 111 km; this box holds the circle that matters.
  const box = (SAME_SPOT_M / 111_000) * 2;
  const candidates = (await getDb()
    .prepare(
      `SELECT id, name, lat, lng FROM venues
        WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
          AND (?::int IS NULL OR business_id IS DISTINCT FROM ?::int)`
    )
    .all(a.pin.lat - box, a.pin.lat + box, a.pin.lng - box, a.pin.lng + box, a.businessId, a.businessId)) as {
    id: number;
    name: string;
    lat: number;
    lng: number;
  }[];
  const nearby = candidates
    .map((v) => ({ id: v.id, name: v.name, distanceM: distanceM(a.pin!, v) }))
    .filter((v) => v.distanceM <= SAME_SPOT_M)
    .sort((x, y) => x.distanceM - y.distanceM);
  for (const v of nearby) warnings.push(`${v.name} is already listed ${formatDistance(v.distanceM)} from the pin.`);
  return { distanceM: distance, nearby, warnings };
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** How long the link in the confirmation email works. */
export const CONFIRM_DAYS = RETENTION.unconfirmedApplicationDays;

export const MIN_PASSWORD = 10;

export type SubmitResult = { ok: true; application: VenueApplication } | { ok: false; error: string };

/**
 * Somebody applying. It is written down, and a link emailed to them; the
 * platform owner hears of it once they follow the link. On an install that
 * cannot send email nobody can be asked, so it goes straight through, marked
 * as unconfirmed.
 */
export async function submitApplication(input: {
  businessName: string;
  area: string;
  address: string;
  venuePhone: string;
  contactName: string;
  email: string;
  password: string;
  message?: string;
  lat: unknown;
  lng: unknown;
}): Promise<SubmitResult & { emailSent?: boolean }> {
  const text = (v: string, min: number, max: number) => v.trim().length >= min && v.trim().length <= max;
  if (!text(input.businessName, 2, 100)) return { ok: false, error: "Give the venue's name." };
  if (!text(input.area, 2, 60)) return { ok: false, error: "Give the area the venue is in." };
  if (!text(input.address, 5, 200)) return { ok: false, error: "Give the venue's address." };
  if (!/^\+?[0-9 -]{7,20}$/.test(input.venuePhone.trim()))
    return { ok: false, error: "Give a phone number customers can call." };
  if (!text(input.contactName, 2, 100)) return { ok: false, error: "Give your name." };
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200)
    return { ok: false, error: "Give a valid email address." };
  if (input.password.length < MIN_PASSWORD || input.password.length > 200)
    return { ok: false, error: `Choose a password of at least ${MIN_PASSWORD} characters.` };
  if ((input.message ?? "").length > 2000) return { ok: false, error: "The message is too long." };
  const pinned = readPin(input.lat, input.lng);
  if (!pinned.ok) return pinned;

  const db = getDb();
  if (await db.prepare("SELECT id FROM admins WHERE email = ?").get(email))
    return { ok: false, error: "That email already has an account. Sign in at /admin." };
  if (
    await db
      .prepare("SELECT id FROM venue_applications WHERE email = ? AND status = 'pending' AND email_check <> 'waiting'")
      .get(email)
  )
    return { ok: false, error: "There is already an application waiting for that email." };
  // One never confirmed — a lost email, a typo they have since fixed — gives
  // way to this one rather than locking them out until it expires.
  await db.prepare("DELETE FROM venue_applications WHERE email = ? AND status = 'pending' AND email_check = 'waiting'").run(email);

  const { found, place } = await lookUp(input.address.trim(), input.area.trim(), pinned.pin);
  const token = crypto.randomBytes(24).toString("base64url");
  const info = await db
    .prepare(`
      INSERT INTO venue_applications
        (business_name, area, address, venue_phone, contact_name, email, password_hash, message,
         lat, lng, found_lat, found_lng, pin_place, email_check, email_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)
    `)
    .run(
      input.businessName.trim(),
      input.area.trim(),
      input.address.trim(),
      input.venuePhone.trim(),
      input.contactName.trim(),
      email,
      hashPassword(input.password),
      input.message?.trim() || null,
      pinned.pin.lat,
      pinned.pin.lng,
      found?.lat ?? null,
      found?.lng ?? null,
      place,
      sha256(token)
    );
  const id = info.lastInsertRowid as number;

  const site = siteName();
  const emailSent = await sendPlainEmail(
    email,
    `Confirm your application to ${site}`,
    `Hi ${input.contactName.trim()},\n\nThanks for applying to list ${input.businessName.trim()} on ${site}. ` +
      `Follow this link to confirm this is your email, and we will look at your application:\n\n` +
      `${baseUrl()}/list-your-venue/confirm?token=${token}\n\n` +
      `The link works for ${CONFIRM_DAYS} days. If you did not apply, ignore this email and nothing happens.\n\n${site}`
  );
  if (!emailSent) {
    await db.prepare("UPDATE venue_applications SET email_check = 'unsent', email_token = NULL WHERE id = ?").run(id);
    await tellOwnersOfApplication(id);
  }
  return { ok: true, application: (await applicationById(id))!, emailSent };
}

/** So an application is not left waiting for somebody to happen to look. */
async function tellOwnersOfApplication(id: number): Promise<void> {
  const a = (await applicationById(id))!;
  const report = await locationReport(a);
  await tellOwners(
    `${a.businessName} has applied to join`,
    `${a.contactName} (${a.email}) has applied to list ${a.businessName} in ${a.area}. ` +
      (a.emailCheck === "confirmed" ? "They have confirmed their email. " : "Their email could not be confirmed: this install cannot send email. ") +
      (report.warnings.length ? `Worth a look:\n- ${report.warnings.join("\n- ")}\n\n` : "") +
      "Approve or turn it down under Venues & staff."
  );
}

export type ConfirmResult = "confirmed" | "unknown";

/** The applicant following the link in their email. */
export async function confirmApplicationEmail(token: string): Promise<ConfirmResult> {
  if (!token || token.length > 100) return "unknown";
  const db = getDb();
  const row = (await db
    .prepare(
      `UPDATE venue_applications SET email_check = 'confirmed', email_token = NULL
        WHERE email_token = ? AND email_check = 'waiting' AND status = 'pending'
          AND created_at >= datetime('now', ?)
        RETURNING id`
    )
    .get(sha256(token), `-${CONFIRM_DAYS} days`)) as { id: number } | undefined;
  if (!row) return "unknown";
  await tellOwnersOfApplication(row.id);
  return "confirmed";
}

/**
 * A business already on the platform asking for another branch.
 *
 * Its manager already has an account, so this is only the branch's details.
 * It waits for the platform owner like any application — each location is
 * vetted — unless the install approves branches of approved businesses on
 * its own (MYSENAM_AUTO_APPROVE_BRANCHES=on).
 */
export async function requestBranch(
  admin: Admin,
  input: { name: string; area: string; address: string; phone: string; message?: string; lat: unknown; lng: unknown }
): Promise<SubmitResult & { approved?: boolean }> {
  if (admin.businessId === null) return { ok: false, error: "Only a business manager can add a branch." };
  const text = (v: string, min: number, max: number) => v.trim().length >= min && v.trim().length <= max;
  if (!text(input.name, 2, 100)) return { ok: false, error: "Give the branch's name." };
  if (!text(input.area, 2, 60)) return { ok: false, error: "Give the area the branch is in." };
  if (!text(input.address, 5, 200)) return { ok: false, error: "Give the branch's address." };
  if (!/^\+?[0-9 -]{7,20}$/.test(input.phone.trim()))
    return { ok: false, error: "Give a phone number customers can call." };
  if ((input.message ?? "").length > 2000) return { ok: false, error: "The message is too long." };
  const pinned = readPin(input.lat, input.lng);
  if (!pinned.ok) return pinned;

  const { found, place } = await lookUp(input.address.trim(), input.area.trim(), pinned.pin);
  const info = await getDb()
    .prepare(`
      INSERT INTO venue_applications
        (business_name, area, address, venue_phone, contact_name, email, password_hash, message, business_id,
         lat, lng, found_lat, found_lng, pin_place, email_check)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'account')
    `)
    .run(
      input.name.trim(),
      input.area.trim(),
      input.address.trim(),
      input.phone.trim(),
      admin.name,
      admin.email,
      input.message?.trim() || null,
      admin.businessId,
      pinned.pin.lat,
      pinned.pin.lng,
      found?.lat ?? null,
      found?.lng ?? null,
      place
    );
  const id = info.lastInsertRowid as number;
  const report = await locationReport((await applicationById(id))!);

  // On its own only when nothing about where it is needs a second look.
  if (process.env.MYSENAM_AUTO_APPROVE_BRANCHES === "on" && report.warnings.length === 0) {
    const approved = await approveApplication(id, admin.id, "auto");
    if (!approved.ok) return approved;
    await tellOwners(
      `${admin.businessName ?? "A business"} added a branch: ${input.name.trim()}`,
      `${admin.email} added ${input.name.trim()} (${input.area.trim()}) to ${admin.businessName ?? "their business"}. ` +
        "Branches of approved businesses are approved on their own on this install."
    );
    return { ok: true, application: approved.application, approved: true };
  }
  await tellOwners(
    `${admin.businessName ?? "A business"} asks for a new branch: ${input.name.trim()}`,
    `${admin.email} asks to add ${input.name.trim()} (${input.area.trim()}) to ${admin.businessName ?? "their business"}. ` +
      (report.warnings.length ? `Worth a look:\n- ${report.warnings.join("\n- ")}\n\n` : "") +
      "Approve or turn it down under Venues & staff."
  );
  return { ok: true, application: (await applicationById(id))!, approved: false };
}

/** A business's own branch requests, newest first. */
export async function listBranchRequests(businessId: number): Promise<VenueApplication[]> {
  return (
    (await getDb()
      .prepare(`${APPLICATION_SELECT} WHERE va.business_id = ? ORDER BY va.id DESC LIMIT 50`)
      .all(businessId)) as Row[]
  ).map(toApplication);
}

export async function applicationById(id: number): Promise<VenueApplication | null> {
  const row = await getDb().prepare(`${APPLICATION_SELECT} WHERE va.id = ?`).get(id) as Row | undefined;
  return row ? toApplication(row) : null;
}

/**
 * Waiting ones first, each with what its location checks found, then the
 * most recently decided. Not ones whose email is still to be confirmed: as
 * far as anybody here knows, nobody has applied yet.
 */
export async function listApplications(limit = 100): Promise<VenueApplication[]> {
  const applications = (
    await getDb()
      .prepare(
        `${APPLICATION_SELECT} WHERE va.email_check <> 'waiting'
         ORDER BY va.status = 'pending' DESC, COALESCE(va.decided_at, va.created_at) DESC, va.id DESC LIMIT ?`
      )
      .all(limit) as Row[]
  ).map(toApplication);
  for (const a of applications) if (a.status === "pending") a.location = await locationReport(a);
  return applications;
}

export type DecisionResult =
  | { ok: true; application: VenueApplication; emailed: boolean }
  | { ok: false; error: string };

/**
 * Let a venue in: make the venue, and its first operator's account with the
 * password they chose when applying.
 *
 * Somebody approving says what they checked, and it has to be everything in
 * REVIEW_CHECKS; "auto" is a branch the install approved on its own.
 */
export async function approveApplication(
  id: number,
  deciderId: number,
  checks: readonly string[] | "auto"
): Promise<DecisionResult> {
  if (checks !== "auto" && !REVIEW_CHECKS.every((c) => checks.includes(c.id)))
    return { ok: false, error: "Tick every check before approving." };
  const db = getDb();
  const row = await db.prepare(`${APPLICATION_SELECT} WHERE va.id = ?`).get(id) as Row | undefined;
  if (!row) return { ok: false, error: "Application not found." };
  if (row.status !== "pending") return { ok: false, error: "That application has already been decided." };
  if (row.email_check === "waiting") return { ok: false, error: "They have not confirmed their email yet." };
  const branch = row.business_id !== null;
  if (!branch && (await db.prepare("SELECT id FROM admins WHERE email = ?").get(row.email)))
    return { ok: false, error: "That email has an account already. Reject this one and add them by hand." };

  let venueId = 0;
  try {
    await db.transaction(async () => {
      const venue = await createVenue({
        name: row.business_name,
        area: row.area,
        address: row.address,
        phone: row.venue_phone,
      });
      if (!venue.ok) throw new Error(venue.error);
      venueId = venue.venue.id;
      await db.prepare("UPDATE venues SET lat = ?, lng = ? WHERE id = ?").run(row.lat, row.lng, venueId);
      if (branch) {
        // Another branch of a business already here: its managers have it now.
        await db.prepare("UPDATE venues SET business_id = ? WHERE id = ?").run(row.business_id, venueId);
      } else {
        // A new business, with this as its first branch and the applicant as
        // its manager — so adding a second branch later is a request, not a
        // second account.
        const business = await db.prepare("INSERT INTO businesses (name) VALUES (?)").run(row.business_name);
        const businessId = business.lastInsertRowid as number;
        await db.prepare("UPDATE venues SET business_id = ? WHERE id = ?").run(businessId, venueId);
        await db.prepare("INSERT INTO admins (name, email, password_hash, business_id) VALUES (?, ?, ?, ?)").run(
          row.contact_name,
          row.email,
          row.password_hash,
          businessId
        );
      }
      await db.prepare(
        "UPDATE venue_applications SET status = 'approved', venue_id = ?, review_checks = ?, decided_at = datetime('now'), decided_by = ? WHERE id = ?"
      ).run(venueId, checks === "auto" ? "auto" : REVIEW_CHECKS.map((c) => c.id).join(","), deciderId, id);
      await startBilling(venueId);
    })();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not set the venue up." };
  }

  const site = siteName();
  if (branch) {
    const emailed = await sendPlainEmail(
      row.email,
      `${row.business_name} is open on ${site}`,
      `Hi ${row.contact_name},\n\n${row.business_name} has been added to ${row.for_business ?? "your business"} on ${site}.\n\n` +
        `It is in your dashboard now: add its courts and rates, and check its opening hours. ` +
        `It appears to customers once it has its first court.\n\n${site}`
    );
    return { ok: true, application: (await applicationById(id))!, emailed };
  }
  const emailed = await sendPlainEmail(
    row.email,
    `${row.business_name} is on ${site}`,
    `Hi ${row.contact_name},\n\n${row.business_name} has been approved on ${site}.\n\n` +
      `Sign in at ${baseUrl()}/admin with ${row.email} and the password you chose when you applied, ` +
      `then follow the setup steps at the top of the dashboard: add your courts and rates ` +
      `(Courts & rates) and check your opening hours (Venue details). ` +
      `Your venue appears to customers once it has its first court.\n\n${site}`
  );
  return { ok: true, application: (await applicationById(id))!, emailed };
}

export async function rejectApplication(
  id: number,
  deciderId: number,
  reason: string
): Promise<DecisionResult> {
  const db = getDb();
  const row = await db.prepare("SELECT * FROM venue_applications WHERE id = ?").get(id) as Row | undefined;
  if (!row) return { ok: false, error: "Application not found." };
  if (row.status !== "pending") return { ok: false, error: "That application has already been decided." };
  const why = reason.trim().slice(0, 500) || null;
  // Nothing they asked for was granted, so nothing of theirs needs keeping
  // but the record that they asked and why not: the password goes.
  await db.prepare(
    "UPDATE venue_applications SET status = 'rejected', reason = ?, password_hash = '', decided_at = datetime('now'), decided_by = ? WHERE id = ?"
  ).run(why, deciderId, id);

  const site = siteName();
  const emailed = await sendPlainEmail(
    row.email,
    `Your application to ${site}`,
    `Hi ${row.contact_name},\n\nThank you for applying to list ${row.business_name} on ${site}. ` +
      `We are not able to take it on at the moment.${why ? `\n\n${why}` : ""}\n\n${site}`
  );
  return { ok: true, application: (await applicationById(id))!, emailed };
}
