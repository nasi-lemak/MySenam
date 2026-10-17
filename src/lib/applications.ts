import { getDb } from "./db";
import { hashPassword } from "./auth";
import { createVenue } from "./store";
import { sendPlainEmail } from "./transports";
import { baseUrl } from "./outbox";
import { siteName } from "./site";
import { startBilling } from "./billing";
import { tellOwners } from "./owner-alerts";
import type { Admin } from "./admin-auth";

/**
 * Venues asking to join the marketplace.
 *
 * Anybody can apply; nobody is in until the platform owner says so. An
 * application holds everything needed to set the venue up — its details and
 * the password its first operator chose, already hashed — so approving it is
 * one click that makes the venue and the account together, and nobody has to
 * send a password to anybody.
 */

export type ApplicationStatus = "pending" | "approved" | "rejected";

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
  };
}

export const MIN_PASSWORD = 10;

export type SubmitResult = { ok: true; application: VenueApplication } | { ok: false; error: string };

export async function submitApplication(input: {
  businessName: string;
  area: string;
  address: string;
  venuePhone: string;
  contactName: string;
  email: string;
  password: string;
  message?: string;
}): Promise<SubmitResult> {
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

  const db = getDb();
  if (await db.prepare("SELECT id FROM admins WHERE email = ?").get(email))
    return { ok: false, error: "That email already has an account. Sign in at /admin." };
  if (
    await db
      .prepare("SELECT id FROM venue_applications WHERE email = ? AND status = 'pending'")
      .get(email)
  )
    return { ok: false, error: "There is already an application waiting for that email." };

  const info = await db
    .prepare(`
      INSERT INTO venue_applications
        (business_name, area, address, venue_phone, contact_name, email, password_hash, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      input.businessName.trim(),
      input.area.trim(),
      input.address.trim(),
      input.venuePhone.trim(),
      input.contactName.trim(),
      email,
      hashPassword(input.password),
      input.message?.trim() || null
    );
  // So an application is not left waiting for somebody to happen to look.
  await tellOwners(
    `${input.businessName.trim()} has applied to join`,
    `${input.contactName.trim()} (${email}) has applied to list ${input.businessName.trim()} in ${input.area.trim()}. ` +
      "Approve or turn it down under Venues & staff."
  );
  return { ok: true, application: (await applicationById(info.lastInsertRowid as number))! };
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
  input: { name: string; area: string; address: string; phone: string; message?: string }
): Promise<SubmitResult & { approved?: boolean }> {
  if (admin.businessId === null) return { ok: false, error: "Only a business manager can add a branch." };
  const text = (v: string, min: number, max: number) => v.trim().length >= min && v.trim().length <= max;
  if (!text(input.name, 2, 100)) return { ok: false, error: "Give the branch's name." };
  if (!text(input.area, 2, 60)) return { ok: false, error: "Give the area the branch is in." };
  if (!text(input.address, 5, 200)) return { ok: false, error: "Give the branch's address." };
  if (!/^\+?[0-9 -]{7,20}$/.test(input.phone.trim()))
    return { ok: false, error: "Give a phone number customers can call." };
  if ((input.message ?? "").length > 2000) return { ok: false, error: "The message is too long." };

  const info = await getDb()
    .prepare(`
      INSERT INTO venue_applications
        (business_name, area, address, venue_phone, contact_name, email, password_hash, message, business_id)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `)
    .run(
      input.name.trim(),
      input.area.trim(),
      input.address.trim(),
      input.phone.trim(),
      admin.name,
      admin.email,
      input.message?.trim() || null,
      admin.businessId
    );
  const id = info.lastInsertRowid as number;

  if (process.env.MYSENAM_AUTO_APPROVE_BRANCHES === "on") {
    const approved = await approveApplication(id, admin.id);
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

/** Waiting ones first, then the most recently decided. */
export async function listApplications(limit = 100): Promise<VenueApplication[]> {
  return (
    await getDb()
      .prepare(
        `${APPLICATION_SELECT} ORDER BY va.status = 'pending' DESC, COALESCE(va.decided_at, va.created_at) DESC, va.id DESC LIMIT ?`
      )
      .all(limit) as Row[]
  ).map(toApplication);
}

export type DecisionResult =
  | { ok: true; application: VenueApplication; emailed: boolean }
  | { ok: false; error: string };

/**
 * Let a venue in: make the venue, and its first operator's account with the
 * password they chose when applying.
 */
export async function approveApplication(id: number, deciderId: number): Promise<DecisionResult> {
  const db = getDb();
  const row = await db.prepare(`${APPLICATION_SELECT} WHERE va.id = ?`).get(id) as Row | undefined;
  if (!row) return { ok: false, error: "Application not found." };
  if (row.status !== "pending") return { ok: false, error: "That application has already been decided." };
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
        "UPDATE venue_applications SET status = 'approved', venue_id = ?, decided_at = datetime('now'), decided_by = ? WHERE id = ?"
      ).run(venueId, deciderId, id);
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
