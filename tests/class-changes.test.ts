import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { changeClass } from "../src/lib/class-changes";
import { getDb } from "../src/lib/db";
import {
  createClassSessions,
  createCourt,
  enrolInClass,
  getClass,
  getClassRoster,
  joinClassWaitlist,
  listClassWaitlist,
  listVenues,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { PATCH } from "../src/app/api/admin/classes/[id]/route";

/**
 * Changing a class after it is in the diary (lib/class-changes.ts; X1-12):
 * name, instructor, places and the price for new enrolments, for one session
 * or the rest of its series; nothing already enrolled is repriced; more
 * places go to the waiting list, fewer never below those taken.
 */

let venueId: number;
let seq = 0;
let managerCookie: string;
let deskCookie: string;

beforeAll(async () => {
  venueId = (await listVenues())[0].id;
  const manager = await createAdmin({ name: "Mona Manager", email: "mona-cls@venue.my", password: "manager-pass-1", venueId });
  const desk = await createAdmin({ name: "Dan Desk", email: "dan-cls@venue.my", password: "desk-password-1", venueId, role: "desk" });
  if (!manager.ok || !desk.ok) throw new Error("staff");
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
});

async function aClass(opts: { capacity?: number; weeks?: number; price?: number; room?: number } = {}) {
  seq++;
  const court = await createCourt({ venueId, name: `Change Studio ${seq}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity: opts.room ?? 10 });
  if (!court.ok) throw new Error("court");
  const made = await createClassSessions({
    courtId: court.court.id,
    name: `Pilates ${seq}`,
    instructor: "Aina",
    date: addDays(todayISO(), 4),
    startHour: 18,
    endHour: 19,
    capacity: opts.capacity ?? 2,
    price: opts.price ?? 20,
    weeks: opts.weeks ?? 1,
  });
  if (!made.ok) throw new Error(made.error);
  return made.classes;
}

const enrol = async (classId: number, i: number) => {
  const r = await enrolInClass({ classId, name: `Member ${seq}-${i}`, phone: `0177${String(seq).padStart(3, "0")}${String(i).padStart(3, "0")}` });
  if (!r.ok) throw new Error(r.error);
  return r.booking;
};

const patch = (classId: number, body: unknown, cookie = managerCookie) =>
  PATCH(new NextRequest(`http://localhost/api/admin/classes/${classId}`, { method: "PATCH", headers: { cookie }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: String(classId) }),
  });

describe("changing a class", () => {
  it("changes its name and instructor, logged with what was and what is", async () => {
    const [session] = await aClass();
    const res = await patch(session.id, { name: "Pilates Plus", instructor: "Farah" });
    expect(res.status).toBe(200);
    expect((await res.json()).classes[0]).toMatchObject({ name: "Pilates Plus", instructor: "Farah" });
    const entry = (await listActivity([venueId])).find((a) => a.action === "class.changed");
    expect(entry?.adminName).toBe("Mona Manager");
    expect(entry?.detail).toContain(`name ${session.name} → Pilates Plus`);
    expect(entry?.detail).toContain("instructor Aina → Farah");
  });

  it("prices new enrolments only: who enrolled keeps what they enrolled at", async () => {
    const [session] = await aClass({ capacity: 3, price: 20 });
    const before = await enrol(session.id, 1);
    expect(before.totalPrice).toBe(20);
    expect(await changeClass(session.id, { price: 28 })).toMatchObject({ ok: true });
    const after = await enrol(session.id, 2);
    expect(after.totalPrice).toBe(28);
    const roster = await getClassRoster(session.id);
    expect(roster.find((b) => b.id === before.id)!.totalPrice).toBe(20);
    expect(roster.find((b) => b.id === after.id)!.totalPrice).toBe(28);
  });

  it("takes fewer places only down to those enrolled", async () => {
    const [session] = await aClass({ capacity: 4 });
    await enrol(session.id, 1);
    await enrol(session.id, 2);
    const refused = await changeClass(session.id, { capacity: 1 });
    expect(refused).toMatchObject({ ok: false });
    expect(!refused.ok && refused.error).toContain("2 place(s) are taken or offered");
    expect((await getClass(session.id))!.capacity).toBe(4);
    expect(await changeClass(session.id, { capacity: 2 })).toMatchObject({ ok: true });
    expect((await getClass(session.id))!.capacity).toBe(2);
    // And never above what the room holds.
    expect(await changeClass(session.id, { capacity: 11 })).toMatchObject({ ok: false, error: expect.stringContaining("Capacity must be 1–10") });
  });

  it("offers a new place to the first person waiting, through the waiting list's own offer", async () => {
    const [session] = await aClass({ capacity: 1 });
    await enrol(session.id, 1);
    const queued = await joinClassWaitlist({ classId: session.id, name: "Waiting Wan", phone: "0170000999" });
    expect(queued.ok).toBe(true);
    const res = await patch(session.id, { capacity: 2 });
    expect(res.status).toBe(200);
    expect((await res.json()).offered).toBe(1);
    const queue = await listClassWaitlist(session.id);
    expect(queue[0]).toMatchObject({ name: "Waiting Wan", status: "offered" });
    // The offer holds the new place: it cannot be taken back from under it.
    expect(await changeClass(session.id, { capacity: 1 })).toMatchObject({ ok: false });
  });

  it("changes the rest of a weekly series with `series`, all or none", async () => {
    const sessions = await aClass({ weeks: 3, capacity: 3 });
    await enrol(sessions[2].id, 1);
    await enrol(sessions[2].id, 2);
    // Week three has two enrolled: one place for every week is refused for all of them.
    expect(await changeClass(sessions[0].id, { capacity: 1, series: true })).toMatchObject({ ok: false });
    for (const s of sessions) expect((await getClass(s.id))!.capacity).toBe(3);
    const done = await changeClass(sessions[1].id, { instructor: "Kavitha", series: true });
    expect(done.ok && done.changed.map((c) => c.after.id)).toEqual([sessions[1].id, sessions[2].id]);
    expect((await getClass(sessions[0].id))!.instructor).toBe("Aina");
    expect((await getClass(sessions[2].id))!.instructor).toBe("Kavitha");
  });

  it("refuses a class that has started or was cancelled", async () => {
    const [session] = await aClass();
    await getDb().prepare("UPDATE classes SET date = ? WHERE id = ?").run(addDays(todayISO(), -1), session.id);
    expect(await changeClass(session.id, { name: "Too late" })).toMatchObject({ ok: false, code: "CLASS_STARTED" });
    const [other] = await aClass();
    await getDb().prepare("UPDATE classes SET status = 'cancelled' WHERE id = ?").run(other.id);
    expect(await changeClass(other.id, { name: "Gone" })).toMatchObject({ ok: false, code: "CLASS_CANCELLED" });
  });

  it("is a manager's, not the front desk's", async () => {
    const [session] = await aClass();
    const res = await patch(session.id, { name: "Desk tried" }, deskCookie);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("MANAGER_ONLY");
  });

  it("never lets an enrolment and a cut in places together overfill a class", async () => {
    const [session] = await aClass({ capacity: 3 });
    await enrol(session.id, 1);
    await enrol(session.id, 2);
    // A third enrolment and a cut to two, at once: whichever goes first, the class never holds more than it allows.
    const [joined, cut] = await Promise.all([
      enrolInClass({ classId: session.id, name: "Racer", phone: "0179990001" }),
      changeClass(session.id, { capacity: 2 }),
    ]);
    const now = (await getClass(session.id))!;
    expect(now.enrolled).toBeLessThanOrEqual(now.capacity);
    expect(joined.ok && cut.ok).toBe(false);
  });
});
