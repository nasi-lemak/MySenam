import crypto from "crypto";
import { getDb } from "./db";
import { hashPassword } from "./auth";
import { createVenue } from "./store";
import { emailConfig } from "./transports";
import { baseUrl, drainOutbox, emailPlain, transportOverridden } from "./outbox";
import { siteName } from "./site";
import { startBilling } from "./billing";
import { tellOwners } from "./owner-alerts";
import { RETENTION } from "./privacy";
import { REVIEW_CHECKS } from "./review-checks";
import type { Admin } from "./admin-auth";
import { VENUE_CAPS } from "./limits";
import { listingState, venueListing, type ListingState } from "./listing";
import { businessSuspension } from "./suspensions";
import { areaMatches, distanceM, findAddress, formatDistance, geocoderOn, inCountry, placeAt, readPoint, type Point } from "./geo";
import { region } from "./region";
import { englishOf, said, type StaffText } from "./staff-text";

/**
 * Businesses joining the marketplace, and their venues going live.
 *
 * Anybody can sign up, and is setting their venue up minutes later: once
 * they confirm their email, their account opens with the venue as a draft
 * (lib/listing.ts), which they and their staff can use and nobody else can
 * see. Customers can reach it once the platform owner lets it go live. The
 * application is the venue's record throughout — 'draft', then 'pending' when
 * it asks to go live, then 'approved' or 'rejected' — and a further branch
 * gets one of its own the same way.
 *
 * Before it goes live, three kinds of evidence that the venue is real:
 *
 *   - Where it is. The applicant drops a pin on a map. Their address is looked
 *     up (lib/geo.ts) and set beside the pin, along with what the map calls
 *     the place at the pin and any venue already listed right there.
 *   - That they can be reached. No account opens until the person signing up
 *     has followed a link emailed to the address they gave.
 *   - What the platform owner checked. Approving asks them to tick that they
 *     looked at the map, phoned the venue, and found the business somewhere
 *     besides this form — and records that they did.
 */

export type ApplicationStatus = "draft" | "pending" | "approved" | "rejected";

/** What a venue asking to go live has set up. */
export interface SetupSummary {
  courts: number;
  sports: string;
  lowRate: number | null;
  highRate: number | null;
}

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
  /** The same, as phrases a staff screen says in the staff language (lib/staff-text.ts). */
  phrases: StaffText[];
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
  /** For one asking to go live: what it has set up. */
  setup?: SetupSummary;
}

interface Row {
  id: number;
  business_name: string;
  area: string;
  address: string;
  venue_phone: string;
  contact_name: string;
  email: string;
  password_hash: string | null;
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

/** A pin from a form, checked: on the map, and in the install's country. */
function readPin(lat: unknown, lng: unknown): { ok: true; pin: Point } | { ok: false; error: string } {
  const pin = readPoint(lat, lng);
  if (!pin) return { ok: false, error: "Drop a pin on the map where the venue is." };
  if (!inCountry(pin)) return { ok: false, error: `The pin is outside ${region().name}. Move it onto the venue.` };
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
  const phrases: StaffText[] = [];
  const report = (distance: number | null, nearby: LocationReport["nearby"]): LocationReport => ({ distanceM: distance, nearby, warnings: phrases.map(englishOf), phrases });
  if (!a.pin) {
    phrases.push(said("srv.app.noPin"));
    return report(null, []);
  }

  const distance = a.found ? distanceM(a.pin, a.found) : null;
  if (!geocoderOn()) phrases.push(said("srv.app.noGeocoder"));
  else if (!a.found) phrases.push(said("srv.app.notFound"));
  else if (distance! > FAR_FROM_ADDRESS_M) phrases.push(said("srv.app.farPin", { distance: formatDistance(distance!) }));
  if (a.pinPlace && !areaMatches(a.area, a.pinPlace))
    phrases.push(said("srv.app.otherPlace", { place: a.pinPlace.split(", ").slice(0, 3).join(", "), area: a.area }));

  // A degree of latitude is 111 km; this box holds the circle that matters.
  const box = (SAME_SPOT_M / 111_000) * 2;
  const candidates = (await getDb()
    .prepare(
      `SELECT id, name, lat, lng FROM venues
        WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
          AND (?::int IS NULL OR business_id IS DISTINCT FROM ?::int)
          AND id IS DISTINCT FROM ?::int`
    )
    .all(a.pin.lat - box, a.pin.lat + box, a.pin.lng - box, a.pin.lng + box, a.businessId, a.businessId, a.venueId)) as {
    id: number;
    name: string;
    lat: number;
    lng: number;
  }[];
  const nearby = candidates
    .map((v) => ({ id: v.id, name: v.name, distanceM: distanceM(a.pin!, v) }))
    .filter((v) => v.distanceM <= SAME_SPOT_M)
    .sort((x, y) => x.distanceM - y.distanceM);
  for (const v of nearby) phrases.push(said("srv.app.nearby", { name: v.name, distance: formatDistance(v.distanceM) }));
  return report(distance, nearby);
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** How long the link in the confirmation email works. */
export const CONFIRM_DAYS = RETENTION.unconfirmedApplicationDays;

/**
 * An email to somebody who applied: queued in the outbox, so a mail server
 * that is down delays it rather than losing it, then tried at once. False
 * where no mail server is set up (or sending is only logged), so the caller
 * goes on without it, as it says.
 */
async function emailApplicant(
  to: string,
  subject: string,
  text: string,
  opts: { kind: "account_email" | "applicant"; dedupeKey: string; expiresMinutes?: number }
): Promise<boolean> {
  if (!transportOverridden() && (!emailConfig() || process.env.MYSENAM_SEND === "log")) {
    if (process.env.MYSENAM_SEND === "log") console.info(`[email] → ${to}\n${subject}\n${text}\n`);
    return false;
  }
  await emailPlain({ to, subject, text, kind: opts.kind, dedupeKey: opts.dedupeKey, expiresMinutes: opts.expiresMinutes });
  await drainOutbox().catch(() => null);
  return true;
}

export const MIN_PASSWORD = 10;

export type SubmitResult = { ok: true; application: VenueApplication } | { ok: false; error: string };

/**
 * A business signing up. It is written down, and a link emailed to them;
 * following it opens their account and a draft of their venue, which they
 * set up straight away and nobody else sees until it goes live. On an
 * install that cannot send email nobody can be asked, so the account opens
 * at once, marked as unconfirmed.
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
      .prepare("SELECT id FROM venue_applications WHERE email = ? AND status = 'pending' AND venue_id IS NULL")
      .get(email)
  )
    return { ok: false, error: "There is already an application waiting for that email." };
  // One never confirmed — a lost email, a typo they have since fixed — gives
  // way to this one rather than locking them out until it expires.
  await db.prepare("DELETE FROM venue_applications WHERE email = ? AND email_check = 'waiting'").run(email);

  const { found, place } = await lookUp(input.address.trim(), input.area.trim(), pinned.pin);
  const token = crypto.randomBytes(24).toString("base64url");
  const info = await db
    .prepare(`
      INSERT INTO venue_applications
        (business_name, area, address, venue_phone, contact_name, email, password_hash, message,
         lat, lng, found_lat, found_lng, pin_place, email_check, email_token, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, 'draft')
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
  const emailSent = await emailApplicant(
    email,
    `Confirm your email for ${site}`,
    `Hi ${input.contactName.trim()},\n\nThanks for signing ${input.businessName.trim()} up to ${site}. ` +
      `Follow this link to confirm this is your email, and your account opens straight away:\n\n` +
      `${baseUrl()}/list-your-venue/confirm?token=${token}\n\n` +
      `The link works for ${CONFIRM_DAYS} days. If you did not sign up, ignore this email and nothing happens.\n\n${site}`,
    { kind: "account_email", dedupeKey: `application-confirm:${id}`, expiresMinutes: CONFIRM_DAYS * 24 * 60 }
  );
  if (!emailSent) {
    await db.prepare("UPDATE venue_applications SET email_check = 'unsent', email_token = NULL WHERE id = ?").run(id);
    const opened = await openAccount(id);
    if (!opened.ok) return opened;
  }
  return { ok: true, application: (await applicationById(id))!, emailSent };
}

/**
 * Open a confirmed sign-up: a business, its first venue as a draft with the
 * pin it signed up with, and the person who signed up as its manager, with
 * the password they chose. The application stays as the venue's record.
 */
async function openAccount(id: number): Promise<{ ok: true; venueId: number } | { ok: false; error: string }> {
  const db = getDb();
  const row = (await db.prepare(`${APPLICATION_SELECT} WHERE va.id = ?`).get(id)) as Row;
  if (await db.prepare("SELECT id FROM admins WHERE email = ?").get(row.email))
    return { ok: false, error: "That email already has an account. Sign in at /admin." };
  let venueId = 0;
  try {
    await db.transaction(async () => {
      const venue = await createVenue({
        name: row.business_name,
        area: row.area,
        address: row.address,
        phone: row.venue_phone,
        draft: true,
      });
      if (!venue.ok) throw new Error(venue.error);
      venueId = venue.venue.id;
      const business = await db.prepare("INSERT INTO businesses (name) VALUES (?)").run(row.business_name);
      const businessId = business.lastInsertRowid as number;
      await db
        .prepare("UPDATE venues SET business_id = ?, lat = ?, lng = ? WHERE id = ?")
        .run(businessId, row.lat, row.lng, venueId);
      await db
        .prepare("INSERT INTO admins (name, email, password_hash, business_id) VALUES (?, ?, ?, ?)")
        .run(row.contact_name, row.email, row.password_hash, businessId);
      // The password lives on the account now; the application needs no copy.
      await db
        .prepare("UPDATE venue_applications SET venue_id = ?, password_hash = NULL WHERE id = ?")
        .run(venueId, id);
    })();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not open the account." };
  }
  return { ok: true, venueId };
}

export type ConfirmResult = "confirmed" | "unknown";

/** The person signing up following the link in their email: their account opens. */
export async function confirmApplicationEmail(token: string): Promise<ConfirmResult> {
  if (!token || token.length > 100) return "unknown";
  const db = getDb();
  const row = (await db
    .prepare(
      `UPDATE venue_applications SET email_check = 'confirmed', email_token = NULL
        WHERE email_token = ? AND email_check = 'waiting'
          AND created_at >= datetime('now', ?)
        RETURNING id`
    )
    .get(sha256(token), `-${CONFIRM_DAYS} days`)) as { id: number } | undefined;
  if (!row) return "unknown";
  const opened = await openAccount(row.id);
  return opened.ok ? "confirmed" : "unknown";
}

/**
 * Another branch for a business already here, made by its manager there and
 * then as a draft, to set up like the first and send to go live when ready.
 */
export async function addBranch(
  admin: Admin,
  input: { name: string; area: string; address: string; phone: string; message?: string; lat: unknown; lng: unknown }
): Promise<SubmitResult & { venueId?: number }> {
  if (admin.businessId === null) return { ok: false, error: "Only a business manager can add a branch." };
  const suspended = await businessSuspension(admin.businessId);
  if (suspended) return { ok: false, error: suspended };
  const text = (v: string, min: number, max: number) => v.trim().length >= min && v.trim().length <= max;
  if (!text(input.name, 2, 100)) return { ok: false, error: "Give the branch's name." };
  if (!text(input.area, 2, 60)) return { ok: false, error: "Give the area the branch is in." };
  if (!text(input.address, 5, 200)) return { ok: false, error: "Give the branch's address." };
  if (!/^\+?[0-9 -]{7,20}$/.test(input.phone.trim()))
    return { ok: false, error: "Give a phone number customers can call." };
  if ((input.message ?? "").length > 2000) return { ok: false, error: "The message is too long." };
  const pinned = readPin(input.lat, input.lng);
  if (!pinned.ok) return pinned;

  const db = getDb();
  const { drafts } = (await db
    .prepare("SELECT COUNT(*)::int AS drafts FROM venues WHERE business_id = ? AND published_at IS NULL")
    .get(admin.businessId)) as { drafts: number };
  if (drafts >= VENUE_CAPS.draftBranches)
    return {
      ok: false,
      error: `You have ${drafts} branches being set up. Send one to go live, or finish one, before adding another.`,
    };

  let id = 0;
  let venueId = 0;
  try {
    await db.transaction(async () => {
      const venue = await createVenue({
        name: input.name,
        area: input.area,
        address: input.address,
        phone: input.phone,
        draft: true,
      });
      if (!venue.ok) throw new Error(venue.error);
      venueId = venue.venue.id;
      await db
        .prepare("UPDATE venues SET business_id = ?, lat = ?, lng = ? WHERE id = ?")
        .run(admin.businessId, pinned.pin.lat, pinned.pin.lng, venueId);
      const info = await db
        .prepare(`
          INSERT INTO venue_applications
            (business_name, area, address, venue_phone, contact_name, email, password_hash, message, business_id,
             venue_id, lat, lng, email_check, status)
          VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'account', 'draft')
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
          venueId,
          pinned.pin.lat,
          pinned.pin.lng
        );
      id = info.lastInsertRowid as number;
    })();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not add the branch." };
  }
  return { ok: true, application: (await applicationById(id))!, venueId };
}

/** What a draft still needs before it can ask to go live. */
export async function goLiveMissing(venueId: number): Promise<string[]> {
  return (await goLiveNeeds(venueId)).map(englishOf);
}

/** The same, as phrases a staff screen says in the staff language. */
async function goLiveNeeds(venueId: number): Promise<StaffText[]> {
  const db = getDb();
  const venue = (await db.prepare("SELECT lat, lng FROM venues WHERE id = ?").get(venueId)) as
    | { lat: number | null; lng: number | null }
    | undefined;
  if (!venue) return [said("srv.app.gone")];
  const missing: StaffText[] = [];
  const { courts } = (await db
    .prepare("SELECT COUNT(*)::int AS courts FROM courts WHERE venue_id = ?")
    .get(venueId)) as { courts: number };
  if (courts === 0) return [said("srv.app.addCourt")];
  if (venue.lat === null || venue.lng === null) missing.push(said("srv.app.pin"));
  return missing;
}

export interface GoLiveStatus {
  state: ListingState;
  /** Why it is off the marketplace, if it is. */
  suspension: { by: "payment" | "owner"; reason: string | null } | null;
  /** Its request: 'draft' until it asks, then 'pending', 'approved' or 'rejected'. */
  request: { status: ApplicationStatus; reason: string | null } | null;
  missing: string[];
  /** The same, as phrases a staff screen says in the staff language. */
  missingPhrases: StaffText[];
}

export async function goLiveStatus(venueId: number): Promise<GoLiveStatus | null> {
  const listing = await venueListing(venueId);
  if (!listing) return null;
  const row = (await getDb()
    .prepare("SELECT status, reason FROM venue_applications WHERE venue_id = ? ORDER BY id DESC LIMIT 1")
    .get(venueId)) as { status: ApplicationStatus; reason: string | null } | undefined;
  const held = (await getDb()
    .prepare("SELECT suspended_by, suspended_reason FROM venues WHERE id = ? AND suspended_at IS NOT NULL")
    .get(venueId)) as { suspended_by: "payment" | "owner" | null; suspended_reason: string | null } | undefined;
  const needs = listing.publishedAt === null ? await goLiveNeeds(venueId) : [];
  return {
    state: listingState(listing),
    suspension: held ? { by: held.suspended_by ?? "payment", reason: held.suspended_reason } : null,
    request: row ?? null,
    missing: needs.map(englishOf),
    missingPhrases: needs,
  };
}

/**
 * A draft asking to go live. Its details are taken afresh from the venue —
 * what customers would see is what gets checked — and looked up again, and
 * it goes to the platform owner; or, for a further branch of a business
 * already live, on an install that allows it, straight live when nothing
 * about where it is needs a second look.
 */
export async function requestGoLive(
  admin: Admin,
  venueId: number
): Promise<{ ok: true; live: boolean } | { ok: false; error: string }> {
  if (admin.businessId === null && admin.venueId !== null)
    return { ok: false, error: "Ask your business's manager to send the venue to go live." };
  const db = getDb();
  const venue = (await db
    .prepare("SELECT id, name, area, address, phone, lat, lng, published_at, business_id FROM venues WHERE id = ?")
    .get(venueId)) as
    | {
        id: number;
        name: string;
        area: string;
        address: string;
        phone: string;
        lat: number | null;
        lng: number | null;
        published_at: string | null;
        business_id: number | null;
      }
    | undefined;
  if (!venue) return { ok: false, error: "Venue not found." };
  if (venue.published_at !== null) return { ok: false, error: "This venue is live already." };
  const suspended = await businessSuspension(venue.business_id);
  if (suspended) return { ok: false, error: suspended };
  const row = (await db
    .prepare("SELECT id, status FROM venue_applications WHERE venue_id = ? ORDER BY id DESC LIMIT 1")
    .get(venueId)) as { id: number; status: ApplicationStatus } | undefined;
  if (!row) return { ok: false, error: "This venue has no sign-up to send. Ask the platform owner." };
  if (row.status === "pending") return { ok: false, error: "It is waiting for approval already." };
  const missing = await goLiveMissing(venueId);
  if (missing.length > 0) return { ok: false, error: missing.join(" ") };

  const { found, place } = await lookUp(venue.address, venue.area, { lat: venue.lat!, lng: venue.lng! });
  await db
    .prepare(
      `UPDATE venue_applications
          SET status = 'pending', reason = NULL, decided_at = NULL, decided_by = NULL,
              business_name = ?, area = ?, address = ?, venue_phone = ?, lat = ?, lng = ?,
              found_lat = ?, found_lng = ?, pin_place = ?, created_at = datetime('now')
        WHERE id = ?`
    )
    .run(
      venue.name,
      venue.area,
      venue.address,
      venue.phone,
      venue.lat,
      venue.lng,
      found?.lat ?? null,
      found?.lng ?? null,
      place,
      row.id
    );
  const application = (await applicationById(row.id))!;
  const report = await locationReport(application);
  const live = await businessIsLive(venue.business_id, venueId);

  // On its own only when nothing about where it is needs a second look.
  if (
    process.env.MYSENAM_AUTO_APPROVE_BRANCHES === "on" &&
    application.businessId !== null &&
    live &&
    report.warnings.length === 0
  ) {
    const approved = await approveApplication(row.id, admin.id, "auto");
    if (!approved.ok) return approved;
    await tellOwners(
      `${admin.businessName ?? "A business"} opened a branch: ${venue.name}`,
      `${admin.email} opened ${venue.name} (${venue.area}) for ${admin.businessName ?? "their business"}. ` +
        "Branches of businesses already live go live on their own on this install when their location checks pass."
    );
    return { ok: true, live: true };
  }
  await tellOwners(
    `${venue.name} asks to go live`,
    `${application.contactName} (${application.email}) asks for ${venue.name} in ${venue.area} to go live` +
      (application.forBusiness ? `, as a branch of ${application.forBusiness}. ` : ". ") +
      (application.emailCheck === "unsent" ? "Their email could not be confirmed: this install cannot send email. " : "") +
      (report.warnings.length ? `Worth a look:\n- ${report.warnings.join("\n- ")}\n\n` : "") +
      "Approve or turn it down under Venues & staff."
  );
  return { ok: true, live: false };
}

/** Whether any other venue of this business is live. */
async function businessIsLive(businessId: number | null, besides: number): Promise<boolean> {
  if (businessId === null) return false;
  return (
    (await getDb()
      .prepare("SELECT 1 FROM venues WHERE business_id = ? AND id <> ? AND published_at IS NOT NULL")
      .get(businessId, besides)) !== undefined
  );
}

/** A business's own branches, newest first, whatever state they are in. */
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

/** What a venue asking to go live has set up, for whoever decides. */
async function setupSummary(venueId: number): Promise<SetupSummary> {
  const row = (await getDb()
    .prepare(
      `SELECT COUNT(*)::int AS courts, string_agg(DISTINCT sport, ', ' ORDER BY sport) AS sports,
              MIN(off_peak_rate)::float AS low, MAX(peak_rate)::float AS high
         FROM courts WHERE venue_id = ?`
    )
    .get(venueId)) as { courts: number; sports: string | null; low: number | null; high: number | null };
  return { courts: row.courts, sports: row.sports ?? "", lowRate: row.low, highRate: row.high };
}

/**
 * Venues asking to go live first, each with what its location checks found
 * and what it has set up, then the most recently decided. Not drafts still
 * being set up, nor sign-ups whose email is still to be confirmed.
 */
export async function listApplications(limit = 100): Promise<VenueApplication[]> {
  const applications = (
    await getDb()
      .prepare(
        `${APPLICATION_SELECT} WHERE va.status <> 'draft'
         ORDER BY va.status = 'pending' DESC, COALESCE(va.decided_at, va.created_at) DESC, va.id DESC LIMIT ?`
      )
      .all(limit) as Row[]
  ).map(toApplication);
  for (const a of applications) {
    if (a.status !== "pending") continue;
    a.location = await locationReport(a);
    if (a.venueId !== null) a.setup = await setupSummary(a.venueId);
  }
  return applications;
}

/** Businesses setting a venue up that has not asked to go live yet. */
export async function countDrafts(): Promise<number> {
  return (
    (await getDb()
      .prepare("SELECT COUNT(*)::int AS n FROM venue_applications WHERE status = 'draft' AND venue_id IS NOT NULL")
      .get()) as { n: number }
  ).n;
}

export type DecisionResult =
  | { ok: true; application: VenueApplication; emailed: boolean }
  | { ok: false; error: string };

/**
 * Let a venue go live: customers can find it, book it and pay it, and its
 * billing starts — after the install's free months, so a trial runs from
 * here rather than from the day it signed up.
 *
 * Somebody approving says what they checked, and it has to be everything in
 * REVIEW_CHECKS; "auto" is a branch the install approved on its own.
 *
 * An application from before drafts, with no venue yet, makes the venue and
 * its operator's account here, as approving always did.
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
  if (row.venue_id === null) return await approveFromBefore(row, deciderId, checks);

  const venueId = row.venue_id;
  const { business_id: businessId } = (await db.prepare("SELECT business_id FROM venues WHERE id = ?").get(venueId)) as {
    business_id: number | null;
  };
  const suspended = await businessSuspension(businessId);
  if (suspended) return { ok: false, error: `Not while its business is suspended. ${suspended}` };
  await db.transaction(async () => {
    await db
      .prepare("UPDATE venues SET published_at = COALESCE(published_at, datetime('now')), lat = ?, lng = ? WHERE id = ?")
      .run(row.lat, row.lng, venueId);
    await db
      .prepare(
        "UPDATE venue_applications SET status = 'approved', review_checks = ?, decided_at = datetime('now'), decided_by = ? WHERE id = ?"
      )
      .run(checks === "auto" ? "auto" : REVIEW_CHECKS.map((c) => c.id).join(","), deciderId, id);
    await startBilling(venueId);
  })();

  const site = siteName();
  const { billing_starts_on: from } = (await db
    .prepare("SELECT billing_starts_on FROM venues WHERE id = ?")
    .get(venueId)) as { billing_starts_on: string | null };
  const emailed = await emailApplicant(
    row.email,
    `${row.business_name} is live on ${site}`,
    `Hi ${row.contact_name},\n\n${row.business_name} is live on ${site}: customers can find it, book it and pay it now.\n\n` +
      `${baseUrl()}/venue/${venueId}\n\n` +
      (from ? `It is free until ${from}; your first invoice comes after that.\n\n` : "") +
      site,
    { kind: "applicant", dedupeKey: `application-decision:${id}:${Date.now()}` }
  );
  return { ok: true, application: (await applicationById(id))!, emailed };
}

/** Approving an application made before drafts: the venue and account are made now. */
async function approveFromBefore(row: Row, deciderId: number, checks: readonly string[] | "auto"): Promise<DecisionResult> {
  const db = getDb();
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
        await db.prepare("UPDATE venues SET business_id = ? WHERE id = ?").run(row.business_id, venueId);
      } else {
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
      ).run(venueId, checks === "auto" ? "auto" : REVIEW_CHECKS.map((c) => c.id).join(","), deciderId, row.id);
      await startBilling(venueId);
    })();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not set the venue up." };
  }

  const site = siteName();
  const emailed = await emailApplicant(
    row.email,
    `${row.business_name} is on ${site}`,
    `Hi ${row.contact_name},\n\n${row.business_name} has been approved on ${site}.\n\n` +
      (branch
        ? `It is in your dashboard now: add its courts and rates, and check its opening hours. `
        : `Sign in at ${baseUrl()}/admin with ${row.email} and the password you chose when you applied, ` +
          `then follow the setup steps at the top of the dashboard. `) +
      `It appears to customers once it has its first court.\n\n${site}`,
    { kind: "applicant", dedupeKey: `application-decision:${row.id}:${Date.now()}` }
  );
  return { ok: true, application: (await applicationById(row.id))!, emailed };
}

/**
 * Not live, and why. A draft stays a draft, with everything its business
 * set up, and may put things right and ask again.
 */
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
  // but the record that they asked and why not: any password goes.
  await db.prepare(
    "UPDATE venue_applications SET status = 'rejected', reason = ?, password_hash = NULL, decided_at = datetime('now'), decided_by = ? WHERE id = ?"
  ).run(why, deciderId, id);

  const site = siteName();
  const emailed = await emailApplicant(
    row.email,
    row.venue_id !== null ? `${row.business_name} is not live yet` : `Your application to ${site}`,
    row.venue_id !== null
      ? `Hi ${row.contact_name},\n\nWe have not put ${row.business_name} live on ${site} yet.` +
          `${why ? `\n\n${why}` : ""}\n\nEverything you set up is still in your dashboard. ` +
          `Once it is put right, send it to go live again from there.\n\n${site}`
      : `Hi ${row.contact_name},\n\nThank you for applying to list ${row.business_name} on ${site}. ` +
          `We are not able to take it on at the moment.${why ? `\n\n${why}` : ""}\n\n${site}`,
    // A draft refused, put right and refused again is told again: one per decision.
    { kind: "applicant", dedupeKey: `application-decision:${id}:${Date.now()}` }
  );
  return { ok: true, application: (await applicationById(id))!, emailed };
}
