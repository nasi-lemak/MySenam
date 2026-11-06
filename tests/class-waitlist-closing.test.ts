import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { getDb } from "../src/lib/db";
import { saveCoach } from "../src/lib/coaching";
import { setCoachEmail } from "../src/lib/coach-schedule";
import { changeClass } from "../src/lib/class-changes";
import { releaseExpiredHolds } from "../src/lib/holds";
import { cancelClassAndTell, notifyPendingOffers, tellClassCancelled } from "../src/lib/notify";
import {
  adminCancelBooking,
  cancelClassSession,
  cancelSeries,
  claimWaitlistOffer,
  createClassSessions,
  createCourt,
  enrolInClass,
  enrolInTerm,
  getClass,
  joinClassWaitlist,
  listClassWaitlist,
  listVenues,
  listWaitlistFor,
} from "../src/lib/store";
import { translator } from "../src/lib/i18n";
import { addDays, todayISO } from "../src/lib/time";

/**
 * A class place freed by a term's weeks cancelled one by one, or by an unpaid claimed place lapsing, is offered to the class's
 * waiting list; a class called off closes its waiting list (told once) and tells its coach; a change of coach tells both
 * (audit 9 E6, E12, H9; ADR 0060).
 */

let venueId: number;
let seq = 0;
beforeAll(async () => {
  venueId = (await listVenues())[0].id;
});
afterEach(() => vi.useRealTimers());

const phone = (i: number) => `0164${String(++seq).padStart(3, "0")}${String(i).padStart(4, "0")}`;

async function classes(capacity: number, opts: { weeks?: number; date?: number; coachId?: number } = {}) {
  const studio = await createCourt({ venueId, name: `CWC Studio ${++seq}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 20 });
  if (!studio.ok) throw new Error("studio");
  const made = await createClassSessions({
    courtId: studio.court.id,
    name: `CWC Spin ${seq}`,
    instructor: "Ravi",
    date: addDays(todayISO(), opts.date ?? 6),
    startHour: 18,
    endHour: 19,
    capacity,
    price: 30,
    weeks: opts.weeks,
    termOffPercent: opts.weeks && opts.weeks > 1 ? 50 : undefined,
    ...(opts.coachId ? { coachId: opts.coachId } : {}),
  });
  if (!made.ok) throw new Error(made.error);
  return made.classes;
}

async function coachWith(email: string, name: string, locale?: string) {
  const saved = await saveCoach(venueId, {
    name,
    sports: ["gym"],
    rate: 60,
    hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: 6 * 60, until: 23 * 60 })),
  });
  if (!saved.ok) throw new Error(saved.error);
  await setCoachEmail(saved.coach.id, venueId, email);
  if (locale) await getDb().prepare("UPDATE coaches SET locale = ? WHERE id = ?").run(locale, saved.coach.id);
  return saved.coach;
}

const mailTo = async (recipient: string) =>
  (await getDb().prepare("SELECT kind, locale, subject, body, dedupe_key FROM messages WHERE recipient = ? ORDER BY id").all(recipient)) as {
    kind: string;
    locale: string;
    subject: string;
    body: string;
    dedupe_key: string;
  }[];

describe("E6: a class place freed without a cancellation of its own reaches the class's waiting list", () => {
  it("offers the place of an unpaid claimed enrolment that lapses", async () => {
    const [cl] = await classes(1);
    const a = await enrolInClass({ classId: cl.id, name: "A", phone: phone(1) });
    if (!a.ok) throw new Error("enrol");
    const bPhone = phone(2);
    const cPhone = phone(3);
    await joinClassWaitlist({ classId: cl.id, name: "B", phone: bPhone });
    await joinClassWaitlist({ classId: cl.id, name: "C", phone: cPhone });
    await adminCancelBooking(a.booking.code);
    const offer = (await listWaitlistFor(bPhone))[0];
    expect(offer.status).toBe("offered");
    const claimed = await claimWaitlistOffer(offer.offerToken!);
    if (!claimed.ok) throw new Error(claimed.error);
    // What the claim route does at a venue that holds unpaid bookings: held, and unpaid, it lapses.
    await getDb().prepare("UPDATE bookings SET hold_until = datetime('now', '-1 minutes') WHERE id = ?").run(claimed.booking.id);
    expect(await releaseExpiredHolds()).toBe(1);
    expect((await listClassWaitlist(cl.id)).find((e) => e.name === "C")?.status).toBe("offered");
  });

  it("offers a place a customer gives back with cancelSeries to the next waiting for that session", async () => {
    const sessions = await classes(1, { weeks: 3, date: 10 });
    const owner = phone(1);
    const term = await enrolInTerm({ classId: sessions[0].id, name: "Term Dad", phone: owner });
    if (!term.ok) throw new Error(term.error);
    const hopeful = phone(2);
    await joinClassWaitlist({ classId: sessions[1].id, name: "Hopeful", phone: hopeful });
    const r = await cancelSeries(term.seriesCode, owner);
    expect(r.ok).toBe(true);
    expect((await listClassWaitlist(sessions[1].id))[0]?.status).toBe("offered");
  });
});

describe("E12/H9: a class called off closes its waiting list and tells its coach", () => {
  it("ends every waiting and offered entry, tells each once, and leaves nothing on the customer's account", async () => {
    const [cl] = await classes(1);
    const holder = await enrolInClass({ classId: cl.id, name: "Holder", phone: phone(1) });
    if (!holder.ok) throw new Error("enrol");
    const first = phone(2);
    const second = phone(3);
    const third = phone(4);
    await joinClassWaitlist({ classId: cl.id, name: "First", phone: first, email: "cwc-first@example.com", locale: "ms" });
    await joinClassWaitlist({ classId: cl.id, name: "Second", phone: second, email: "cwc-second@example.com", locale: "ta" });
    await joinClassWaitlist({ classId: cl.id, name: "Third", phone: third });
    // The first is offered the place of a cancelled enrolment before the class is called off.
    await adminCancelBooking(holder.booking.code);
    const offer = (await listWaitlistFor(first))[0];
    expect(offer).toMatchObject({ status: "offered" });
    const session = (await getClass(cl.id))!;

    const result = await cancelClassSession(cl.id);
    expect(result.ok).toBe(true);
    expect(result.closedWaitingIds).toHaveLength(3);
    const rows = (await getDb().prepare("SELECT status, offer_token FROM waitlist WHERE class_id = ?").all(cl.id)) as { status: string; offer_token: string | null }[];
    expect(rows.every((r) => r.status === "cancelled" && r.offer_token === null)).toBe(true);
    expect(await listWaitlistFor(first)).toHaveLength(0);
    expect(await listClassWaitlist(cl.id)).toHaveLength(0);
    // The offer's link is dead.
    expect((await claimWaitlistOffer(offer.offerToken!)).ok).toBe(false);

    await tellClassCancelled(cl.id, session, result);
    // Telling it again (a retry) writes nothing twice.
    await tellClassCancelled(cl.id, session, result);
    const firstMail = (await mailTo("cwc-first@example.com")).filter((m) => m.kind === "waitlist_ended");
    expect(firstMail).toHaveLength(1);
    expect(firstMail[0].locale).toBe("ms");
    expect(firstMail[0].body).toContain("telah dibatalkan");
    const secondMail = (await mailTo("cwc-second@example.com")).filter((m) => m.kind === "waitlist_ended");
    expect(secondMail).toHaveLength(1);
    expect(secondMail[0].locale).toBe("ta");
    expect(secondMail[0].subject).toBe(translator("ta")("fx2.msg.classOffWaitSubject", { venue: session.venueName }));
    // The offer that was live is not also told as an offer.
    expect((await mailTo("cwc-first@example.com")).filter((m) => m.kind === "waitlist_offer")).toHaveLength(0);
    // Closed, not lapsed: nobody is also told their offer ran out.
    await notifyPendingOffers();
    expect((await mailTo("cwc-first@example.com")).filter((m) => m.kind === "waitlist_ended")).toHaveLength(1);
  });

  it("is idempotent: calling it off again changes and tells nothing more", async () => {
    const [cl] = await classes(1);
    const holder = await enrolInClass({ classId: cl.id, name: "Holder", phone: phone(1) });
    if (!holder.ok) throw new Error("enrol");
    await joinClassWaitlist({ classId: cl.id, name: "Waiter", phone: phone(2), email: "cwc-once@example.com" });
    const first = await cancelClassAndTell(cl.id);
    expect(first.ok).toBe(true);
    const again = await cancelClassAndTell(cl.id);
    expect(again.ok).toBe(false);
    expect((await mailTo("cwc-once@example.com")).filter((m) => m.kind === "waitlist_ended")).toHaveLength(1);
  });

  it("refuses a join that comes after the class was called off", async () => {
    const [cl] = await classes(1);
    const holder = await enrolInClass({ classId: cl.id, name: "Holder", phone: phone(1) });
    if (!holder.ok) throw new Error("enrol");
    await cancelClassSession(cl.id);
    expect(await joinClassWaitlist({ classId: cl.id, name: "Late", phone: phone(2) })).toMatchObject({ ok: false, code: "CLASS_CANCELLED" });
  });

  it("tells the instructor, where it is one of the venue's coaches with an address", async () => {
    const coach = await coachWith("cwc-coach-off@example.com", "Coach Off", "ms");
    const [cl] = await classes(3, { coachId: coach.id });
    const pupil = await enrolInClass({ classId: cl.id, name: "Pupil", phone: phone(1) });
    if (!pupil.ok) throw new Error("enrol");
    await cancelClassAndTell(cl.id);
    const mail = await mailTo("cwc-coach-off@example.com");
    expect(mail.filter((m) => m.dedupe_key === `classoff-coach:${cl.id}`)).toHaveLength(1);
    expect(mail[0].kind).toBe("coach_lesson");
    expect(mail[0].locale).toBe("ms");
    expect(mail[0].body).toContain("telah dibatalkan");
    // A second telling (a retry) writes nothing twice.
    await cancelClassAndTell(cl.id);
    expect((await mailTo("cwc-coach-off@example.com")).filter((m) => m.dedupe_key === `classoff-coach:${cl.id}`)).toHaveLength(1);
  });

  it("tells nobody at a coach with no address, and nothing for a class taught by a name only", async () => {
    const saved = await saveCoach(venueId, {
      name: "Coach No Mail",
      sports: ["gym"],
      rate: 60,
      hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: 6 * 60, until: 23 * 60 })),
    });
    if (!saved.ok) throw new Error(saved.error);
    const [withCoach] = await classes(2, { coachId: saved.coach.id });
    const [named] = await classes(2);
    const before = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'coach_lesson'").get()) as { n: number };
    await cancelClassAndTell(withCoach.id);
    await cancelClassAndTell(named.id);
    const after = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'coach_lesson'").get()) as { n: number };
    expect(after.n).toBe(before.n);
  });
});

describe("E12: changing a class's instructor tells the old and the new coach", () => {
  it("tells each of them once, in their own language", async () => {
    const oldCoach = await coachWith("cwc-old-coach@example.com", "Coach Old", "en");
    const newCoach = await coachWith("cwc-new-coach@example.com", "Coach New", "zh");
    const [cl] = await classes(5, { coachId: oldCoach.id });
    const result = await changeClass(cl.id, { coachId: newCoach.id });
    expect(result.ok).toBe(true);
    const old = (await mailTo("cwc-old-coach@example.com")).filter((m) => m.dedupe_key.includes(":Lost"));
    expect(old).toHaveLength(1);
    expect(old[0].locale).toBe("en");
    expect(old[0].body).toContain("no longer teach");
    const next = (await mailTo("cwc-new-coach@example.com")).filter((m) => m.dedupe_key.includes(":Gained"));
    expect(next).toHaveLength(1);
    expect(next[0].locale).toBe("zh");
    expect(next[0].subject).toBe(translator("zh")("fx2.msg.coachClassGainedSubject", { venue: (await getClass(cl.id))!.venueName }));
  });

  it("tells only the coach who stops when the instructor becomes a name, and only the one who starts when it was a name", async () => {
    const coach = await coachWith("cwc-solo-coach@example.com", "Coach Solo");
    const [cl] = await classes(5);
    expect((await changeClass(cl.id, { coachId: coach.id })).ok).toBe(true);
    expect((await mailTo("cwc-solo-coach@example.com")).filter((m) => m.dedupe_key.includes(":Gained"))).toHaveLength(1);
    expect((await changeClass(cl.id, { coachId: null, instructor: "Somebody Else" })).ok).toBe(true);
    expect((await mailTo("cwc-solo-coach@example.com")).filter((m) => m.dedupe_key.includes(":Lost"))).toHaveLength(1);
  });

  it("tells no coach of a change that is not of the coach", async () => {
    const coach = await coachWith("cwc-quiet-coach@example.com", "Coach Quiet");
    const [cl] = await classes(5, { coachId: coach.id });
    const before = (await mailTo("cwc-quiet-coach@example.com")).length;
    expect((await changeClass(cl.id, { price: 35, capacity: 6 })).ok).toBe(true);
    expect((await mailTo("cwc-quiet-coach@example.com")).length).toBe(before);
  });
});
