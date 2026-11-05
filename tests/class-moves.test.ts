import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { cancelMovedPlace, classMoveWindowDays, movedPlaces, moveClasses, previewClassMove, refundUntil } from "../src/lib/class-moves";
import { getDb } from "../src/lib/db";
import { setWhatsappMode } from "../src/lib/whatsapp-credit";
import {
  createBooking,
  createClassSessions,
  createCourt,
  enrolInClass,
  getClass,
  getClassRoster,
  issuePass,
  joinClassWaitlist,
  listVenues,
  payBookingWithPass,
  createVenue,
  findBookingByCode,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as moveRoute } from "../src/app/api/admin/classes/[id]/move/route";
import { GET as publicClasses } from "../src/app/api/classes/route";
import { POST as cancelRoute } from "../src/app/api/class-moves/cancel/route";

/**
 * Moving a class (lib/class-moves.ts): one session, the rest of its series or the whole term, to another date, time or court,
 * all or none; everyone enrolled kept and told once; a link to cancel for everything back inside a window.
 */

let venueId: number;
let managerCookie: string;
let deskCookie: string;
let seq = 0;

beforeAll(async () => {
  venueId = (await listVenues())[0].id;
  const manager = await createAdmin({ name: "Mona Mover", email: "mona-mv@venue.my", password: "manager-pass-1", venueId });
  const desk = await createAdmin({ name: "Dan Desk", email: "dan-mv@venue.my", password: "desk-password-1", venueId, role: "desk" });
  if (!manager.ok || !desk.ok) throw new Error("staff");
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
});

const day = (n: number) => addDays(todayISO(), n);

async function studio(capacity = 10, name?: string) {
  seq++;
  const made = await createCourt({ venueId, name: name ?? `Move Studio ${seq}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity });
  if (!made.ok) throw new Error("court");
  return made.court;
}

async function aClass(opts: { court?: { id: number }; weeks?: number; capacity?: number; at?: number; offset?: number; price?: number } = {}) {
  const court = opts.court ?? (await studio());
  seq++;
  const made = await createClassSessions({
    courtId: court.id,
    name: `Pilates ${seq}`,
    instructor: "Aina",
    date: day(opts.offset ?? 5),
    startHour: opts.at ?? 18,
    endHour: (opts.at ?? 18) + 1,
    capacity: opts.capacity ?? 6,
    price: opts.price ?? 20,
    weeks: opts.weeks ?? 1,
  });
  if (!made.ok) throw new Error(made.error);
  return { court, classes: made.classes };
}

let phoneN = 0;
async function enrol(classId: number, opts: { email?: string; locale?: string; name?: string } = {}) {
  phoneN++;
  const r = await enrolInClass({ classId, name: opts.name ?? `Member ${phoneN}`, phone: `0166${String(phoneN).padStart(6, "0")}`, ...(opts.email ? { email: opts.email } : {}) });
  if (!r.ok) throw new Error(r.error);
  if (opts.locale) await getDb().prepare("UPDATE bookings SET locale = ? WHERE id = ?").run(opts.locale, r.booking.id);
  return r.booking;
}

const admin = { id: null as number | null, name: "Mona Mover" };
const move = (classId: number, to: { date: string; start: number; courtId?: number }, scope?: string) => moveClasses(admin, classId, to, scope);

const post = (classId: number, body: unknown, cookie = managerCookie) =>
  moveRoute(new NextRequest(`http://localhost/api/admin/classes/${classId}/move`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: String(classId) }),
  });

const claimsOf = async (classId: number) =>
  (await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE class_id = ? AND active").get(classId)) as { n: number };

describe("moving a session", () => {
  it("puts the class, its claim and every enrolment at the new date, time and court, keeping each place", async () => {
    const { court, classes } = await aClass({ capacity: 4 });
    const other = await studio();
    const [session] = classes;
    const a = await enrol(session.id);
    const b = await enrol(session.id);
    const result = await move(session.id, { date: day(8), start: 19 * 60 + 30, courtId: other.id });
    expect(result).toMatchObject({ ok: true, scope: "one" });
    const now = (await getClass(session.id))!;
    expect(now).toMatchObject({ date: day(8), startMin: 19 * 60 + 30, endMin: 20 * 60 + 30, courtId: other.id, status: "scheduled" });
    // The same people hold the same places, at the new time and court, under the codes they had.
    const roster = await getClassRoster(session.id);
    expect(roster.map((x) => x.code).sort()).toEqual([a.code, b.code].sort());
    for (const r of roster) expect(r).toMatchObject({ date: day(8), startMin: 19 * 60 + 30, endMin: 20 * 60 + 30, courtId: other.id, status: "confirmed" });
    const stored = (await getDb().prepare("SELECT starts_at, ends_at FROM bookings WHERE id = ?").get(a.id)) as { starts_at: string | Date; ends_at: string | Date };
    expect(new Date(stored.starts_at).getTime()).toBeLessThan(new Date(stored.ends_at).getTime());
    expect(await claimsOf(session.id)).toEqual({ n: 1 });
    // The old time is free for a booking, the new one is held for the class.
    const old = await createBooking({ courtId: court.id, date: day(5), hours: [18], name: "Walk-in", phone: "0165550001" });
    expect(old.ok).toBe(true);
    const taken = await createBooking({ courtId: other.id, date: day(8), hours: [19.5], name: "Late", phone: "0165550002" });
    expect(taken.ok).toBe(false);
    // The public classes list shows it at once at its new day, time and court, and no longer at the old.
    const listed = (await (await publicClasses(new NextRequest(`http://localhost/api/classes?venueId=${venueId}`))).json()).classes as { id: number; date: string; startMin: number; courtName: string }[];
    expect(listed.find((c) => c.id === session.id)).toMatchObject({ date: day(8), startMin: 19 * 60 + 30, courtName: other.name });
    expect(listed.filter((c) => c.id === session.id)).toHaveLength(1);
  });

  it("is logged with what it was and what it is, by a manager's route; the desk is turned away where the venue has turned its moves off", async () => {
    const { classes } = await aClass();
    const [session] = classes;
    const res = await post(session.id, { date: day(9), start: "17:00" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.classes[0]).toMatchObject({ id: session.id, date: day(9), startMin: 17 * 60 });
    const entry = (await listActivity([venueId])).find((a) => a.action === "class.moved" && a.detail?.includes(session.name));
    expect(entry?.adminName).toBe("Mona Manager".replace("Manager", "Mover"));
    expect(entry?.detail).toContain(`${day(5)} 6:00 PM–7:00 PM`);
    expect(entry?.detail).toContain(`${day(9)} 5:00 PM–6:00 PM`);
    // Front desk may move a class unless the venue's manager turned that off (ADR 0045; tests/class-move-requests.test.ts): with it off, as before.
    await getDb().prepare("UPDATE venues SET desk_may_move_classes = FALSE WHERE id = ?").run(venueId);
    try {
      const desk = await post(session.id, { date: day(10), start: "17:00" }, deskCookie);
      expect(desk.status).toBe(403);
      expect((await desk.json()).code).toBe("MANAGER_ONLY");
      expect((await getClass(session.id))!.date).toBe(day(9));
    } finally {
      await getDb().prepare("UPDATE venues SET desk_may_move_classes = TRUE WHERE id = ?").run(venueId);
    }
  });

  it("refuses a bad request and a class of another venue's court", async () => {
    const { classes } = await aClass();
    expect((await post(classes[0].id, { date: "tomorrow", start: "17:00" })).status).toBe(400);
    expect((await post(classes[0].id, { date: day(9) })).status).toBe(400);
    const made = await createVenue({ name: "Elsewhere Studio", area: "Ampang", address: "9 Jalan Lain", phone: "0388889999" });
    if (!made.ok) throw new Error("venue");
    const theirs = await createCourt({ venueId: made.venue.id, name: "Their Room", sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 10 });
    if (!theirs.ok) throw new Error("court");
    const res = await post(classes[0].id, { date: day(9), start: "17:00", courtId: theirs.court.id });
    expect(res.status).toBe(409);
    const said = await res.json();
    expect(JSON.stringify(said)).not.toContain("Their Room");
    expect((await getClass(classes[0].id))!.date).toBe(day(5));
  });

  it("refuses what is not a move, or is begun, cancelled or attended", async () => {
    const { classes } = await aClass();
    const [session] = classes;
    expect(await move(session.id, { date: day(5), start: 18 * 60 })).toMatchObject({ ok: false, code: "CLSA_MOVE_SAME" });
    expect(await move(session.id, { date: day(7), start: 18 * 60 }, "sometimes")).toMatchObject({ ok: false, code: "CLSA_MOVE_SCOPE" });
    expect(await move(session.id, { date: day(-1), start: 18 * 60 })).toMatchObject({ ok: false, code: "SLOT_PAST" });
    const begun = (await aClass()).classes[0];
    await getDb().prepare("UPDATE classes SET date = ? WHERE id = ?").run(day(-1), begun.id);
    expect(await move(begun.id, { date: day(7), start: 18 * 60 })).toMatchObject({ ok: false, code: "CLASS_STARTED" });
    const gone = (await aClass()).classes[0];
    await getDb().prepare("UPDATE classes SET status = 'cancelled' WHERE id = ?").run(gone.id);
    expect(await move(gone.id, { date: day(7), start: 18 * 60 })).toMatchObject({ ok: false, code: "CLASS_CANCELLED" });
    // Attendance taken: somebody has checked in, so it is under way whatever its start says.
    const attended = (await aClass()).classes[0];
    const who = await enrol(attended.id);
    await getDb().prepare("INSERT INTO check_ins (booking_id) VALUES (?)").run(who.id);
    expect(await move(attended.id, { date: day(7), start: 18 * 60 })).toMatchObject({ ok: false, code: "CLSA_MOVE_ATTENDANCE" });
    expect((await getClass(attended.id))!.date).toBe(day(5));
  });
});

describe("what is in the way", () => {
  it("another class, a booking, a block of time: refused, naming the court and day, nothing moved", async () => {
    const { court, classes } = await aClass();
    const [session] = classes;
    // Another class at the target.
    await createClassSessions({ courtId: court.id, name: "Zumba", instructor: "Lina", date: day(7), startHour: 18, endHour: 19, capacity: 5, price: 10 });
    expect(await move(session.id, { date: day(7), start: 18 * 60 })).toMatchObject({ ok: false, code: "CLSA_MOVE_CLASS", vars: { date: day(7) } });
    // Overlapping by a minute still collides.
    expect(await move(session.id, { date: day(7), start: 18 * 60 + 59 })).toMatchObject({ ok: false, code: "CLSA_MOVE_CLASS" });
    // A booking of a place there.
    const booked = await createBooking({ courtId: court.id, date: day(9), hours: [18], name: "Early", phone: "0165550011" });
    if (!booked.ok) throw new Error(booked.error);
    expect(await move(session.id, { date: day(9), start: 18 * 60 })).toMatchObject({ ok: false, code: "CLSA_MOVE_BOOKED" });
    expect((await getClass(session.id))!).toMatchObject({ date: day(5), startMin: 18 * 60 });
    expect(await claimsOf(session.id)).toEqual({ n: 1 });
    // The booking away from the class's hours does not stop it.
    expect(await move(session.id, { date: day(9), start: 20 * 60 })).toMatchObject({ ok: true });
  });

  it("a closed day, hours outside the venue's, and a court too small, of another activity or not shared", async () => {
    const { classes } = await aClass({ capacity: 6 });
    const [session] = classes;
    await getDb().prepare("INSERT INTO venue_closures (venue_id, date, reason) VALUES (?, ?, 'Holiday')").run(venueId, day(40));
    expect(await move(session.id, { date: day(40), start: 18 * 60 })).toMatchObject({ ok: false, code: "VENUE_CLOSED" });
    expect(await move(session.id, { date: day(13), start: 3 * 60 })).toMatchObject({ ok: false, code: "CLSA_MOVE_HOURS" });
    const small = await studio(3);
    expect(await move(session.id, { date: day(13), start: 18 * 60, courtId: small.id })).toMatchObject({ ok: false, code: "CLSA_MOVE_COURT" });
    seq++;
    const single = await createCourt({ venueId, name: `Move Single ${seq}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 1 });
    if (!single.ok) throw new Error("court");
    expect(await move(session.id, { date: day(13), start: 18 * 60, courtId: single.court.id })).toMatchObject({ ok: false, code: "CLSA_MOVE_COURT" });
    seq++;
    const pitch = await createCourt({ venueId, name: `Move Pitch ${seq}`, sport: "tennis", offPeakRate: 5, peakRate: 8, capacity: 10 });
    if (!pitch.ok) throw new Error("court");
    expect(await move(session.id, { date: day(13), start: 18 * 60, courtId: pitch.court.id })).toMatchObject({ ok: false, code: "CLSA_MOVE_COURT" });
    expect((await getClass(session.id))!.date).toBe(day(5));
  });

  it("all or none: one session of a series that cannot move holds back every one", async () => {
    const { court, classes } = await aClass({ weeks: 3 });
    // Week three's new time (a week on) has a class already; weeks one and two would be free.
    await createClassSessions({ courtId: court.id, name: "Boxing", instructor: "Bo", date: addDays(classes[2].date, 1), startHour: 18, endHour: 19, capacity: 5, price: 10 });
    const refused = await move(classes[0].id, { date: addDays(classes[0].date, 1), start: 18 * 60 }, "term");
    expect(refused).toMatchObject({ ok: false, code: "CLSA_MOVE_CLASS" });
    expect("conflicts" in refused && refused.conflicts?.map((c) => c.date)).toEqual([classes[2].date]);
    for (const c of classes) {
      expect((await getClass(c.id))!.date).toBe(c.date);
      expect(await claimsOf(c.id)).toEqual({ n: 1 });
    }
  });
});

describe("a series and a term", () => {
  it("moves the whole term shifting every session by what the chosen one does, a day later; weeks move onto each other's old times", async () => {
    const { classes } = await aClass({ weeks: 3 });
    const who = await enrol(classes[1].id);
    const result = await move(classes[1].id, { date: addDays(classes[1].date, 7), start: 18 * 60 }, "term");
    // A week on: session two lands on session three's old time, session three a week later still.
    expect(result.ok).toBe(true);
    const dates = await Promise.all(classes.map(async (c) => (await getClass(c.id))!.date));
    expect(dates).toEqual(classes.map((c) => addDays(c.date, 7)));
    expect((await findBookingByCode(who.code))!.date).toBe(addDays(classes[1].date, 7));
    for (const c of classes) expect(await claimsOf(c.id)).toEqual({ n: 1 });
  });

  it("`following` leaves the earlier sessions; `one` only its own", async () => {
    const { classes } = await aClass({ weeks: 4, offset: 6 });
    expect(await move(classes[1].id, { date: addDays(classes[1].date, 1), start: 17 * 60 }, "following")).toMatchObject({ ok: true });
    const now = await Promise.all(classes.map(async (c) => (await getClass(c.id))!));
    expect(now.map((c) => [c.date, c.startMin])).toEqual([
      [classes[0].date, 18 * 60],
      [addDays(classes[1].date, 1), 17 * 60],
      [addDays(classes[2].date, 1), 17 * 60],
      [addDays(classes[3].date, 1), 17 * 60],
    ]);
    expect(await move(classes[3].id, { date: addDays(classes[3].date, 2), start: 17 * 60 }, "one")).toMatchObject({ ok: true });
    expect((await getClass(classes[2].id))!.date).toBe(addDays(classes[2].date, 1));
    expect((await getClass(classes[3].id))!.date).toBe(addDays(classes[3].date, 2));
  });

  it("keeps a series' exceptions: a cancelled session stays cancelled, one begun stays, one at another time keeps its offset", async () => {
    const { classes } = await aClass({ weeks: 4, offset: 6 });
    await getDb().prepare("UPDATE classes SET status = 'cancelled' WHERE id = ?").run(classes[1].id);
    // Week three was put an hour later on its own.
    await getDb().prepare("UPDATE classes SET start_min = ?, end_min = ? WHERE id = ?").run(19 * 60, 20 * 60, classes[2].id);
    await getDb().prepare("UPDATE claims SET during = tstzrange(lower(during) + interval '1 hour', upper(during) + interval '1 hour'), occupied = tstzrange(lower(occupied) + interval '1 hour', upper(occupied) + interval '1 hour') WHERE class_id = ?").run(classes[2].id);
    await getDb().prepare("UPDATE classes SET date = ? WHERE id = ?").run(day(-1), classes[0].id);
    const seen = await previewClassMove(classes[3].id, { date: addDays(classes[3].date, 1), start: 18 * 60 }, "term");
    if (!seen.ok) throw new Error(seen.error);
    expect(seen.skipped.map((s) => [s.classId, s.reason]).sort()).toEqual([[classes[0].id, "started"], [classes[1].id, "cancelled"]].sort());
    expect(seen.sessions.map((s) => s.classId)).toEqual([classes[2].id, classes[3].id]);
    const done = await move(classes[3].id, { date: addDays(classes[3].date, 1), start: 18 * 60 }, "term");
    expect(done.ok).toBe(true);
    expect((await getClass(classes[0].id))!.date).toBe(day(-1));
    expect((await getClass(classes[1].id))!.status).toBe("cancelled");
    expect((await getClass(classes[1].id))!.date).toBe(classes[1].date);
    // Week three stayed an hour later than the rest, a day on.
    expect((await getClass(classes[2].id))!).toMatchObject({ date: addDays(classes[2].date, 1), startMin: 19 * 60 });
    expect((await getClass(classes[3].id))!).toMatchObject({ date: addDays(classes[3].date, 1), startMin: 18 * 60 });
  });
});

describe("the preview", () => {
  it("changes nothing, and says who is in each session, who waits, who holds a pass entry and what each will be told in their language", async () => {
    const { classes } = await aClass({ weeks: 2, capacity: 2 });
    const first = classes[0];
    const english = await enrol(first.id, { email: "ann-pv@move.my", name: "Ann Lee" });
    const malay = await enrol(first.id, { email: "mira-pv@move.my", name: "Mira Melayu", locale: "ms" });
    expect((await joinClassWaitlist({ classId: first.id, name: "Wira Wait", phone: "0170001234", email: "wira-pv@move.my", locale: "zh" })).ok).toBe(true);
    const pass = await issuePass({ venueId, name: "Studio pass", entries: 3, price: 30, holderName: "Ann Lee", holderPhone: english.phone, expiresOn: day(60), adminId: null });
    if (!pass.ok) throw new Error(pass.error);
    expect((await payBookingWithPass(english.id, pass.pass.code)).ok).toBe(true);

    const seen = await previewClassMove(first.id, { date: day(9), start: 18 * 60 }, "term");
    if (!seen.ok) throw new Error(seen.error);
    expect(seen.blocked).toBe(false);
    expect(seen.windowDays).toBe(7);
    expect(seen.sessions).toHaveLength(2);
    expect(seen.sessions[0]).toMatchObject({ classId: first.id, enrolled: 2, waiting: 1 });
    expect(seen.sessions[0].people.find((p) => p.code === english.code)).toMatchObject({ pass: true });
    expect(seen.sessions[0].people.find((p) => p.code === malay.code)).toMatchObject({ pass: false });
    const told = Object.fromEntries(seen.notices.map((n) => [n.name, n]));
    expect(told["Ann Lee"]).toMatchObject({ kind: "enrolled", locale: "en", channels: ["email"] });
    expect(told["Ann Lee"].text).toContain("changed the time of booking");
    expect(told["Ann Lee"].text).toContain("If you cannot make the new time");
    expect(told["Mira Melayu"].locale).toBe("ms");
    expect(told["Mira Melayu"].text).toContain("Jika anda tidak dapat hadir pada masa baharu");
    expect(told["Wira Wait"]).toMatchObject({ kind: "waiting", locale: "zh", channels: ["email"] });
    // Nothing changed.
    expect((await getClass(first.id))!.date).toBe(day(5));
    const sent = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE dedupe_key LIKE 'classmove:%'").get()) as { n: number };
    expect(sent.n).toBe(0);
    // And a move it would refuse is previewed as a conflict.
    await createClassSessions({ courtId: first.courtId, name: "Clash", instructor: "X", date: day(11), startHour: 18, endHour: 19, capacity: 2, price: 1 });
    const blocked = await previewClassMove(first.id, { date: day(11), start: 18 * 60 }, "one");
    if (!blocked.ok) throw new Error(blocked.error);
    expect(blocked.blocked).toBe(true);
    expect(blocked.sessions[0].conflict).toMatchObject({ code: "CLSA_MOVE_CLASS" });
    // The route answers the same with `preview`.
    const res = await post(first.id, { date: day(9), start: "18:00", scope: "term", preview: true });
    expect(res.status).toBe(200);
    expect((await res.json()).sessions).toHaveLength(2);
    expect((await getClass(first.id))!.date).toBe(day(5));
  });
});

describe("telling people", () => {
  const messages = async (recipient: string) =>
    (await getDb().prepare("SELECT kind, channel, locale, subject, body, calendar, notice_id, dedupe_key FROM messages WHERE recipient = ? AND dedupe_key LIKE 'classmove:%' ORDER BY id").all(recipient)) as {
      kind: string; channel: string; locale: string; subject: string; body: string; calendar: string | null; notice_id: number | null; dedupe_key: string;
    }[];

  it("tells each person once, however many sessions of theirs moved, in their language, with a calendar file and the notice they acknowledge", async () => {
    const { classes } = await aClass({ weeks: 3 });
    const both = `both-${seq}@move.my`;
    const malay = `malay-${seq}@move.my`;
    await enrol(classes[0].id, { email: both, name: "Siti Both" });
    await enrol(classes[1].id, { email: both, name: "Siti Both" });
    const ms = await enrol(classes[0].id, { email: malay, name: "Mira Melayu", locale: "ms" });
    // No address: nobody to write to, but the notice for the desk to ring is there.
    const silent = await enrol(classes[2].id, { name: "Quiet Quek" });
    const done = await move(classes[0].id, { date: addDays(classes[0].date, 2), start: 17 * 60 }, "term");
    expect(done).toMatchObject({ ok: true });
    expect(done.ok && done.told).toBe(2);
    const toBoth = await messages(both);
    expect(toBoth).toHaveLength(1);
    expect(toBoth[0]).toMatchObject({ kind: "booking_rescheduled", channel: "email", locale: "en" });
    expect(toBoth[0].body).toContain("Hi Siti");
    expect(toBoth[0].body).toContain("2 weekly sessions, the first");
    expect(toBoth[0].body).toContain("(it was");
    expect(toBoth[0].body).toContain("/class-move/");
    expect(toBoth[0].body).toContain("/ack/");
    expect(toBoth[0].calendar).toContain("BEGIN:VEVENT");
    expect(toBoth[0].calendar!.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(toBoth[0].notice_id).not.toBeNull();
    // Chinese and Tamil readers are told in their own language too (by a second move, once they are enrolled).
    const zh = await enrol(classes[1].id, { email: `zh-${seq}@move.my`, name: "Wei Zhang", locale: "zh" });
    const ta = await enrol(classes[1].id, { email: `ta-${seq}@move.my`, name: "Kavi Tamil", locale: "ta" });
    const [toMalay] = await messages(malay);
    expect(toMalay.locale).toBe("ms");
    expect(toMalay.body).toContain("Hai Mira");
    expect(toMalay.body).toContain(ms.code);
    // The desk's list has a notice for each person, the unreachable one too.
    const notices = (await getDb().prepare("SELECT booking_id FROM urgent_notices WHERE kind = 'moved' ORDER BY id DESC LIMIT 3").all()) as { booking_id: number }[];
    expect(notices.some((n) => n.booking_id === silent.id)).toBe(true);
    expect(await messages("")).toHaveLength(0);
    await move(classes[0].id, { date: addDays(classes[0].date, 3), start: 17 * 60 }, "term");
    const [toZh] = await messages(`zh-${seq}@move.my`);
    expect(toZh.locale).toBe("zh");
    expect(toZh.body).toContain("您的名额会随课程一起调整");
    const [toTa] = await messages(`ta-${seq}@move.my`);
    expect(toTa.locale).toBe("ta");
    expect(toTa.body).toContain("உங்கள் இடம் வகுப்புடன் சேர்ந்து மாறும்");
    expect([zh.code, ta.code].every(Boolean)).toBe(true);
  });

  it("tells those waiting by email, an offered place with its own link, and is not sent twice", async () => {
    const { classes } = await aClass({ capacity: 1 });
    const [session] = classes;
    await enrol(session.id);
    const waiting = `waiting-${seq}@move.my`;
    const offered = `offered-${seq}@move.my`;
    expect((await joinClassWaitlist({ classId: session.id, name: "Olivia Offer", phone: "0170000771", email: offered })).ok).toBe(true);
    expect((await joinClassWaitlist({ classId: session.id, name: "Wira Wait", phone: "0170000772", email: waiting, locale: "ms" })).ok).toBe(true);
    // One more place: the first in line is offered it.
    await getDb().prepare("UPDATE classes SET capacity = 2 WHERE id = ?").run(session.id);
    const { offerClassPlace } = await import("../src/lib/store");
    expect(await offerClassPlace(session.id)).not.toBeNull();
    const token = ((await getDb().prepare("SELECT offer_token FROM waitlist WHERE class_id = ? AND status = 'offered'").get(session.id)) as { offer_token: string }).offer_token;
    const done = await move(session.id, { date: day(9), start: 18 * 60 });
    // The two waiting are told; the one enrolled gave no address.
    expect(done.ok && done.told).toBe(2);
    const [toOffered] = await messages(offered);
    expect(toOffered.kind).toBe("class_changed");
    expect(toOffered.body).toContain(`/waitlist/${token}`);
    const [toWaiting] = await messages(waiting);
    expect(toWaiting.locale).toBe("ms");
    expect(toWaiting.body).toContain("telah memindahkan");
    expect(toWaiting.body).not.toContain("/waitlist/");
    expect(toWaiting.calendar).toBeNull();
    // Written again (a retry of the same move): nothing is sent twice.
    const keys = (await getDb().prepare("SELECT dedupe_key FROM messages WHERE dedupe_key LIKE 'classmove:%' AND recipient IN (?, ?)").all(offered, waiting)) as { dedupe_key: string }[];
    expect(new Set(keys.map((k) => k.dedupe_key)).size).toBe(keys.length);
  });

  it("writes to WhatsApp as well where the venue sends urgent news there", async () => {
    await setWhatsappMode(venueId, "urgent");
    vi.stubEnv("MYSENAM_SEND", "log");
    try {
      const { classes } = await aClass();
      const email = `wa-${seq}@move.my`;
      await enrol(classes[0].id, { email, name: "Wati WhatsApp" });
      await move(classes[0].id, { date: day(9), start: 18 * 60 });
      const sent = await messages(email);
      expect(sent.map((m) => m.channel)).toEqual(["email"]);
      const whatsapp = (await getDb().prepare("SELECT kind, params FROM messages WHERE channel = 'whatsapp' AND dedupe_key LIKE 'classmove:%:whatsapp' ORDER BY id DESC LIMIT 1").get()) as
        | { kind: string; params: string }
        | undefined;
      expect(whatsapp?.kind).toBe("booking_rescheduled");
      // The template's own parameters, so the text stays as approved.
      expect(Object.keys(JSON.parse(whatsapp!.params)).sort()).toEqual(["ack", "code", "money", "name", "venue", "when", "where"]);
    } finally {
      vi.unstubAllEnvs();
      await setWhatsappMode(venueId, "off");
    }
  });

  it("a coach teaching it is told once, in their language", async () => {
    const { saveCoach } = await import("../src/lib/coaching");
    const { setCoachEmail, setCoachLocale } = await import("../src/lib/coach-schedule");
    const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: 6 * 60, until: 22 * 60 }));
    const saved = await saveCoach(venueId, { name: `Kamal Coach ${seq}`, sports: ["gym"], rate: 40, hours });
    if (!saved.ok) throw new Error(saved.error);
    const hold = seq;
    await setCoachEmail(saved.coach.id, venueId, `kamal-${hold}@coach.my`);
    await setCoachLocale(saved.coach.id, venueId, "ms");
    const court = await studio();
    seq++;
    const made = await createClassSessions({ courtId: court.id, name: `Coached ${seq}`, instructor: "x", coachId: saved.coach.id, date: day(5), startHour: 18, endHour: 19, capacity: 4, price: 5, weeks: 2 });
    if (!made.ok) throw new Error(made.error);
    expect(await move(made.classes[0].id, { date: day(6), start: 18 * 60 }, "term")).toMatchObject({ ok: true });
    const mail = (await getDb().prepare("SELECT locale, body FROM messages WHERE recipient = ? AND kind = 'coach_lesson' AND dedupe_key LIKE 'classmove-coach:%'").all(`kamal-${hold}@coach.my`)) as { locale: string; body: string }[];
    expect(mail).toHaveLength(1);
    expect(mail[0].locale).toBe("ms");
    expect(mail[0].body).toContain("2 sesi");
  });
});

describe("cancelling a moved place for everything back", () => {
  const offerOf = async (bookingId: number) =>
    (await getDb().prepare("SELECT id, token, valid_until, cancelled_at FROM class_move_offers WHERE booking_id = ? ORDER BY id DESC").get(bookingId)) as {
      id: number; token: string; valid_until: Date; cancelled_at: Date | null;
    };
  /** What is left of a pass sold with `sold` entries: what was sold, less what bookings spent, plus what was given back. */
  const passLeft = async (passId: number, sold: number) => sold + ((await getDb().prepare("SELECT COALESCE(SUM(delta), 0)::int AS n FROM pass_entries WHERE pass_id = ?").get(passId)) as { n: number }).n;

  it("gives each person one link for their places, closing at the window's end, never past the session's original time", async () => {
    const { classes } = await aClass({ weeks: 2, offset: 3 });
    const a = await enrol(classes[0].id, { email: `l-${seq}@move.my` });
    const b = await enrol(classes[1].id, { email: `l-${seq}@move.my`, name: "Same Person" });
    await move(classes[0].id, { date: addDays(classes[0].date, 9), start: 18 * 60 }, "term");
    const [oa, ob] = [await offerOf(a.id), await offerOf(b.id)];
    expect(oa.token).toBe(ob.token);
    expect(await classMoveWindowDays()).toBe(7);
    // The first session was three days and part of a day off: the window ends at its original start, not seven days on.
    const original = new Date(refundUntil({ date: classes[0].date, startMin: 18 * 60 }, "Asia/Kuala_Lumpur", 7)).getTime();
    expect(new Date(oa.valid_until).getTime()).toBe(original);
    expect(new Date(oa.valid_until).getTime() - Date.now()).toBeLessThan(4 * 86_400_000);
    // The second was ten days off: the full window.
    expect(new Date(ob.valid_until).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    const places = await movedPlaces(oa.token);
    expect(places?.map((p) => p.state)).toEqual(["open", "open"]);
    expect(places?.[0].was.date).toBe(classes[0].date);
    expect(await movedPlaces("not-a-token-at-all-not-a-token")).toBeNull();
  });

  it("gives a pass entry back once, frees the place for the waiting list, and a second tap does nothing more", async () => {
    const { classes } = await aClass({ capacity: 1 });
    const [session] = classes;
    const who = await enrol(session.id, { email: `p-${seq}@move.my` });
    const pass = await issuePass({ venueId, name: "Refund pass", entries: 2, price: 20, holderName: who.name, holderPhone: who.phone, expiresOn: day(60), adminId: null });
    if (!pass.ok) throw new Error(pass.error);
    expect((await payBookingWithPass(who.id, pass.pass.code)).ok).toBe(true);
    expect(await passLeft(pass.pass.id, 2)).toBe(1);
    expect((await joinClassWaitlist({ classId: session.id, name: "Next Nia", phone: "0170000555", email: `nia-${seq}@move.my` })).ok).toBe(true);
    await move(session.id, { date: day(9), start: 18 * 60 });
    const offer = await offerOf(who.id);

    expect(await cancelMovedPlace("short", who.id)).toMatchObject({ ok: false, code: "CLSA_LINK" });
    expect(await cancelMovedPlace(offer.token, who.id + 9999)).toMatchObject({ ok: false, code: "CLSA_LINK" });
    const done = await cancelMovedPlace(offer.token, who.id);
    expect(done.ok).toBe(true);
    expect((await findBookingByCode(who.code))!.status).toBe("cancelled");
    expect(await passLeft(pass.pass.id, 2)).toBe(2);
    expect((await offerOf(who.id)).cancelled_at).not.toBeNull();
    // The freed place is offered to the one waiting.
    expect(((await getDb().prepare("SELECT status FROM waitlist WHERE class_id = ?").get(session.id)) as { status: string }).status).toBe("offered");
    // Again: nothing more comes back, nothing is cancelled twice.
    expect(await cancelMovedPlace(offer.token, who.id)).toMatchObject({ ok: false, code: "ALREADY_CANCELLED" });
    expect(await passLeft(pass.pass.id, 2)).toBe(2);
    // Logged by who cancelled: the customer, at the link.
    const entry = (await listActivity([venueId], { bookingCode: who.code })).find((a) => a.action === "booking.cancelled");
    expect(entry?.adminName).toContain("class-move link");
    expect(entry?.detail).toContain("everything back");
  });

  it("is refused after the window, and the usual terms apply", async () => {
    const { classes } = await aClass({ offset: 6 });
    const who = await enrol(classes[0].id, { email: `w-${seq}@move.my` });
    await move(classes[0].id, { date: day(9), start: 18 * 60 });
    const offer = await offerOf(who.id);
    await getDb().prepare("UPDATE class_move_offers SET valid_until = now() - interval '1 minute' WHERE id = ?").run(offer.id);
    expect(await cancelMovedPlace(offer.token, who.id)).toMatchObject({ ok: false, code: "CLSA_WINDOW" });
    expect((await findBookingByCode(who.code))!.status).toBe("confirmed");
    expect((await movedPlaces(offer.token))?.[0].state).toBe("closed");
  });

  it("is a public route that answers 404 for a link nobody holds and cancels with a valid one", async () => {
    const { classes } = await aClass();
    const who = await enrol(classes[0].id, { email: `r-${seq}@move.my` });
    await move(classes[0].id, { date: day(9), start: 18 * 60 });
    const offer = await offerOf(who.id);
    const call = (body: unknown) =>
      cancelRoute(new NextRequest("http://localhost/api/class-moves/cancel", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++phoneN % 200}` }, body: JSON.stringify(body) }));
    expect((await call({ token: "x".repeat(24), bookingId: who.id })).status).toBe(404);
    expect((await call({ token: offer.token })).status).toBe(404);
    const ok = await call({ token: offer.token, bookingId: who.id });
    expect(ok.status).toBe(200);
    expect((await call({ token: offer.token, bookingId: who.id })).status).toBe(409);
  });
});

describe("two things at once", () => {
  it("two staff moving one class: one wins, the other is refused as changed, and the class is whole at one time", async () => {
    const { classes } = await aClass({ capacity: 4 });
    const [session] = classes;
    await enrol(session.id);
    await enrol(session.id);
    const [one, two] = await Promise.all([move(session.id, { date: day(9), start: 18 * 60 }), move(session.id, { date: day(10), start: 18 * 60 })]);
    expect([one.ok, two.ok].filter(Boolean)).toHaveLength(1);
    const loser = one.ok ? two : one;
    expect(loser).toMatchObject({ ok: false });
    const now = (await getClass(session.id))!;
    expect([day(9), day(10)]).toContain(now.date);
    for (const r of await getClassRoster(session.id)) expect(r.date).toBe(now.date);
    expect(await claimsOf(session.id)).toEqual({ n: 1 });
  });

  it("an enrolment and a move at the same moment: the person is on the roster at the class's one time", async () => {
    const { classes } = await aClass({ capacity: 4 });
    const [session] = classes;
    await enrol(session.id);
    phoneN++;
    const [joined, moved] = await Promise.all([
      enrolInClass({ classId: session.id, name: "Racer", phone: `0167${String(phoneN).padStart(6, "0")}` }),
      move(session.id, { date: day(9), start: 18 * 60 }),
    ]);
    expect(moved.ok).toBe(true);
    const now = (await getClass(session.id))!;
    expect(now.date).toBe(day(9));
    const roster = await getClassRoster(session.id);
    for (const r of roster.filter((x) => x.status === "confirmed")) expect(r.date).toBe(day(9));
    expect(roster.filter((x) => x.status === "confirmed")).toHaveLength(joined.ok ? 2 : 1);
  });

  it("two classes moved onto one time at once: one is refused and both stay whole", async () => {
    const court = await studio();
    const a = (await aClass({ court, offset: 5 })).classes[0];
    const b = (await aClass({ court, offset: 6 })).classes[0];
    const [x, y] = await Promise.all([move(a.id, { date: day(14), start: 18 * 60 }), move(b.id, { date: day(14), start: 18 * 60 })]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
    expect(await claimsOf(a.id)).toEqual({ n: 1 });
    expect(await claimsOf(b.id)).toEqual({ n: 1 });
    // The loser stays where it was; the winner is at the contested time.
    expect([(await getClass(a.id))!.date, (await getClass(b.id))!.date]).toEqual(x.ok ? [day(14), day(6)] : [day(5), day(14)]);
  });
});
