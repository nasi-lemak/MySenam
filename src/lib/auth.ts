import crypto from "crypto";
import { NextRequest } from "next/server";
import { getDb } from "./db";
import { isLocale, LOCALE_COOKIE } from "./i18n";

export const SESSION_COOKIE = "ms_session";
const SESSION_DAYS = 30;

/**
 * What the database keeps of a session token: its SHA-256, so a backup or a
 * read of the table hands out no live sign-in. A plain hash is enough for 32
 * random bytes, and lets a migration convert tokens already issued.
 */
export function sessionKey(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** When a session runs out, in the form datetime('now') compares with. */
export function sessionExpiry(expiresAt: Date): string {
  return expiresAt.toISOString().replace("T", " ").slice(0, 19);
}

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

export async function registerUser(input: {
  name: string;
  email: string;
  phone: string;
  password: string;
}): Promise<RegisterResult> {
  const db = getDb();
  const existing = await db
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(input.email.trim()) as { id: number } | undefined;
  if (existing) return { ok: false, error: "An account with this email already exists." };

  const info = await db
    .prepare("INSERT INTO users (name, email, phone, password_hash) VALUES (?, ?, ?, ?)")
    .run(input.name.trim(), input.email.trim(), input.phone.trim(), hashPassword(input.password));
  const user = await db
    .prepare("SELECT id, name, email, phone FROM users WHERE id = ?")
    .get(info.lastInsertRowid) as User;
  return { ok: true, user };
}

export async function authenticate(email: string, password: string): Promise<User | null> {
  const db = getDb();
  const row = await db
    .prepare("SELECT id, name, email, phone, password_hash FROM users WHERE email = ?")
    .get(email.trim()) as UserRow | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  return { id: row.id, name: row.name, email: row.email, phone: row.phone };
}

export async function createSession(userId: number): Promise<{ token: string; expiresAt: Date }> {
  const db = getDb();
  await db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  await db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(
    sessionKey(token),
    userId,
    sessionExpiry(expiresAt)
  );
  return { token, expiresAt };
}

export async function destroySession(token: string) {
  await getDb().prepare("DELETE FROM sessions WHERE token = ?").run(sessionKey(token));
}

export async function getUserByToken(token: string): Promise<User | null> {
  const found = await userAndLocale(token);
  return found && { id: found.id, name: found.name, email: found.email, phone: found.phone };
}

async function userAndLocale(token: string): Promise<(User & { locale: string | null }) | null> {
  const row = await getDb()
    .prepare(`
      SELECT u.id, u.name, u.email, u.phone, u.locale FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at >= datetime('now')
    `)
    .get(sessionKey(token)) as (User & { locale: string | null }) | undefined;
  return row ?? null;
}

/**
 * Resolve the logged-in user from the session cookie, or null. The language
 * they are using the site in is kept on the account when it changes, so
 * emails sent later (lib/outbox.ts, emailPlayer) are written in it.
 */
export async function getSessionUser(req: NextRequest): Promise<User | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const found = await userAndLocale(token);
  if (!found) return null;
  const { locale, ...user } = found;
  const using = req.cookies.get(LOCALE_COOKIE)?.value;
  if (isLocale(using) && using !== locale) await getDb().prepare("UPDATE users SET locale = ? WHERE id = ?").run(using, user.id);
  return user;
}
