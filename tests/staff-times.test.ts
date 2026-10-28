import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

// The install's first staff language, which coaches are written to in; English unless a test says otherwise.
const install = vi.hoisted(() => ({ firstStaff: null as string | null }));
vi.mock("../src/lib/staff-locales", async (original) => {
  const real = await original<typeof import("../src/lib/staff-locales")>();
  return { ...real, staffLocales: () => (install.firstStaff ? [install.firstStaff, ...real.staffLocales().filter((l) => l !== install.firstStaff)] : real.staffLocales()) };
});

import { NextRequest } from "next/server";
import { describePolicy, PLATFORM_POLICY, policySummary, type BookingPolicy } from "../src/lib/booking-policy";
import { coachCalendar, coachFeedLocale, coachForToken, notifyCoaches, setCoachEmail, setCoachLink } from "../src/lib/coach-schedule";
import { saveCoach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { notifyVenueCancelled } from "../src/lib/notify";
import { clockRange, clockTime, hourHeading, minuteClock, momentClock, momentDay, momentText, retellTimes } from "../src/lib/region";
import { feedLocale, feedUrl, setFeed, staffCalendar } from "../src/lib/staff-calendar";
import { staffRefusal, staffTranslator } from "../src/lib/staff-i18n";
import { clockValue, englishOf, isStaffClock, readStaffText, said } from "../src/lib/staff-text";
import { createBooking, createCourt, createVenue, listVenues } from "../src/lib/store";
import { addDays, formatHour, todayISO } from "../src/lib/time";
import { noticeById } from "../src/lib/urgent";
import { GET as feed } from "../src/app/api/calendar/[token]/route";
import { GET as coachFeed } from "../src/app/api/coach-calendar/[token]/route";

/**
 * Times on the staff dashboard and in what MySenam writes to staff follow the
 * staff language, in the zone of the venue or event (the owner's decision of
 * 28 October 2026). One formatter (lib/region.ts); what software reads
 * (stored values, exports, iCalendar's own fields, the English the server
 * keeps) stays as it was.
 */

afterEach(() => {
  install.firstStaff = null;
});

describe("the shared formatter", () => {
  it("writes a minute of the venue's day in each language, past midnight too", () => {
    expect(["en", "ms", "zh", "ta"].map((l) => minuteClock(18 * 60 + 30, l))).toEqual(["6:30 PM", "6:30 PTG", "下午6:30", "18:30"]);
    expect(minuteClock(25 * 60, "ms")).toBe("1:00 PG");
    // formatHour is the same formatter.
    expect(formatHour(18.5, "zh")).toBe(minuteClock(1110, "zh"));
    expect(clockRange(9 * 60, 10 * 60 + 30, "zh")).toBe("上午9:00–上午10:30");
    expect(clockRange(23 * 60, 25 * 60)).toBe("11:00 PM–1:00 AM");
  });

  it("writes Chinese on the 12-hour clock where a browser has no data for Malaysia's Chinese (Chromium's)", () => {
    // Such a browser formats "zh-Hans-MY" as plain "zh-Hans", whose own default is the 24-hour clock ("18:30").
    const Real = Intl.DateTimeFormat;
    const spy = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (tag?: string | string[], options?: Intl.DateTimeFormatOptions) {
      return new Real(typeof tag === "string" ? tag.replace(/^zh-Hans-[A-Z]{2}$/, "zh-Hans") : tag, options);
    } as unknown as typeof Intl.DateTimeFormat);
    try {
      // A zone no other test formats in, so the formatter is made afresh under the stand-in.
      expect(clockTime(new Date(Date.UTC(2026, 9, 28, 10, 30)), "Asia/Kuching", "zh")).toBe("下午6:30");
      expect(clockTime(new Date(Date.UTC(2026, 9, 28, 1, 5)), "Asia/Kuching", "zh")).toBe("上午9:05");
    } finally {
      spy.mockRestore();
    }
  });

  it("heads a column of hours briefly, English as the schedule always did", () => {
    expect(["en", "ms", "zh", "ta"].map((l) => hourHeading(18 * 60, l))).toEqual(["6PM", "6 PTG", "下午6", "18"]);
    expect(hourHeading(9 * 60 + 30, "en")).toBe("9:30AM");
  });

  it("reads a stored moment on the clock and the day of the venue's zone, not the server's or UTC's", () => {
    // The database's UTC text, an ISO time and a Date are the same moment.
    for (const at of ["2026-10-27 16:30:00", "2026-10-27T16:30:00.000Z", new Date(Date.UTC(2026, 9, 27, 16, 30))]) {
      expect(momentDay(at, "Asia/Kuala_Lumpur")).toBe("2026-10-28");
      expect(momentText(at, "Asia/Kuala_Lumpur", "ms")).toBe("2026-10-28 12:30 PG");
      expect(momentText(at, "Asia/Tokyo", "zh")).toBe("2026-10-28 上午1:30");
      expect(momentClock(at, "America/New_York", "en")).toBe("12:30 PM");
    }
    expect(momentText("2026-10-27 16:30:00", "UTC", "en")).toBe("2026-10-27 4:30 PM");
    // A day alone is no moment: written as it is in any zone.
    expect(momentDay("2026-12-31", "Asia/Tokyo")).toBe("2026-12-31");
    expect(momentText("2026-12-31", "America/New_York", "zh")).toBe("2026-12-31");
    // What is not a moment at all is shown as it came, not thrown over.
    expect(momentText("soon", "Asia/Tokyo", "en")).toBe("soon");
    expect(momentClock("soon", "Asia/Tokyo", "en")).toBe("soon");
    expect(clockTime(new Date(Date.UTC(2026, 9, 27, 1, 30)), "Asia/Kuala_Lumpur", "zh")).toBe("上午9:30");
  });

  it("retells English times in a sentence the server wrote, and nothing else", () => {
    expect(retellTimes("at 6:30 PM and 12:00 AM, on 10:00", "ms")).toBe("at 6:30 PTG and 12:00 PG, on 10:00");
    expect(retellTimes("8:00 AM–11:00 PM", "zh")).toBe("上午8:00–下午11:00");
    expect(retellTimes("6:30 PM", "en")).toBe("6:30 PM");
  });
});

describe("a time the server puts in a phrase for staff", () => {
  it("is kept as a time of day, said in the staff language; the English it always sent is unchanged", () => {
    const when = said("srv.urgent.when", { date: "2026-10-25", from: clockValue(18 * 60), to: clockValue(19 * 60 + 30) });
    expect(englishOf(when)).toBe("2026-10-25, 6:00 PM to 7:30 PM");
    expect(staffTranslator("ms").say(when)).toBe("2026-10-25, 6:00 PTG hingga 7:30 PTG");
    expect(staffTranslator("zh").say(when)).toBe("2026-10-25，下午6:00 至 下午7:30");
    // Stored as JSON and read back, it is still one.
    const back = readStaffText(JSON.stringify(when))!;
    expect(isStaffClock(back.vars!.from)).toBe(true);
    expect(staffTranslator("zh").say(back)).toBe("2026-10-25，下午6:00 至 下午7:30");
  });

  it("a list of start times is said in the staff language, joined as it joins a list", () => {
    const policy = { ...PLATFORM_POLICY, defaultLength: 60, startTimes: [9 * 60, 18 * 60 + 30] } as unknown as BookingPolicy;
    const summary = policySummary(policy);
    expect(englishOf(summary)).toBe(describePolicy(policy));
    expect(englishOf(summary)).toContain("starts at 9:00 AM, 6:30 PM");
    expect(staffTranslator("zh").say(summary)).toContain("开始时间为 上午9:00、下午6:30");
    expect(staffTranslator("ms").say(summary)).toContain("bermula pada 9:00 PG, 6:30 PTG");
  });

  it("a refusal translated around the values it carried says its times in the staff language", () => {
    expect(staffRefusal("Only 2 place(s) are free at 6:30 PM.", "ms")).toBe("Hanya 2 tempat yang kosong pada 6:30 PTG.");
    expect(staffRefusal("The hours must be within the venue's opening hours, which on 2026-11-02 are 8:00 AM–11:00 PM.", "zh")).toBe(
      "时间必须在场馆营业时间内；2026-11-02 的营业时间为 上午8:00–下午11:00。"
    );
    expect(staffTranslator("ms").err({ error: "Only 2 place(s) are free at 6:30 PM." })).toBe("Hanya 2 tempat yang kosong pada 6:30 PTG.");
  });

  it("an urgent notice of a venue's cancellation keeps its hours as times, read in the staff language", async () => {
    const venue = (await listVenues())[0];
    const court = venue.courts.find((c) => c.capacity === 1)!;
    const made = await createBooking({ courtId: court.id, date: addDays(todayISO(venue.timeZone), 4), hours: [18], name: "Nurul Hana", phone: "0161234567" });
    if (!made.ok) throw new Error(made.error);
    const id = await notifyVenueCancelled(made.booking);
    const notice = (await noticeById(id!))!;
    expect(englishOf(notice.summaryPhrase!)).toContain("6:00 PM to 7:00 PM");
    expect(staffTranslator("ms").say(notice.summaryPhrase)).toContain("6:00 PTG hingga 7:00 PTG");
    expect(staffTranslator("zh").say(notice.summaryPhrase)).toContain("下午6:00 至 下午7:00");
  });
});

describe("the staff calendar feed", () => {
  let venueId: number;
  let token: string;
  const date = addDays(todayISO(), 3);
  const get = async (lang?: string) =>
    (await feed(new NextRequest(`http://localhost/api/calendar/${token}.ics${lang ? `?lang=${lang}` : ""}`), { params: Promise.resolve({ token: `${token}.ics` }) })).text();
  const unfold = (ics: string) => ics.replace(/\r\n /g, "").split("\r\n");
  const machine = (ics: string) => unfold(ics).filter((l) => /^(DTSTART|DTEND|UID|X-WR-TIMEZONE|BEGIN|END)/.test(l));

  beforeAll(async () => {
    const v = await createVenue({ name: "Feed Hall", area: "PJ", address: "1 Jalan Masa", phone: "0377771111" });
    if (!v.ok) throw new Error(v.error);
    venueId = v.venue.id;
    const c = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
    if (!c.ok) throw new Error(c.error);
    const b = await createBooking({ courtId: c.court.id, date, hours: [18], name: "Priya Devi", phone: "0163211606" });
    if (!b.ok) throw new Error(b.error);
    token = (await setFeed(venueId, true))!;
  });

  it("says what people read in the language its address names, its times as that language writes them", async () => {
    const en = unfold(await get());
    expect(en).toContain("X-WR-CALNAME:Feed Hall bookings");
    expect(en.some((l) => l.startsWith("SUMMARY:Court 1: Priya Devi (unpaid)"))).toBe(true);
    expect(en.some((l) => /^DESCRIPTION:MS-\w+\\, 6:00 PM–7:00 PM\\nPriya Devi\\, 0163211606\\nRM20\\, not paid yet$/.test(l))).toBe(true);
    const ms = unfold(await get("ms"));
    expect(ms).toContain("X-WR-CALNAME:Tempahan Feed Hall");
    expect(ms.some((l) => l.startsWith("SUMMARY:Court 1: Priya Devi (belum dibayar)"))).toBe(true);
    expect(ms.some((l) => /^DESCRIPTION:MS-\w+\\, 6:00 PTG–7:00 PTG\\n.*\\nRM20\\, belum dibayar$/.test(l))).toBe(true);
    const zh = unfold(await get("zh"));
    expect(zh.some((l) => /^DESCRIPTION:MS-\w+\\, 下午6:00–下午7:00/.test(l))).toBe(true);
  });

  it("keeps what calendar apps read exactly as it was, in every language", async () => {
    const en = machine(await get());
    expect(machine(await get("ms"))).toEqual(en);
    expect(machine(await get("zh"))).toEqual(en);
  });

  it("names a staff language in its address; a language staff screens do not have, or none, is the install's first", async () => {
    expect(await feedUrl(venueId, token, "ms")).toBe(`https://book.example.my/api/calendar/${token}.ics?lang=ms`);
    expect(await feedUrl(venueId, token)).toBe(`https://book.example.my/api/calendar/${token}.ics`);
    expect([feedLocale("zh"), feedLocale("ta"), feedLocale("xx"), feedLocale(null)]).toEqual(["zh", "en", "en", "en"]);
    expect(await get("ta")).toBe(await get());
    expect(await staffCalendar(venueId, "zh")).toBe(await get("zh"));
  });
});

describe("what coaches are sent", () => {
  let venueId: number;
  let coachId: number;
  let token: string;
  const date = addDays(todayISO(), 5);

  beforeAll(async () => {
    const v = await createVenue({ name: "Lesson Hall", area: "PJ", address: "2 Jalan Ajar", phone: "0377772222" });
    if (!v.ok) throw new Error(v.error);
    venueId = v.venue.id;
    const c = await createCourt({ venueId, name: "Court 1", sport: "tennis", offPeakRate: 20, peakRate: 20 });
    if (!c.ok) throw new Error(c.error);
    const k = await saveCoach(venueId, { name: "Ana Lim", sports: ["tennis"], rate: 80, hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: 8 * 60, until: 22 * 60 })) });
    if (!k.ok) throw new Error(k.error);
    coachId = k.coach.id;
    const b = await createBooking({ courtId: c.court.id, date, hours: [18], name: "Pupil Tan", phone: "0123456700" });
    if (!b.ok) throw new Error(b.error);
    await getDb().prepare("UPDATE bookings SET coach_id = ? WHERE id = ?").run(coachId, b.booking.id);
    await setCoachEmail(coachId, venueId, "ana@lesson.my");
    token = (await setCoachLink(coachId, venueId, true))!.link!.pageUrl.split("/coach/")[1];
  });

  it("emails in the install's first staff language, the lesson's hours as it writes them", async () => {
    install.firstStaff = "ms";
    expect(await notifyCoaches()).toBe(1);
    const sent = (await getDb().prepare("SELECT locale, body FROM messages WHERE kind = 'coach_lesson' AND recipient = 'ana@lesson.my'").get()) as { locale: string; body: string };
    expect(sent.locale).toBe("ms");
    expect(sent.body).toContain(`${date}, 6:00 PTG–7:00 PTG`);
    expect(sent.body).not.toMatch(/\b(AM|PM)\b/);
  });

  it("a coach's calendar says its words and times in the language its link names; its fields as they were", async () => {
    const found = (await coachForToken(token))!;
    const en = await coachCalendar(found, venueId);
    expect(en).toContain("X-WR-CALNAME:Lessons at Lesson Hall");
    expect(en).toContain("SUMMARY:Lesson: Pupil Tan\\, Court 1");
    expect(en).toMatch(/DESCRIPTION:MS-\w+\\, 6:00 PM–7:00 PM/);
    const res = await coachFeed(new NextRequest(`http://localhost/api/coach-calendar/${token}.ics?lang=zh`), { params: Promise.resolve({ token: `${token}.ics` }) });
    const zh = await res.text();
    expect(zh).toContain("X-WR-CALNAME:Lesson Hall 的课程");
    expect(zh).toContain("SUMMARY:课程：Pupil Tan，Court 1");
    expect(zh).toMatch(/DESCRIPTION:MS-\w+\\, 下午6:00–下午7:00/);
    const fields = (ics: string) => ics.split("\r\n").filter((l) => /^(DTSTART|DTEND|UID|X-WR-TIMEZONE)/.test(l));
    expect(fields(zh)).toEqual(fields(en));
    expect([coachFeedLocale("ta"), coachFeedLocale("xx"), coachFeedLocale(undefined)]).toEqual(["ta", "en", "en"]);
  });
});
