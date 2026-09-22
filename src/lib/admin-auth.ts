import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "./db";
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
export function ensureBootstrapAdmin(): void {
  const db = getDb();
  const existing = db.prepare("SELECT COUNT(*) AS n FROM admins").get() as { n: number };
  if (existing.n > 0) return;

  db.prepare(
    "INSERT INTO admins (name, email, password_hash, venue_id) VALUES (?, ?, ?, NULL)"
  ).run(
    "Platform Owner",
    process.env.ADMIN_EMAIL || "admin@mysenam.my",
    hashPassword(process.env.ADMIN_PASSWORD || "mysenam-admin")
  );
}

export function authenticateAdmin(email: string, password: string): Admin | null {
  ensureBootstrapAdmin();
  const row = getDb()
    .prepare("SELECT id, name, email, venue_id, password_hash FROM admins WHERE email = ?")
    .get(email.trim()) as AdminRow | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  return toAdmin(row);
}

export function createAdminSession(adminId: number): { token: string; expiresAt: Date } {
  const db = getDb();
  db.prepare("DELETE FROM admin_sessions WHERE expires_at < datetime('now')").run();
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  db.prepare("INSERT INTO admin_sessions (token, admin_id, expires_at) VALUES (?, ?, ?)").run(
    token,
    adminId,
    expiresAt.toISOString()
  );
  return { token, expiresAt };
}

export function destroyAdminSession(token: string): void {
  getDb().prepare("DELETE FROM admin_sessions WHERE token = ?").run(token);
}

export function getAdminByToken(token: string): Admin | null {
  const row = getDb()
    .prepare(`
      SELECT a.id, a.name, a.email, a.venue_id FROM admin_sessions s
      JOIN admins a ON a.id = s.admin_id
      WHERE s.token = ? AND s.expires_at >= datetime('now')
    `)
    .get(token) as AdminRow | undefined;
  return row ? toAdmin(row) : null;
}

export function getSessionAdmin(req: NextRequest): Admin | null {
  const token = req.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) return null;
  return getAdminByToken(token);
}

/**
 * Resolve the signed-in admin, or a 401 response to return directly:
 *   const admin = requireAdmin(req);
 *   if (admin instanceof NextResponse) return admin;
 */
export function requireAdmin(req: NextRequest): Admin | NextResponse {
  const admin = getSessionAdmin(req);
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

export function createAdmin(input: {
  name: string;
  email: string;
  password: string;
  venueId: number | null;
}): CreateAdminResult {
  const db = getDb();
  const clash = db.prepare("SELECT id FROM admins WHERE email = ?").get(input.email.trim());
  if (clash) return { ok: false, error: "An admin with this email already exists." };

  const info = db
    .prepare("INSERT INTO admins (name, email, password_hash, venue_id) VALUES (?, ?, ?, ?)")
    .run(input.name.trim(), input.email.trim(), hashPassword(input.password), input.venueId);
  const row = db
    .prepare("SELECT id, name, email, venue_id FROM admins WHERE id = ?")
    .get(info.lastInsertRowid) as AdminRow;
  return { ok: true, admin: toAdmin(row) };
}

export function listAdmins(): Admin[] {
  const rows = getDb()
    .prepare("SELECT id, name, email, venue_id FROM admins ORDER BY venue_id IS NOT NULL, id")
    .all() as AdminRow[];
  return rows.map(toAdmin);
}

export function deleteAdmin(id: number): { ok: boolean; error?: string } {
  const db = getDb();
  const row = db.prepare("SELECT venue_id FROM admins WHERE id = ?").get(id) as
    | { venue_id: number | null }
    | undefined;
  if (!row) return { ok: false, error: "Admin not found." };
  if (row.venue_id === null) {
    const owners = db
      .prepare("SELECT COUNT(*) AS n FROM admins WHERE venue_id IS NULL")
      .get() as { n: number };
    if (owners.n <= 1) return { ok: false, error: "Cannot remove the last platform owner." };
  }
  db.prepare("DELETE FROM admins WHERE id = ?").run(id);
  return { ok: true };
}
