import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { createAdmin } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { reviewGuardian } from "../src/lib/guardian-requests";
import { addManaged } from "../src/lib/managed-people";
import { acceptInvite, createInvite } from "../src/lib/participants";
import { phoneNumber } from "../src/lib/phone-check";
import { exportCustomerData } from "../src/lib/privacy";
import { createResources } from "../src/lib/resources";
import { createVenue, sellMembership } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as bookingsRoute from "../src/app/api/bookings/route";

/**
 * What an account's data export holds about the participants it acts for
 * (lib/participants.ts participantsExport, lib/privacy.ts exportCustomerData;
 * docs/architecture/privacy.md#participants): concession proofs as
 * structured records (never a card, number or file), who saw them by role
 * only; a child shared by two guardians appears whole in each one's export
 * whose relationship stands, and in a paused guardian's only as the
 * relationship. The round-4 records too: guardian requests, places taken off
 * a booking, benefits per place, and whose each pass and membership is.
 */

let n = 0;
const phone = () => `0166${String(++n).padStart(6, "0")}`;
let venue: number;
let hall: number;
let desk: number;
let manager: number;

async function adult(name: string) {
  const ph = phone();
  const made = await registerUser({ name, email: `px${++n}@px.test`, phone: ph, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = ? WHERE id = ?").run(phoneNumber(ph), made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

beforeAll(async () => {
  const v = await createVenue({ name: "Export Arena", area: "Bangsar", address: "x", phone: "0312350701", openMin: 7 * 60, closeMin: 23 * 60 });
  if (!v.ok) throw new Error("venue");
  venue = v.venue.id;
  const r = await createResources({ venueId: venue, sport: "badminton", name: "Court X", offPeakRate: 20, peakRate: 20 });
  if (!r.ok) throw new Error(r.error);
  hall = r.courts[0].id;
  const d = await createAdmin({ name: "Dina Desk", email: "dina@px.test", password: "a long enough password", venueId: venue, role: "desk" });
  const m = await createAdmin({ name: "Mahmud Manager", email: "mahmud@px.test", password: "a long enough password", venueId: venue, role: "manager" });
  if (!d.ok || !m.ok) throw new Error("staff");
  desk = d.admin.id;
  manager = m.admin.id;
});

async function concession(name: string, preset: string) {
  return ((await getDb()
    .prepare("INSERT INTO concessions (venue_id, name, percent, proof, preset) VALUES (?, ?, 20, 'A card', ?) RETURNING id")
    .get(venue, name, preset)) as { id: number }).id;
}

describe("concession proofs in the export", () => {
  it("a participant's, as structured records, in every standing guardian's export; never who by name, never a file", async () => {
    const mum = await adult("Puan Mira");
    const dad = await adult("Encik Mira");
    const stranger = await adult("Stranger");
    const made = await addManaged(mum.id, { displayName: "Mira", birthYear: 2014, relationship: "parent", authority: true }, mum.name);
    if (!made.ok) throw new Error(made.error);
    const kid = made.person.id;
    const { code } = (await createInvite(mum, kid, "guardian")) as { code: string };
    expect(await acceptInvite(dad, { code, relationship: "parent", authority: true })).toMatchObject({ ok: true, as: "guardian" });

    const student = await concession("Student", "student");
    const junior = await concession("Junior", "child");
    const today = todayISO();
    await getDb()
      .prepare("INSERT INTO participant_concession_proofs (venue_id, participant_id, concession_id, seen_by, seen_on, valid_until) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)")
      .run(venue, kid, student, desk, today, addDays(today, 180), venue, kid, junior, manager, addDays(today, -400), addDays(today, -35));
    // The mother's own, against her number, seen by the manager.
    await getDb()
      .prepare("INSERT INTO concession_proofs (venue_id, phone_key, concession_id, seen_by, seen_on, valid_until) VALUES (?, phone_key(?), ?, ?, ?, ?)")
      .run(venue, mum.phone, student, manager, today, addDays(today, 90));

    const expected = [
      { concession: "Junior", concession_type: "child", venue: "Export Arena", verified_on: addDays(today, -400), expires_on: addDays(today, -35), status: "expired", verified_by: "manager" },
      { concession: "Student", concession_type: "student", venue: "Export Arena", verified_on: today, expires_on: addDays(today, 180), status: "current", verified_by: "front desk" },
    ];
    const mums = (await exportCustomerData(mum.id))!;
    const dads = (await exportCustomerData(dad.id))!;
    for (const exported of [mums, dads]) {
      const managed = exported.managedPeople as { name: string; concessionProofs: unknown[] }[];
      expect(managed).toHaveLength(1);
      expect(managed[0].name).toBe("Mira");
      expect(managed[0].concessionProofs).toEqual(expected);
      const text = JSON.stringify(exported);
      for (const never of ["Dina Desk", "Mahmud Manager", "base64", "fileName", "A card"]) expect(text).not.toContain(never);
    }
    expect(mums.concessionProofs).toEqual([
      { venue: "Export Arena", concession: "Student", concession_type: "student", seen_on: today, valid_until: addDays(today, 90), status: "current", verified_by: "manager" },
    ]);
    expect(dads.concessionProofs).toEqual([]);
    const strangers = (await exportCustomerData(stranger.id))!;
    expect(strangers.managedPeople).toEqual([]);
    expect(JSON.stringify(strangers)).not.toContain("Mira");

    // Paused for a review: the father's export keeps the relationship only, nothing of the child.
    const dadRel = (await getDb().prepare("SELECT id FROM participant_guardians WHERE participant_id = ? AND user_id = ?").get(kid, dad.id)) as { id: number };
    expect(await reviewGuardian({ owner: true }, { id: null, name: "Platform owner" }, kid, dadRel.id, "suspend", "Mother reports a mistake")).toEqual({ ok: true });
    const paused = (await exportCustomerData(dad.id))!;
    expect(paused.managedPeople).toEqual([]);
    expect(paused.guardianshipsPaused).toEqual([{ relationship: "parent", created_at: expect.anything(), suspended_at: expect.anything() }]);
    expect(JSON.stringify(paused.guardianshipsPaused)).not.toContain("Mira");
    // The request that made him a guardian: his part and its outcome; the child's name no longer, while paused.
    expect(paused.guardianRequests).toEqual([expect.objectContaining({ role: "accepted", status: "active", declared_relationship: "parent", participant: null })]);
    expect((await exportCustomerData(mum.id))!.guardianRequests).toEqual([
      expect.objectContaining({ role: "started", status: "active", declared_relationship: null, participant: "Mira" }),
    ]);
  });
});

describe("the round-4 records in the export", () => {
  it("places taken off a booking, benefits per place, and whose each membership is", async () => {
    const mum = await adult("Puan Nur");
    const made = await addManaged(mum.id, { displayName: "Nurin", birthYear: 2015, relationship: "parent", authority: true }, mum.name);
    if (!made.ok) throw new Error(made.error);
    const kid = made.person.id;
    const res = await bookingsRoute.POST(
      new NextRequest("http://localhost/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: mum.cookie, "x-forwarded-for": "10.66.1.1" },
        body: JSON.stringify({ courtId: hall, date: addDays(todayISO(), 6), start: 9 * 60, end: 10 * 60, name: mum.name, phone: mum.phone, participantIds: [kid] }),
      })
    );
    expect(res.status).toBe(201);
    const booking = (await getDb().prepare("SELECT b.id, b.code FROM bookings b WHERE b.user_id = ? ORDER BY b.id DESC LIMIT 1").get(mum.id)) as { id: number; code: string };
    const place = (await getDb().prepare("SELECT id FROM booking_participants WHERE booking_id = ? AND participant_id = ?").get(booking.id, kid)) as { id: number };
    const student = await concession("Student rate", "student");
    // Structured rows as the counter and the withdrawal write them (lib/entitlements.ts, lib/place-withdrawals.ts).
    await getDb()
      .prepare(
        "INSERT INTO place_benefits (booking_id, place_id, participant_id, kind, concession_id, concession_name, amount, proof_check) VALUES (?, ?, ?, 'concession', ?, 'Student rate', 4, 'seen')"
      )
      .run(booking.id, place.id, kid, student);
    await getDb()
      .prepare(
        `INSERT INTO place_withdrawals (booking_id, place_id, takes_part_as, participant_id, name, places, price, paid, refunded, by_kind, by_user_id, by_name, reason)
         VALUES (?, ?, 'participant', ?, 'Nurin', 1, 16, false, 0, 'customer', ?, ?, 'Unwell')`
      )
      .run(booking.id, place.id, kid, mum.id, mum.name);
    const sold = await sellMembership({
      venueId: venue,
      holderName: mum.name,
      holderPhone: mum.phone,
      startsOn: todayISO(),
      expiresOn: addDays(todayISO(), 60),
      price: 50,
      adminId: desk,
      userId: mum.id,
      holderParticipantId: kid,
    });
    if (!sold.ok) throw new Error(sold.error);

    const exported = (await exportCustomerData(mum.id))!;
    expect(exported.placeWithdrawals).toEqual([
      expect.objectContaining({ booking: booking.code, venue: "Export Arena", takes_part_as: "participant", name: "Nurin", withdrawn_by: "customer", reason: "Unwell" }),
    ]);
    expect(exported.placeBenefits).toEqual([expect.objectContaining({ booking: booking.code, place: "Nurin", kind: "concession", concession_name: "Student rate", proof_check: "seen" })]);
    expect(exported.memberships).toEqual([expect.objectContaining({ holder_kind: "participant", holder_participant: "Nurin" })]);
    const nurin = (exported.managedPeople as Record<string, unknown[]>[])[0];
    expect(nurin.placesWithdrawn).toEqual([expect.objectContaining({ venue: "Export Arena", reason: "Unwell", withdrawn_by: "customer" })]);
    expect(nurin.placeBenefits).toEqual([expect.objectContaining({ kind: "concession", concession_name: "Student rate" })]);
    expect(nurin.memberships).toEqual([expect.objectContaining({ venue: "Export Arena", as_member: "holder" })]);
    expect(JSON.stringify(exported.placeWithdrawals)).not.toContain(mum.name);
  });
});
