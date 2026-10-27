import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { cancelClassSession, createClassSessions, createCourt, createVenue, enrolInClass } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { GET as term } from "../src/app/api/classes/term/route";

/**
 * The class term route (`GET /api/classes/term?classId=`), which the class
 * page asks before offering "the whole term": the sessions left from this one
 * that can still be joined, their dates, and what the term costs with its
 * share off. A draft venue's classes are its own staff's to see.
 */

let n = 0;
const phone = () => `0122220${String(++n).padStart(3, "0")}`;
const start = addDays(todayISO(), 2);

async function venue(name: string, published: boolean) {
  const v = await createVenue({ name, area: "Subang", address: "x", phone: "0377771111" });
  if (!v.ok) throw new Error("venue");
  await getDb().prepare(`UPDATE venues SET published_at = ${published ? "datetime('now')" : "NULL"} WHERE id = ?`).run(v.venue.id);
  const c = await createCourt({ venueId: v.venue.id, name: "Hall", sport: "badminton", offPeakRate: 20, peakRate: 20, capacity: 10 });
  if (!c.ok) throw new Error(c.error);
  return { venueId: v.venue.id, courtId: c.court.id };
}

async function classes(courtId: number, weeks: number, startHour: number, termOffPercent: number | null = 10, capacity = 2) {
  const made = await createClassSessions({
    courtId, name: "Kids' badminton", instructor: "Coach Lee", date: start, startHour, endHour: startHour + 1,
    capacity, price: 30, weeks, termOffPercent,
  });
  if (!made.ok) throw new Error(made.error);
  return made.classes.map((c) => c.id);
}

const ask = async (classId: string | number, cookie?: string) => {
  const res = await term(new NextRequest(`http://localhost/api/classes/term?classId=${classId}`, cookie ? { headers: { cookie } } : undefined));
  return { status: res.status, body: (await res.json()) as { term?: { sessions: number; dates: string[]; total: number; offPercent: number } | null; error?: string } };
};

let liveCourt: number;
let draftCourt: number;
let draftVenue: number;
let ownerCookie: string;
let otherDeskCookie: string;
let draftDeskCookie: string;

beforeAll(async () => {
  const live = await venue("Term Academy", true);
  const draft = await venue("Term Draft", false);
  liveCourt = live.courtId;
  draftCourt = draft.courtId;
  draftVenue = draft.venueId;
  await ensureBootstrapAdmin();
  const owner = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!;
  ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
  const otherDesk = await createAdmin({ name: "Desk", email: "term-desk@venue.my", password: "desk-password-1", venueId: live.venueId });
  const draftDesk = await createAdmin({ name: "Draft Desk", email: "term-draft@venue.my", password: "desk-password-2", venueId: draftVenue });
  if (!otherDesk.ok || !draftDesk.ok) throw new Error("desk");
  otherDeskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(otherDesk.admin.id)).token}`;
  draftDeskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(draftDesk.admin.id)).token}`;
});

describe("the class term route", () => {
  it("gives every session left, their dates and the term's price with its share off", async () => {
    const ids = await classes(liveCourt, 4, 9);
    const { status, body } = await ask(ids[0]);
    expect(status).toBe(200);
    expect(body.term).toEqual({
      sessions: 4,
      dates: [0, 7, 14, 21].map((d) => addDays(start, d)),
      total: 108,
      offPercent: 10,
    });
    // From the third week on, only what is left from there.
    expect((await ask(ids[2])).body.term).toMatchObject({ sessions: 2, dates: [addDays(start, 14), addDays(start, 21)], total: 54 });
  });

  it("leaves out a session that is full or cancelled, and charges only for the rest", async () => {
    const ids = await classes(liveCourt, 4, 11);
    for (const who of [phone(), phone()]) {
      const r = await enrolInClass({ classId: ids[1], name: "Other", phone: who });
      if (!r.ok) throw new Error(r.error);
    }
    expect((await cancelClassSession(ids[3])).ok).toBe(true);
    const { body } = await ask(ids[0]);
    expect(body.term).toEqual({ sessions: 2, dates: [start, addDays(start, 14)], total: 54, offPercent: 10 });
  });

  it("offers no term for a one-off class, or where fewer than two sessions are left", async () => {
    const [once] = await classes(liveCourt, 1, 13);
    expect(await ask(once)).toEqual({ status: 200, body: { term: null } });
    const ids = await classes(liveCourt, 2, 15);
    expect((await ask(ids[1])).body).toEqual({ term: null });
  });

  it("charges the full price where the class gives no share off", async () => {
    const ids = await classes(liveCourt, 3, 17, null);
    expect((await ask(ids[0])).body.term).toMatchObject({ sessions: 3, total: 90, offPercent: 0 });
  });

  it("shows a draft venue's term to its own staff only", async () => {
    const ids = await classes(draftCourt, 3, 9);
    expect((await ask(ids[0])).body).toEqual({ term: null });
    expect((await ask(ids[0], otherDeskCookie)).body).toEqual({ term: null });
    expect((await ask(ids[0], draftDeskCookie)).body.term).toMatchObject({ sessions: 3, total: 81 });
    expect((await ask(ids[0], ownerCookie)).body.term).toMatchObject({ sessions: 3 });
  });

  it("answers nothing for a class that does not exist", async () => {
    expect(await ask(999999)).toEqual({ status: 200, body: { term: null } });
  });

  it("refuses a request without a class", async () => {
    for (const bad of ["", "0", "-3", "abc", "1.5"]) {
      const { status, body } = await ask(bad);
      expect(status, bad).toBe(400);
      expect(body.error, bad).toBe("classId is required.");
    }
  });
});
