import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getDb, withTransaction } from "./db";
import { hashPassword, verifyPassword } from "./auth";

export const ADMIN_SESSION_COOKIE = "ms_admin";
const SESSION_DAYS = 7;

export interface Admin {
  id: number;
  name: string;
  email: string;
  /** null = platform owner, who can manage every venue. */
  venueId: number | null;
}

interface AdminRow extends Admin {
  venue_id: number | null;
  password_hash: string;
}

function toAdmin(r: AdminRow): Admin {
  return { id: r.id, name: r.name, email: r.email, venueId: r.venue_id };
}

/**
 * Create the first platform owner if none exists, so a fresh install is
 * reachable. Credentials come from ADMIN_EMAIL / ADMIN_PASSWORD.
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  const db = getDb();
  const existing = await db.prepare("SELECT COUNT(*) AS n FROM admins").get() as { n: number };
  if (existing.n > 0) return;

  await db.prepare(
    "INSERT INTO admins (name, email, password_hash, venue_id) VALUES (?, ?, ?, NULL)"
  ).run(
    "Platform Owner",
    process.env.ADMIN_EMAIL || "admin@mysenam.my",
    hashPassword(process.env.ADMIN_PASSWORD || "mysenam-admin")
  );
}

export async function authenticateAdmin(email: string, password: string): Promise<Admin | null> {
  await ensureBootstrapAdmin();
  const row = await getDb()
    .prepare("SELECT id, name, email, venue_id, password_hash FROM admins WHERE email = ?")
    .get(email.trim()) as AdminRow | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  return toAdmin(row);
}

export async function createAdminSession(adminId: number): Promise<{ token: string; expiresAt: Date }> {
  const db = getDb();
  await db.prepare("DELETE FROM admin_sessions WHERE expires_at < datetime('now')").run();
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  await db.prepare("INSERT INTO admin_sessions (token, admin_id, expires_at) VALUES (?, ?, ?)").run(
    token,
    adminId,
    expiresAt.toISOString()
  );
  return { token, expiresAt };
}

export async function destroyAdminSession(token: string): Promise<void> {
  await getDb().prepare("DELETE FROM admin_sessions WHERE token = ?").run(token);
}

export async function getAdminByToken(token: string): Promise<Admin | null> {
  const row = await getDb()
    .prepare(`
      SELECT a.id, a.name, a.email, a.venue_id FROM admin_sessions s
      JOIN admins a ON a.id = s.admin_id
      WHERE s.token = ? AND s.expires_at >= datetime('now')
    `)
    .get(token) as AdminRow | undefined;
  return row ? toAdmin(row) : null;
}

export async function getSessionAdmin(req: NextRequest): Promise<Admin | null> {
  const token = req.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) return null;
  return await getAdminByToken(token);
}

/**
 * Resolve the signed-in admin, or a 401 response to return directly:
 *   const admin = requireAdmin(req);
 *   if (admin instanceof NextResponse) return admin;
 */
export async function requireAdmin(req: NextRequest): Promise<Admin | NextResponse> {
  const admin = await getSessionAdmin(req);
  if (!admin) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  return admin;
}

export function isOwner(admin: Admin): boolean {
  return admin.venueId === null;
}

export function canAccessVenue(admin: Admin, venueId: number): boolean {
  return isOwner(admin) || admin.venueId === venueId;
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
  venueId: number | null;
}): Promise<CreateAdminResult> {
  return withTransaction(async () => {
    const db = getDb();
    const clash = await db.prepare("SELECT id FROM admins WHERE email = ?").get(input.email.trim());
    if (clash) return { ok: false, error: "An admin with this email already exists." };

    const info = await db
      .prepare("INSERT INTO admins (name, email, password_hash, venue_id) VALUES (?, ?, ?, ?)")
      .run(input.name.trim(), input.email.trim(), hashPassword(input.password), input.venueId);
    const row = await db
      .prepare("SELECT id, name, email, venue_id FROM admins WHERE id = ?")
      .get(info.lastInsertRowid) as AdminRow;
    return { ok: true, admin: toAdmin(row) };
  });
}

export async function listAdmins(): Promise<Admin[]> {
  const rows = await getDb()
    .prepare("SELECT id, name, email, venue_id FROM admins ORDER BY venue_id IS NOT NULL, id")
    .all() as AdminRow[];
  return rows.map(toAdmin);
}

export async function deleteAdmin(id: number): Promise<{ ok: boolean; error?: string }> {
  return withTransaction(async () => {
    const db = getDb();
    const row = await db.prepare("SELECT venue_id FROM admins WHERE id = ?").get(id) as
      | { venue_id: number | null }
      | undefined;
    if (!row) return { ok: false, error: "Admin not found." };
    if (row.venue_id === null) {
      const owners = await db
        .prepare("SELECT COUNT(*) AS n FROM admins WHERE venue_id IS NULL")
        .get() as { n: number };
      if (owners.n <= 1) return { ok: false, error: "Cannot remove the last platform owner." };
    }
    await db.prepare("DELETE FROM admins WHERE id = ?").run(id);
    return { ok: true };
  });
}
