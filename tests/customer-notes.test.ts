import fs from "fs";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { customerNote, MAX_NOTE, noteHistory, setCustomerNote } from "../src/lib/customer-notes";
import { getDb } from "../src/lib/db";
import { eraseCustomer, exportCustomerData, exportPhoneData } from "../src/lib/privacy";
import { createBooking, createCourt, createVenue, listBookingsForDate } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { GET as noteGet, POST as noteRoute } from "../src/app/api/admin/customer-notes/route";

/** A venue's own note on a customer: on their bookings, in their data, gone with their account. */

let venueId: number;
let otherVenue: number;
let courtId: number;
const date = addDays(todayISO(), 2);

beforeAll(async () => {
  const made = await createVenue({ name: "Pusat Sukan", area: "Kajang", address: "x", phone: "0388881111" });
  const other = await createVenue({ name: "Elsewhere", area: "Ipoh", address: "x", phone: "0588881111" });
  if (!made.ok || !other.ok) throw new Error("venue");
  venueId = made.venue.id;
  otherVenue = other.venue.id;
  const c = await createCourt({ venueId, name: "Court 3", sport: "badminton", offPeakRate: 20, peakRate: 30 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
});

describe("a note on a customer", () => {
  it("is one per number at the venue, however the number is typed, and shows on their bookings", async () => {
    expect(await setCustomerNote(venueId, "012-777 8888", "x".repeat(MAX_NOTE + 1), null)).toMatchObject({ ok: false });
    expect((await setCustomerNote(venueId, "012-777 8888", "Prefers Court 3. Pays by transfer.", null)).ok).toBe(true);
    expect((await customerNote(venueId, "+60127778888"))?.note).toBe("Prefers Court 3. Pays by transfer.");
    expect(await customerNote(otherVenue, "0127778888")).toBeNull();
    const b = await createBooking({ courtId, date, hours: [10], name: "Farah", phone: "60127778888" });
    if (!b.ok) throw new Error(b.error);
    const row = (await listBookingsForDate(date, venueId)).find((r) => r.code === b.booking.code);
    expect(row?.staffNote).toBe("Prefers Court 3. Pays by transfer.");
  });

  it("is written by the desk, only at its own venue; empty, it goes", async () => {
    const desk = await createAdmin({ name: "Desk", email: "desk@pusat.my", password: "desk-password-1", venueId, role: "desk" });
    if (!desk.ok) throw new Error(desk.error);
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const post = (body: unknown) =>
      noteRoute(new NextRequest("http://localhost/api/admin/customer-notes", { method: "POST", headers: { cookie }, body: JSON.stringify(body) }));
    const res = await post({ venueId, phone: "0127778888", note: "Bring the ramp out." });
    expect(res.status).toBe(200);
    expect((await res.json()).note).toMatchObject({ note: "Bring the ramp out.", updatedBy: "Desk" });
    expect((await post({ venueId: otherVenue, phone: "0127778888", note: "x" })).status).toBe(403);
    expect((await post({ venueId, phone: "0127778888", note: "" })).status).toBe(200);
    expect(await customerNote(venueId, "0127778888")).toBeNull();
  });

  it("goes out with the customer's data, and is erased with their account", async () => {
    await setCustomerNote(venueId, "0127778888", "Bring the ramp out.", null);
    expect((await exportPhoneData([venueId], "0127778888")).staffNotes).toEqual([expect.objectContaining({ note: "Bring the ramp out." })]);
    const u = await registerUser({ name: "Farah", email: "farah@example.com", phone: "012-777 8888", password: "password-123" });
    if (!u.ok) throw new Error(u.error);
    expect((await exportCustomerData(u.user.id))?.staffNotes).toEqual([expect.objectContaining({ venue: "Pusat Sukan", note: "Bring the ramp out." })]);
    await eraseCustomer(u.user.id);
    expect(await customerNote(venueId, "0127778888")).toBeNull();
  });
});

/**
 * A note keeps its history (ADR 0064, audit D24): each write, change and erase is a row, in the same transaction, naming who and the text
 * before and after; the venue's staff read it as they read the note, nobody else does; it goes out with the customer's data and is erased with it.
 */
describe("the history of a note", () => {
  const who = "0165550101";
  it("keeps what each write, change and erase did, and who, and nothing for a save that changes nothing", async () => {
    const desk = await createAdmin({ name: "Hist Desk", email: "hist-desk@pusat.my", password: "desk-password-1", venueId, role: "desk" });
    const mgr = await createAdmin({ name: "Hist Manager", email: "hist-mgr@pusat.my", password: "mgr-password-1", venueId, role: "manager" });
    if (!desk.ok || !mgr.ok) throw new Error("staff");
    expect((await setCustomerNote(venueId, who, "Prefers Court 3.", desk.admin.id)).ok).toBe(true);
    expect((await setCustomerNote(venueId, who, "Prefers Court 3.", mgr.admin.id)).ok).toBe(true);
    expect((await setCustomerNote(venueId, "0165-550101", "Prefers Court 4. Late payer.", mgr.admin.id)).ok).toBe(true);
    expect((await setCustomerNote(venueId, who, "", desk.admin.id)).ok).toBe(true);
    // Clearing what is not there is no change either.
    expect((await setCustomerNote(venueId, who, "   ", desk.admin.id)).ok).toBe(true);
    const history = await noteHistory(venueId, who);
    expect(history.map((h) => [h.action, h.previous, h.note, h.changedBy])).toEqual([
      ["erased", "Prefers Court 4. Late payer.", null, "Hist Desk"],
      ["edited", "Prefers Court 3.", "Prefers Court 4. Late payer.", "Hist Manager"],
      ["written", null, "Prefers Court 3.", "Hist Desk"],
    ]);
    expect(await customerNote(venueId, who)).toBeNull();
    // Rows are appended, never edited.
    await expect(getDb().prepare("UPDATE customer_note_history SET new_note = 'tampered' WHERE venue_id = ?").run(venueId)).rejects.toThrow(/not changed/);
  });

  it("holds every change when several are made at once, each naming the text it replaced", async () => {
    const phone = "0165550202";
    await Promise.all(Array.from({ length: 12 }, (_, i) => setCustomerNote(venueId, phone, `Version ${i + 1}`, null)));
    const rows = (await getDb()
      .prepare("SELECT previous_note, new_note FROM customer_note_history WHERE venue_id = ? AND phone_key = phone_key(?) ORDER BY id")
      .all(venueId, phone)) as { previous_note: string | null; new_note: string }[];
    expect(rows).toHaveLength(12);
    expect(rows[0].previous_note).toBeNull();
    for (let i = 1; i < rows.length; i++) expect(rows[i].previous_note).toBe(rows[i - 1].new_note);
    expect((await customerNote(venueId, phone))?.note).toBe(rows[11].new_note);
  });

  it("is read by the staff of that venue, as the note is, and by nobody else", async () => {
    const mine = await createAdmin({ name: "Hist Reader", email: "hist-reader@pusat.my", password: "reader-password-1", venueId, role: "desk" });
    const elsewhere = await createAdmin({ name: "Hist Other", email: "hist-other@elsewhere.my", password: "other-password-1", venueId: otherVenue, role: "manager" });
    if (!mine.ok || !elsewhere.ok) throw new Error("staff");
    const get = async (adminId: number | null, venue: number) =>
      noteGet(
        new NextRequest(`http://localhost/api/admin/customer-notes?venueId=${venue}&phone=${who}&history=1`, {
          headers: adminId === null ? {} : { cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(adminId)).token}` },
        })
      );
    await setCustomerNote(venueId, who, "Wears a brace.", mine.admin.id);
    const own = await get(mine.admin.id, venueId);
    expect(own.status).toBe(200);
    expect((await own.json()).history[0]).toMatchObject({ action: "written", note: "Wears a brace.", changedBy: "Hist Reader" });
    expect((await get(elsewhere.admin.id, venueId)).status).toBe(403);
    expect((await get(null, venueId)).status).toBe(401);
    // Without asking for it, only the note comes.
    const plain = await noteGet(
      new NextRequest(`http://localhost/api/admin/customer-notes?venueId=${venueId}&phone=${who}`, { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(mine.admin.id)).token}` } })
    );
    expect(Object.keys(await plain.json())).toEqual(["note"]);
    expect((await get(mine.admin.id, otherVenue)).status).toBe(403);
  });

  it("goes out with the customer's data, and is erased with the account", async () => {
    const phone = "0165550303";
    await setCustomerNote(venueId, phone, "First thing.", null);
    await setCustomerNote(venueId, phone, "Second thing.", null);
    const u = await registerUser({ name: "Hist Customer", email: "hist-customer@example.com", phone, password: "password-123" });
    if (!u.ok) throw new Error(u.error);
    const out = await exportCustomerData(u.user.id);
    expect(out?.staffNoteHistory).toEqual([
      expect.objectContaining({ venue: "Pusat Sukan", action: "written", new_note: "First thing." }),
      expect.objectContaining({ action: "edited", previous_note: "First thing.", new_note: "Second thing." }),
    ]);
    expect((await exportPhoneData([venueId], phone)).staffNoteHistory).toHaveLength(2);
    await eraseCustomer(u.user.id);
    expect(await getDb().prepare("SELECT 1 FROM customer_note_history WHERE phone_key = phone_key(?)").get(phone)).toBeUndefined();
    expect(await customerNote(venueId, phone)).toBeNull();
  });

  it("starts for a note from before as it stands, once, and is not made up: the migration's backfill from a legacy-shaped state", async () => {
    const phone = "0165550404";
    const mgr = await createAdmin({ name: "Hist Legacy", email: "hist-legacy@pusat.my", password: "legacy-password-1", venueId, role: "manager" });
    if (!mgr.ok) throw new Error("staff");
    // A note as it was before migration 0314: a row, and no history.
    await getDb().prepare("INSERT INTO customer_notes (venue_id, phone_key, note, updated_by, updated_at) VALUES (?, phone_key(?), 'Old note', ?, '2026-10-01 09:30:00')").run(venueId, phone, mgr.admin.id);
    expect(await noteHistory(venueId, phone)).toEqual([]);
    const sql = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "0314_customer_note_history.sql"), "utf8");
    const backfill = sql.slice(sql.indexOf("INSERT INTO customer_note_history"));
    await getDb().exec(backfill);
    await getDb().exec(backfill);
    const history = await noteHistory(venueId, phone);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ action: "baseline", previous: null, note: "Old note", changedBy: "Hist Legacy" });
    expect(history[0].changedAt).toContain("2026-10-01");
    // From then on it carries on as any note does.
    await setCustomerNote(venueId, phone, "New note", mgr.admin.id);
    expect((await noteHistory(venueId, phone)).map((h) => h.action)).toEqual(["edited", "baseline"]);
  });
});
