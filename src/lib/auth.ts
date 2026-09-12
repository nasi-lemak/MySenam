import crypto from "crypto";
import { NextRequest } from "next/server";
import { getDb } from "./db";

export const SESSION_COOKIE = "mt_session";
const SESSION_DAYS = 30;

export interface User {
  id: number;
  name: string;
  email: string;
  phone: string;
}

interface UserRow extends User {
  password_hash: string;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), test);
}

export type RegisterResult = { ok: true; user: User } | { ok: false; error: string };

export function registerUser(input: {
  name: string;
  email: string;
  phone: string;
  password: string;
}): RegisterResult {
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(input.email.trim()) as { id: number } | undefined;
  if (existing) return { ok: false, error: "An account with this email already exists." };

  const info = db
    .prepare("INSERT INTO users (name, email, phone, password_hash) VALUES (?, ?, ?, ?)")
    .run(input.name.trim(), input.email.trim(), input.phone.trim(), hashPassword(input.password));
  const user = db
    .prepare("SELECT id, name, email, phone FROM users WHERE id = ?")
    .get(info.lastInsertRowid) as User;
  return { ok: true, user };
}

export function authenticate(email: string, password: string): User | null {
  const db = getDb();
  const row = db
    .prepare("SELECT id, name, email, phone, password_hash FROM users WHERE email = ?")
    .get(email.trim()) as UserRow | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  return { id: row.id, name: row.name, email: row.email, phone: row.phone };
}

export function createSession(userId: number): { token: string; expiresAt: Date } {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(
    token,
    userId,
    expiresAt.toISOString()
  );
  return { token, expiresAt };
}

export function destroySession(token: string) {
  getDb().prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function getUserByToken(token: string): User | null {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT u.id, u.name, u.email, u.phone FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at >= datetime('now')
    `)
    .get(token) as User | undefined;
  return row ?? null;
}

/** Resolve the logged-in user from the session cookie, or null. */
export function getSessionUser(req: NextRequest): User | null {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getUserByToken(token);
}
