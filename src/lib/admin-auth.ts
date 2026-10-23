import crypto from "crypto";
import { hasTwoFactor, twoFactorRequired } from "./two-factor";
import { NextRequest, NextResponse } from "next/server";
import { getDb, withTransaction } from "./db";
import { hashPassword, sessionExpiry, sessionKey, verifyPassword } from "./auth";
import { deskRefusal, type StaffRole } from "./roles";

export const ADMIN_SESSION_COOKIE = "ms_admin";
const SESSION_DAYS = 7;

/**
 * Somebody who signs in to the dashboard, and what they may manage:
 *
 *   - branch staff: one venue (venueId);
 *   - a business manager: every branch of one business (businessId);
 *   - the platform owner: everything (neither).
 */
export interface Admin {
  id: number;
  name: string;
  email: string;
  /** The one branch a member of branch staff works at. */
  venueId: number | null;
  /** The business a manager runs, every branch of it. */
  businessId: number | null;
  businessName: string | null;
  /** The venues this admin may manage; null for the platform owner, who may manage all. */
  venueIds: number[] | null;
  /** Branch staff: a manager, or front desk (lib/roles.ts). Everybody else manages. */
  role: StaffRole;
}

interface AdminRow {
  id: number;
  name: string;
  email: string;
  venue_id: number | null;
  business_id: number | null;
  business_name: string | null;
  password_hash: string;
  role?: StaffRole;
}

/** Columns every admin read takes, with the business's name. */
const ADMIN_COLUMNS = `a.id, a.name, a.email, a.venue_id, a.business_id, b.name AS business_name, a.role`;
const ADMIN_FROM = `admins a LEFT JOIN businesses b ON b.id = a.business_id`;

/** Rows to admins, with the venues each may manage, in one more query at most. */
async function toAdmins(rows: AdminRow[]): Promise<Admin[]> {
  const businesses = [...new Set(rows.map((r) => r.business_id).filter((id): id is number => id !== null))];
  const branches = new Map<number, number[]>();
  if (businesses.length > 0) {
    const venues = (await getDb()
      .prepare(`SELECT id, business_id FROM venues WHERE business_id IN (${businesses.map(() => "?").join(",")}) ORDER BY id`)
      .all(...businesses)) as { id: number; business_id: number }[];
    for (const v of venues) branches.set(v.business_id, [...(branches.get(v.business_id) ?? []), v.id]);
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    venueId: r.venue_id,
    businessId: r.business_id,
    businessName: r.business_name,
    venueIds:
      r.business_id !== null ? (branches.get(r.business_id) ?? []) : r.venue_id !== null ? [r.venue_id] : null,
    role: r.venue_id !== null && r.role === "desk" ? "desk" : "manager",
  }));
}

async function toAdmin(r: AdminRow): Promise<Admin> {
  return (await toAdmins([r]))[0];
}

/** The password this project ships with: refused in production (`adminPasswordProblem`). */
export const DEFAULT_ADMIN_PASSWORD = "mysenam-admin";
/** Shorter than this, an owner's password is refused in production. */
export const MIN_OWNER_PASSWORD = 12;

const production = () => process.env.NODE_ENV === "production";

/** What is wrong with ADMIN_PASSWORD for a production install, or null. */
export function adminPasswordProblem(password = process.env.ADMIN_PASSWORD): string | null {
  if (!password) return "ADMIN_PASSWORD is not set.";
  if (password === DEFAULT_ADMIN_PASSWORD) return "ADMIN_PASSWORD is still the published default.";
  if (password.length < MIN_OWNER_PASSWORD) return `ADMIN_PASSWORD is shorter than ${MIN_OWNER_PASSWORD} characters.`;
  return null;
}

/**
 * Create the first platform owner if none exists, so a fresh install is
 * reachable. Credentials come from ADMIN_EMAIL / ADMIN_PASSWORD.
 *
 * An owner, not any account: on a marketplace a business can sign itself up
 * before the owner has ever signed in, and its manager must not count as the
 * install already having somebody in charge.
 *
 * In production no owner is made with the published default password, or
 * none: the install stays locked until ADMIN_PASSWORD is set, rather than
 * open to anybody who has read this project.
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  const db = getDb();
  const existing = (await db
    .prepare("SELECT COUNT(*) AS n FROM admins WHERE venue_id IS NULL AND business_id IS NULL")
    .get()) as { n: number };
  if (existing.n > 0) return;
  if (production()) {
    const problem = adminPasswordProblem();
    if (problem) {
      console.error(`[mysenam] No owner account was made: ${problem} Set it and restart.`);
      return;
    }
  }

  await db.prepare(
    "INSERT INTO admins (name, email, password_hash, venue_id) VALUES (?, ?, ?, NULL)"
  ).run(
    "Platform Owner",
    process.env.ADMIN_EMAIL || "admin@mysenam.my",
    hashPassword(process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD)
  );
}

/**
 * An owner still on the published default, on an install now given a proper
 * ADMIN_PASSWORD: the password becomes that one. How an install made before
 * the default was refused gets its owner back (set it, restart). Production
 * only; returns how many accounts changed.
 */
export async function replaceDefaultOwnerPasswords(): Promise<number> {
  if (!production() || adminPasswordProblem()) return 0;
  const db = getDb();
  const owners = (await db
    .prepare("SELECT id, password_hash FROM admins WHERE venue_id IS NULL AND business_id IS NULL")
    .all()) as { id: number; password_hash: string }[];
  let changed = 0;
  for (const o of owners) {
    if (!verifyPassword(DEFAULT_ADMIN_PASSWORD, o.password_hash)) continue;
    await db.prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(hashPassword(process.env.ADMIN_PASSWORD!), o.id);
    await db.prepare("DELETE FROM admin_sessions WHERE admin_id = ?").run(o.id);
    changed++;
  }
  return changed;
}

export async function authenticateAdmin(email: string, password: string): Promise<Admin | null> {
  await ensureBootstrapAdmin();
  const row = await getDb()
    .prepare(`SELECT ${ADMIN_COLUMNS}, a.password_hash FROM ${ADMIN_FROM} WHERE a.email = ?`)
    .get(email.trim()) as AdminRow | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  // The published default opens nothing in production, whoever still has it.
  if (production() && password === DEFAULT_ADMIN_PASSWORD) return null;
  return await toAdmin(row);
}

export async function getAdminById(id: number): Promise<Admin | null> {
  const row = (await getDb().prepare(`SELECT ${ADMIN_COLUMNS} FROM ${ADMIN_FROM} WHERE a.id = ?`).get(id)) as AdminRow | undefined;
  return row ? await toAdmin(row) : null;
}

export async function createAdminSession(adminId: number): Promise<{ token: string; expiresAt: Date }> {
  const db = getDb();
  await db.prepare("DELETE FROM admin_sessions WHERE expires_at < datetime('now')").run();
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  await db.prepare("INSERT INTO admin_sessions (token, admin_id, expires_at) VALUES (?, ?, ?)").run(
    sessionKey(token),
    adminId,
    sessionExpiry(expiresAt)
  );
  await markSeen(adminId);
  return { token, expiresAt };
}

export async function destroyAdminSession(token: string): Promise<void> {
  await getDb().prepare("DELETE FROM admin_sessions WHERE token = ?").run(sessionKey(token));
}

export async function getAdminByToken(token: string): Promise<Admin | null> {
  const row = await getDb()
    .prepare(`
      SELECT ${ADMIN_COLUMNS} FROM admin_sessions s
      JOIN ${ADMIN_FROM} ON a.id = s.admin_id
      WHERE s.token = ? AND s.expires_at >= datetime('now')
    `)
    .get(sessionKey(token)) as AdminRow | undefined;
  return row ? await toAdmin(row) : null;
}

export async function getSessionAdmin(req: NextRequest): Promise<Admin | null> {
  const token = req.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) return null;
  const admin = await getAdminByToken(token);
  if (admin) await markSeen(admin.id);
  return admin;
}

/**
 * Note that somebody is still using their account — at most once a day, so
 * it is not a write on every request. A draft nobody comes back to is
 * cleared away by it (lib/drafts.ts).
 */
async function markSeen(adminId: number): Promise<void> {
  await getDb()
    .prepare(
      `UPDATE admins SET last_seen_at = datetime('now')
        WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-1 day'))`
    )
    .run(adminId);
}

/**
 * Resolve the signed-in admin, or a 401 response to return directly:
 *   const admin = requireAdmin(req);
 *   if (admin instanceof NextResponse) return admin;
 */
export async function requireAdmin(req: NextRequest): Promise<Admin | NextResponse> {
  const admin = await getSessionAdmin(req);
  if (!admin) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  // Where the install requires two-factor sign-in, an account without it may
  // only set it up (the routes under /api/admin/auth) until it has.
  if (twoFactorRequired(admin) && !req.nextUrl.pathname.startsWith("/api/admin/auth/") && !(await hasTwoFactor(admin.id)))
    return NextResponse.json(
      { error: "Set up two-factor sign-in for this account first.", code: "TWO_FACTOR_REQUIRED" },
      { status: 403 }
    );
  // Front desk is turned away from what only a manager does, here, for every route.
  return deskRefusal(admin.role, req.method, req.nextUrl.pathname) ?? admin;
}

export function isOwner(admin: Pick<Admin, "venueId" | "businessId">): boolean {
  return admin.venueId === null && admin.businessId === null;
}

/** Runs a business: every branch of it, and its staff. */
export function isManager(admin: Pick<Admin, "businessId">): boolean {
  return admin.businessId !== null;
}

export function canAccessVenue(admin: Admin, venueId: number): boolean {
  return isOwner(admin) || (admin.venueIds ?? []).includes(venueId);
}

/** 403 response when this admin may not touch `venueId`, else null. */
export function denyVenue(admin: Admin, venueId: number): NextResponse | null {
  if (canAccessVenue(admin, venueId)) return null;
  return NextResponse.json({ error: "You do not manage that venue." }, { status: 403 });
}

export function requireOwner(admin: Admin): NextResponse | null {
  if (isOwner(admin)) return null;
  return NextResponse.json({ error: "Only the platform owner can do that." }, { status: 403 });
}

export type CreateAdminResult = { ok: true; admin: Admin } | { ok: false; error: string };

export async function createAdmin(input: {
  name: string;
  email: string;
  password: string;
  /** Branch staff at this venue. */
  venueId: number | null;
  /** A manager of this whole business. Neither: another platform owner. */
  businessId?: number | null;
  /** Branch staff only: a manager (the default), or front desk. */
  role?: StaffRole;
}): Promise<CreateAdminResult> {
  return withTransaction(async () => {
    const db = getDb();
    const clash = await db.prepare("SELECT id FROM admins WHERE email = ?").get(input.email.trim());
    if (clash) return { ok: false, error: "An admin with this email already exists." };

    const info = await db
      .prepare("INSERT INTO admins (name, email, password_hash, venue_id, business_id, role) VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        input.name.trim(),
        input.email.trim(),
        hashPassword(input.password),
        input.venueId,
        input.venueId === null ? (input.businessId ?? null) : null,
        input.venueId !== null && input.role === "desk" ? "desk" : "manager"
      );
    const row = await db
      .prepare(`SELECT ${ADMIN_COLUMNS} FROM ${ADMIN_FROM} WHERE a.id = ?`)
      .get(info.lastInsertRowid) as AdminRow;
    return { ok: true, admin: await toAdmin(row) };
  });
}

/** Make a member of branch staff a manager or front desk. */
export async function setStaffRole(adminId: number, role: StaffRole): Promise<void> {
  await getDb().prepare("UPDATE admins SET role = ? WHERE id = ? AND venue_id IS NOT NULL").run(role, adminId);
}

/** Platform owners first, then business managers, then branch staff. */
export async function listAdmins(): Promise<Admin[]> {
  const rows = await getDb()
    .prepare(
      `SELECT ${ADMIN_COLUMNS} FROM ${ADMIN_FROM}
        ORDER BY a.business_id IS NOT NULL OR a.venue_id IS NOT NULL, a.venue_id IS NOT NULL, a.id`
    )
    .all() as AdminRow[];
  return await toAdmins(rows);
}

/** The accounts that work at this admin's venues: what a business manager sees and manages. */
export async function listAdminsFor(admin: Admin): Promise<Admin[]> {
  if (isOwner(admin)) return await listAdmins();
  const venues = admin.venueIds ?? [];
  return (await listAdmins()).filter(
    (a) =>
      (admin.businessId !== null && a.businessId === admin.businessId) ||
      (a.venueId !== null && venues.includes(a.venueId))
  );
}

export async function deleteAdmin(id: number): Promise<{ ok: boolean; error?: string }> {
  return withTransaction(async () => {
    const db = getDb();
    const row = await db.prepare("SELECT venue_id, business_id FROM admins WHERE id = ?").get(id) as
      | { venue_id: number | null; business_id: number | null }
      | undefined;
    if (!row) return { ok: false, error: "Admin not found." };
    if (row.venue_id === null && row.business_id === null) {
      const owners = await db
        .prepare("SELECT COUNT(*) AS n FROM admins WHERE venue_id IS NULL AND business_id IS NULL")
        .get() as { n: number };
      if (owners.n <= 1) return { ok: false, error: "Cannot remove the last platform owner." };
    }
    if (row.business_id !== null) {
      const managers = await db
        .prepare("SELECT COUNT(*) AS n FROM admins WHERE business_id = ?")
        .get(row.business_id) as { n: number };
      if (managers.n <= 1) return { ok: false, error: "A business needs at least one manager." };
    }
    await db.prepare("DELETE FROM admins WHERE id = ?").run(id);
    return { ok: true };
  });
}
