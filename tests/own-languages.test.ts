import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined) }),
}));

import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, getAdminById, setAdminLocale, type Admin } from "../src/lib/admin-auth";
import { createSession, registerUser } from "../src/lib/auth";
import { attachCoach, coachById, saveCoach } from "../src/lib/coaching";
import { coachContacts, coachLocale, notifyCoaches, notifyLessonMoved, setCoachEmail, setCoachLink, setCoachLocale } from "../src/lib/coach-schedule";
import { apply, saveRequirement } from "../src/lib/approvals";
import { getDb } from "../src/lib/db";
import { LOCALE_COOKIE } from "../src/lib/i18n";
import { bookingAlerts, setBookingAlerts } from "../src/lib/notify";
import { requestReset, settleResetRequests } from "../src/lib/password-reset";
import { resetRateLimits } from "../src/lib/rate-limit";
import { setFeed } from "../src/lib/staff-calendar";
import { chosenStaffLocale, staffReaderLocale } from "../src/lib/staff-locales";
import { createBooking, createCourt, createVenue } from "../src/lib/store";
import { resetTwoFactorFor } from "../src/lib/two-factor-reset";
import { base32Decode, confirmSetup, currentStep, startSetup, totpCode } from "../src/lib/two-factor";
import { addDays, isPeakMinute, todayISO } from "../src/lib/time";
import { POST as chooseOwn } from "../src/app/api/admin/auth/language/route";
import { GET as me } from "../src/app/api/admin/auth/me/route";
import { POST as addStaff } from "../src/app/api/admin/admins/route";
import { GET as feedAddress } from "../src/app/api/admin/calendar-feed/route";
import { POST as coachesRoute } from "../src/app/api/admin/coaches/route";
import { POST as alertsRoute } from "../src/app/api/admin/booking-alerts/route";
import { POST as coachChooses } from "../src/app/api/coach/[token]/language/route";
import { GET as coachFeed } from "../src/app/api/coach-calendar/[token]/route";
import { POST as book } from "../src/app/api/bookings/route";
import CoachSchedulePage from "../src/app/coach/[token]/page";

/**
 * A language of their own for staff and coaches (the owner's decision of
 * 28 October 2026): stored on the account or coach record, chosen by
 * themselves (the dashboard's switch, the coach's link) or set by a manager,
 * and every message to them written in it, with times as it writes them;
 * none chosen is the install's first staff language, as before.
 */

let venueId: number;
let courtId: number;
let date: string;
let n = 0;

const req = (url: string, method: string, body?: unknown, cookie?: string) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.77.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function staff(email: string, where: { venueId?: number | null; businessId?: number | null; role?: "manager" | "desk" }, locale?: string): Promise<Admin & { cookie: string }> {
  const made = await createAdmin({ name: email.split("@")[0], email, password: "a long enough password", venueId: where.venueId ?? null, businessId: where.businessId ?? null, role: where.role, locale });
  if (!made.ok) throw new Error(made.error);
  return { ...made.admin, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

const mailTo = async (to: string) =>
  (await getDb().prepare("SELECT subject, body, locale, kind FROM messages WHERE recipient = ? ORDER BY id").all(to)) as { subject: string; body: string; locale: string; kind: string }[];

beforeAll(async () => {
  const v = await createVenue({ name: "Bahasa Arena", area: "PJ", address: "1 Jalan Bahasa", phone: "0377771234" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const c = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
  date = addDays(todayISO(), 3);
  while (isPeakMinute(date, 9 * 60)) date = addDays(date, 1);
});

afterEach(() => {
  delete process.env.MYSENAM_COUNTRY;
  cookieJar.clear();
  resetRateLimits();
});

describe("a member of staff's own language", () => {
  it("is one of the staff languages the install offers; none chosen writes in its first", () => {
    expect(chosenStaffLocale("ms")).toBe("ms");
    // Tamil is not a staff language (the owner, 24 October 2026); nor is anything else.
    expect(chosenStaffLocale("ta")).toBeNull();
    expect(chosenStaffLocale("xx")).toBeNull();
    expect(staffReaderLocale(null)).toBe("en");
    // Singapore offers no Malay: a Malay choice falls back to the install's first.
    process.env.MYSENAM_COUNTRY = "SG";
    expect(chosenStaffLocale("ms")).toBeNull();
    expect(staffReaderLocale("ms")).toBe("en");
    expect(staffReaderLocale("zh")).toBe("zh");
  });

  it("may be set by the manager who makes the account, and refused when the dashboard has no such language", async () => {
    const manager = await staff("boss@bahasa.my", {});
    const made = await addStaff(req("/api/admin/admins", "POST", { name: "Mei Ling", email: "mei@bahasa.my", password: "a long enough password", venueId, role: "desk", locale: "zh" }, manager.cookie));
    expect(made.status).toBe(201);
    expect((await made.json()).admin).toMatchObject({ email: "mei@bahasa.my", locale: "zh" });
    const plain = await addStaff(req("/api/admin/admins", "POST", { name: "No Choice", email: "plain@bahasa.my", password: "a long enough password", venueId, locale: "" }, manager.cookie));
    expect((await plain.json()).admin.locale).toBeNull();
    const tamil = await addStaff(req("/api/admin/admins", "POST", { name: "Kavitha", email: "kavitha@bahasa.my", password: "a long enough password", venueId, locale: "ta" }, manager.cookie));
    expect(tamil.status).toBe(400);
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM admins WHERE email = 'kavitha@bahasa.my'").get()) as { n: number }).toEqual({ n: 0 });
  });

  it("is saved to the account by the dashboard's switch (front desk too), read back on sign-in, and cleared", async () => {
    const desk = await staff("desk@bahasa.my", { venueId, role: "desk" });
    expect(desk.locale).toBeNull();
    const chose = await chooseOwn(req("/api/admin/auth/language", "POST", { locale: "ms" }, desk.cookie));
    expect(chose.status).toBe(200);
    expect(await chose.json()).toEqual({ locale: "ms" });
    expect((await getAdminById(desk.id))!.locale).toBe("ms");
    // Another device, signed in afresh: the account says Malay, whatever that browser's cookie.
    const other = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.id)).token}`;
    expect((await (await me(req("/api/admin/auth/me", "GET", undefined, `${other}; ${LOCALE_COOKIE}=en`))).json()).admin.locale).toBe("ms");
    // Refused: not a staff language; not signed in; no locale at all.
    expect((await chooseOwn(req("/api/admin/auth/language", "POST", { locale: "ta" }, desk.cookie))).status).toBe(400);
    expect((await chooseOwn(req("/api/admin/auth/language", "POST", { locale: "zh" }))).status).toBe(401);
    expect((await chooseOwn(req("/api/admin/auth/language", "POST", {}, desk.cookie))).status).toBe(400);
    expect((await getAdminById(desk.id))!.locale).toBe("ms");
    // Null is none chosen again.
    expect(await (await chooseOwn(req("/api/admin/auth/language", "POST", { locale: null }, desk.cookie))).json()).toEqual({ locale: null });
    expect((await getAdminById(desk.id))!.locale).toBeNull();
  });

  it("names the staff calendar's language: theirs where chosen, else the language they read the dashboard in", async () => {
    await setFeed(venueId, true);
    const manager = await staff("feed@bahasa.my", { venueId }, "zh");
    const url = async (cookie: string) => (await (await feedAddress(req(`/api/admin/calendar-feed?venueId=${venueId}`, "GET", undefined, cookie))).json()).url as string;
    expect(await url(`${manager.cookie}; ${LOCALE_COOKIE}=ms`)).toMatch(/[?&]lang=zh$/);
    await setAdminLocale(manager.id, null);
    expect(await url(`${manager.cookie}; ${LOCALE_COOKIE}=ms`)).toMatch(/[?&]lang=ms$/);
  });
});

describe("staff password resets", () => {
  it("are written in the account's own language, the link opening in it; none chosen, the install's first staff language", async () => {
    await staff("reset-zh@bahasa.my", { venueId }, "zh");
    await staff("reset-plain@bahasa.my", { venueId });
    // Whatever language the browser that asked was reading.
    await requestReset("admin", "reset-zh@bahasa.my", "ms");
    await requestReset("admin", "reset-plain@bahasa.my", "ms");
    await settleResetRequests();
    const [zh] = await mailTo("reset-zh@bahasa.my");
    expect(zh).toMatchObject({ locale: "zh", kind: "account_email" });
    expect(zh.subject).toContain("设置新密码");
    expect(zh.body).toMatch(/reset-password\?kind=admin&token=[A-Za-z0-9_-]+&lang=zh/);
    const [plain] = await mailTo("reset-plain@bahasa.my");
    expect(plain.locale).toBe("en");
    expect(plain.subject).toContain("Set a new password");
    expect(plain.body).toMatch(/kind=admin&token=[A-Za-z0-9_-]+&lang=en/);
  });
});

describe("two-factor reset notices", () => {
  it("tell the account in its language, and each owner in theirs", async () => {
    let clock = Date.now();
    const withTwoFactor = async (email: string, where: { venueId?: number | null }, locale?: string) => {
      const a = await staff(email, where, locale);
      const setup = await startSetup(a.id);
      const secret = base32Decode(setup!.secret);
      const done = await confirmSetup(a.id, totpCode(secret, currentStep(clock)));
      if (!done.ok) throw new Error(done.error);
      return { ...a, secret };
    };
    const owner = await withTwoFactor("owner-ms@bahasa.my", {}, "ms");
    await staff("owner-zh@bahasa.my", {}, "zh");
    await staff("owner-plain@bahasa.my", {});
    const target = await withTwoFactor("target-zh@bahasa.my", { venueId }, "zh");
    clock += 30_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock);
    try {
      expect(await resetTwoFactorFor(owner, target.id, { reason: "Seen in person at the desk", code: totpCode(owner.secret, currentStep(clock)) })).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
    const [own] = await mailTo("target-zh@bahasa.my");
    expect(own).toMatchObject({ locale: "zh" });
    expect(own.subject).toContain("双重验证登录已被重置");
    expect(own.body).toContain("owner-ms (owner-ms@bahasa.my)");
    const ms = (await mailTo("owner-ms@bahasa.my")).at(-1)!;
    expect(ms.subject).toContain("log masuk dua faktor ditetapkan semula untuk target-zh");
    expect(ms.body).toContain("Seen in person at the desk");
    expect(ms.body).toContain("Pusat & kakitangan");
    expect((await mailTo("owner-zh@bahasa.my")).at(-1)!.subject).toContain("的双重验证登录已重置");
    const plain = (await mailTo("owner-plain@bahasa.my")).at(-1)!;
    expect(plain.subject).toContain("two-factor sign-in reset for target-zh");
    expect(plain.body).toContain("Nothing needs doing if that is right.");
  });
});

describe("a venue's new-booking alerts", () => {
  it("are written in the language chosen with the address, times as it writes them; none chosen, the install's first", async () => {
    expect((await setBookingAlerts(venueId, { email: "desk@bahasa.my", locale: "ta" })).ok).toBe(false);
    const manager = await staff("alerts@bahasa.my", { venueId });
    const set = await alertsRoute(req("/api/admin/booking-alerts", "POST", { venueId, email: "desk@bahasa.my", phone: "", locale: "ms" }, manager.cookie));
    expect(set.status).toBe(200);
    expect((await set.json()).alerts).toEqual({ email: "desk@bahasa.my", phone: null, locale: "ms" });
    // Changing the address alone keeps the language.
    expect((await setBookingAlerts(venueId, { email: "desk@bahasa.my", phone: "" })).ok).toBe(true);
    expect((await bookingAlerts(venueId)).locale).toBe("ms");

    const booked = async (hour: number, phone: string) => {
      const res = await book(req("/api/bookings", "POST", { courtId, date, hours: [hour], name: "Hafiz Rahman", phone, email: `h${hour}@example.my` }));
      expect(res.status).toBe(201);
      return (await res.json()).booking.id as number;
    };
    const alertOf = async (bookingId: number) =>
      (await getDb().prepare("SELECT subject, body, locale FROM messages WHERE booking_id = ? AND kind = 'venue_new_booking' AND channel = 'email'").get(bookingId)) as {
        subject: string;
        body: string;
        locale: string;
      };
    const malay = await alertOf(await booked(9, "0195550101"));
    expect(malay.locale).toBe("ms");
    expect(malay.subject).toContain("Tempahan baharu");
    expect(malay.subject).toMatch(/9:00 PG/);

    expect((await setBookingAlerts(venueId, { email: "desk@bahasa.my", locale: null })).ok).toBe(true);
    const english = await alertOf(await booked(10, "0195550102"));
    expect(english.locale).toBe("en");
    expect(english.subject).toMatch(/New booking: .*10:00 AM/);
  });
});

describe("a coach's own language", () => {
  let coachMs: number;
  let coachTa: number;
  let coachPlain: number;
  let token: string;

  beforeAll(async () => {
    const make = async (name: string, email: string) => {
      const made = await saveCoach(venueId, { name, sports: ["badminton"], rate: 50, hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: 8 * 60, until: 22 * 60 })) });
      if (!made.ok) throw new Error(made.error);
      expect((await setCoachEmail(made.coach.id, venueId, email)).ok).toBe(true);
      return made.coach.id;
    };
    coachMs = await make("Aminah Coach", "aminah@coach.my");
    coachTa = await make("Kumar Coach", "kumar@coach.my");
    coachPlain = await make("Plain Coach", "plain@coach.my");
    token = (await setCoachLink(coachMs, venueId, true))!.link!.pageUrl.split("/coach/")[1];
  });

  it("is any language the install offers customers, Tamil too; none chosen writes in the first staff language", async () => {
    expect(coachLocale("ta")).toBe("ta");
    expect(coachLocale(null)).toBe("en");
    expect(coachLocale("xx")).toBe("en");
    expect(await setCoachLocale(coachTa, venueId, "xx")).toMatchObject({ ok: false });
    // Another venue's coach is not this venue's to set.
    expect(await setCoachLocale(coachTa, venueId + 999, "ta")).toMatchObject({ ok: false, error: "Coach not found." });
  });

  it("is chosen by the coach at their link, and by staff on the coach's record", async () => {
    const at = (body: unknown, t = token) => coachChooses(req(`/api/coach/${t}/language`, "POST", body), { params: Promise.resolve({ token: t }) });
    const chose = await at({ locale: "ms" });
    expect(chose.status).toBe(200);
    expect(await chose.json()).toEqual({ locale: "ms" });
    expect((await at({ locale: "fr" })).status).toBe(400);
    expect((await at({ locale: "ms" }, "x".repeat(30))).status).toBe(404);
    // Recorded under the coach's name, as their other changes at the link are.
    const logged = (await getDb().prepare("SELECT detail FROM staff_actions WHERE venue_id = ? AND admin_name = 'Aminah Coach' ORDER BY id DESC").get(venueId)) as { detail: string };
    expect(logged.detail).toContain("language ms");

    const manager = await staff("coaches@bahasa.my", { venueId });
    const set = await coachesRoute(req("/api/admin/coaches", "POST", { venueId, id: coachTa, action: "locale", locale: "ta" }, manager.cookie));
    expect(set.status).toBe(200);
    expect((await set.json()).contacts[coachTa]).toMatchObject({ email: "kumar@coach.my", locale: "ta" });
    const desk = await staff("coachdesk@bahasa.my", { venueId, role: "desk" });
    expect((await coachesRoute(req("/api/admin/coaches", "POST", { venueId, id: coachTa, action: "locale", locale: "en" }, desk.cookie))).status).toBe(403);
    expect((await coachContacts(venueId)).get(coachPlain)!.locale).toBeNull();
  });

  it("writes each coach's lesson emails in their own language, times as it writes them", async () => {
    const lesson = async (hour: number, coachId: number) => {
      const b = await createBooking({ courtId, date: addDays(date, 1), hours: [hour], name: "Student", phone: `01233${hour}4444` });
      if (!b.ok) throw new Error(b.error);
      expect(await attachCoach(b.booking.id, (await coachById(coachId))!)).toMatchObject({ ok: true });
      return b.booking.id;
    };
    const ms = await lesson(14, coachMs);
    await lesson(15, coachTa);
    await lesson(16, coachPlain);
    expect(await notifyCoaches()).toBe(3);
    const [aminah] = await mailTo("aminah@coach.my");
    expect(aminah).toMatchObject({ locale: "ms", kind: "coach_lesson" });
    expect(aminah.subject).toMatch(/^Kelas baharu: .*2:00 PTG/);
    const [kumar] = await mailTo("kumar@coach.my");
    expect(kumar.locale).toBe("ta");
    expect(kumar.subject).toMatch(/^புதிய பயிற்சி வகுப்பு: .*15:00/);
    const [plain] = await mailTo("plain@coach.my");
    expect(plain.locale).toBe("en");
    expect(plain.subject).toMatch(/^New lesson: .*4:00 PM/);

    // Handed from one coach to another: each told in their own.
    const row = (await getDb().prepare("SELECT date, start_min, end_min FROM bookings WHERE id = ?").get(ms)) as { date: string; start_min: number; end_min: number };
    await getDb().prepare("UPDATE bookings SET coach_id = ? WHERE id = ?").run(coachPlain, ms);
    expect(await notifyLessonMoved(ms, { date: row.date, startMin: row.start_min, endMin: row.end_min, coachId: coachMs })).toBe(2);
    expect((await mailTo("aminah@coach.my")).at(-1)!.body).toMatch(/2:00 PTG/);
    expect((await mailTo("aminah@coach.my")).at(-1)!.locale).toBe("ms");
    expect((await mailTo("plain@coach.my")).at(-1)!).toMatchObject({ locale: "en" });
    expect((await mailTo("plain@coach.my")).at(-1)!.body).toMatch(/2:00 PM/);
  });

  it("shows their page and calendar in it, whatever the browser or the feed's address says", async () => {
    cookieJar.set(LOCALE_COOKIE, "en");
    const html = renderToStaticMarkup(await CoachSchedulePage({ params: Promise.resolve({ token }) }));
    expect(html).toContain("Aminah Coach: kelas di Bahasa Arena");
    expect(html).toContain("Bahasa anda");
    // The feed the page links to, and one subscribed before in English, both say Malay now.
    expect(html).toContain(`/api/coach-calendar/${token}.ics?lang=ms`);
    const feed = await coachFeed(req(`/api/coach-calendar/${token}.ics?lang=en`, "GET"), { params: Promise.resolve({ token: `${token}.ics` }) });
    expect(await feed.text()).toContain("X-WR-CALNAME:Kelas di Bahasa Arena");
    // None chosen: the page is in the browser's language again.
    expect((await setCoachLocale(coachMs, venueId, null)).ok).toBe(true);
    cookieJar.set(LOCALE_COOKIE, "zh");
    expect(renderToStaticMarkup(await CoachSchedulePage({ params: Promise.resolve({ token }) }))).toContain("Aminah Coach：Bahasa Arena 的课程");
  });
});

describe("emails to an application's reviewers", () => {
  it("go to the alert address in the alerts' language and to each named coach in theirs", async () => {
    const made = await saveCoach(venueId, { name: "Reviewer Coach", sports: ["badminton"], rate: 50, hours: [] });
    if (!made.ok) throw new Error(made.error);
    await setCoachEmail(made.coach.id, venueId, "reviewer@coach.my");
    await setCoachLocale(made.coach.id, venueId, "zh");
    await setBookingAlerts(venueId, { email: "desk@bahasa.my", locale: "ms" });
    const s = await saveRequirement(venueId, { sport: "badminton", declaration: "I have played on a full-size court before.", coachIds: [made.coach.id] });
    expect(s.ok).toBe(true);
    const user = await registerUser({ name: "Applicant One", email: "applicant@example.my", phone: "0129990001", password: "a long enough password" });
    if (!user.ok) throw new Error(user.error);
    await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now') WHERE id = ?").run(user.user.id);
    await createSession(user.user.id);
    const applied = await apply(user.user, { venueId, sport: "badminton", declaration: true, adult: true });
    expect(applied.ok).toBe(true);
    const desk = (await mailTo("desk@bahasa.my")).filter((m) => m.kind === "staff_alert").at(-1)!;
    expect(desk.locale).toBe("ms");
    expect(desk.subject).toBe("Permohonan baharu: Badminton di Bahasa Arena");
    expect(desk.body).toContain("Applicant One telah memohon dalam talian");
    const coach = (await mailTo("reviewer@coach.my")).at(-1)!;
    expect(coach.locale).toBe("zh");
    expect(coach.subject).toContain("新申请：Bahasa Arena 的");
  });
});
