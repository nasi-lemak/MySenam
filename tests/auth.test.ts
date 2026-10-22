import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import {
  authenticate,
  createSession,
  destroySession,
  getUserByToken,
  hashPassword,
  registerUser,
  verifyPassword,
} from "../src/lib/auth";
import { createAdminSession, ensureBootstrapAdmin, getAdminByToken, listAdmins } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { cancelUserBooking, createBooking, listUserBookings, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

describe("passwords", () => {
  it("hashes with a unique salt and verifies correctly", () => {
    const a = hashPassword("rahsia-123");
    const b = hashPassword("rahsia-123");
    expect(a).not.toBe(b);
    expect(verifyPassword("rahsia-123", a)).toBe(true);
    expect(verifyPassword("wrong", a)).toBe(false);
    expect(verifyPassword("rahsia-123", "malformed")).toBe(false);
  });
});

describe("registration and login", () => {
  it("registers once per email (case-insensitive) and authenticates", async () => {
    const result = await registerUser({
      name: "Nurul",
      email: "nurul@example.com",
      phone: "0129998888",
      password: "rahsia-123",
    });
    expect(result.ok).toBe(true);

    expect(
      await registerUser({ name: "N2", email: "NURUL@example.com", phone: "01", password: "password1" })
    ).toMatchObject({ ok: false, error: expect.stringContaining("already exists") });

    expect(await authenticate("nurul@example.com", "rahsia-123")).toMatchObject({ name: "Nurul" });
    expect(await authenticate("nurul@example.com", "wrong")).toBeNull();
    expect(await authenticate("nobody@example.com", "rahsia-123")).toBeNull();
  });
});

describe("sessions", () => {
  it("round-trips a session token and destroys it", async () => {
    const user = await registerUser({
      name: "Sesi",
      email: "sesi@example.com",
      phone: "0121112222",
      password: "password1",
    });
    expect(user.ok).toBe(true);
    if (!user.ok) return;

    const { token } = await createSession(user.user.id);
    expect(await getUserByToken(token)).toMatchObject({ email: "sesi@example.com" });
    expect(await getUserByToken("not-a-token")).toBeNull();
    await destroySession(token);
    expect(await getUserByToken(token)).toBeNull();
  });
});

describe("a session that has run out", () => {
  afterEach(() => vi.useRealTimers());

  /** Made long enough ago that it ran out a minute ago. */
  async function lapsed<T>(days: number, make: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - days * 86_400_000 - 60_000);
    try {
      return await make();
    } finally {
      vi.useRealTimers();
    }
  }

  it("is refused at once, not at the end of its day", async () => {
    const user = await registerUser({ name: "Lapsed", email: "lapsed@example.com", phone: "0121113333", password: "password1" });
    if (!user.ok) throw new Error(user.error);
    const { token } = await lapsed(30, () => createSession(user.user.id));
    expect(await getUserByToken(token)).toBeNull();
  });

  it("issued before tokens were hashed, still works once the migration has run", async () => {
    const user = await registerUser({ name: "Old Session", email: "old@example.com", phone: "0121114444", password: "password1" });
    if (!user.ok) throw new Error(user.error);
    const token = "a".repeat(64);
    const later = new Date(Date.now() + 86_400_000).toISOString();
    await getDb().prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, user.user.id, later);
    const migration = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "0086_session_tokens.sql"), "utf8");
    // Run against this one row only, so the suite's other sessions are left alone.
    await getDb().exec(migration.replace(/;\s*$/gm, ` WHERE token = '${token}';`));
    expect(await getUserByToken(token)).toMatchObject({ email: "old@example.com" });
    const stored = (await getDb().prepare("SELECT token, expires_at FROM sessions WHERE user_id = ?").get(user.user.id)) as { token: string; expires_at: string };
    expect(stored.token).not.toBe(token);
    expect(stored.expires_at).toBe(later.replace("T", " ").slice(0, 19));
  });

  it("is refused at once for staff too", async () => {
    await ensureBootstrapAdmin();
    const admin = (await listAdmins())[0];
    const { token } = await lapsed(7, () => createAdminSession(admin.id));
    expect(await getAdminByToken(token)).toBeNull();
  });
});

describe("user bookings", () => {
  it("lists only the owner's bookings and enforces ownership on cancel", async () => {
    const owner = await registerUser({
      name: "Owner",
      email: "owner@example.com",
      phone: "0123334444",
      password: "password1",
    });
    const other = await registerUser({
      name: "Other",
      email: "other@example.com",
      phone: "0125556666",
      password: "password1",
    });
    expect(owner.ok && other.ok).toBe(true);
    if (!owner.ok || !other.ok) return;

    const court = (await listVenues())[0].courts[0];
    const date = addDays(todayISO(), 3);
    const booking = await createBooking({
      courtId: court.id,
      date,
      hours: [10],
      name: "Owner",
      phone: "0123334444",
      userId: owner.user.id,
    });
    expect(booking.ok).toBe(true);
    if (!booking.ok) return;

    expect(await listUserBookings(owner.user.id)).toHaveLength(1);
    expect(await listUserBookings(other.user.id)).toHaveLength(0);

    expect(await cancelUserBooking(other.user.id, booking.booking.id)).toMatchObject({
      ok: false,
      error: "Booking not found.",
    });
    expect(await cancelUserBooking(owner.user.id, booking.booking.id)).toMatchObject({ ok: true });
  });
});
