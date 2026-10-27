import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

import { getDb } from "../src/lib/db";
import { formatMinute } from "../src/lib/interval";
import { notifyBookingConfirmed } from "../src/lib/notify";
import { messagesForBooking } from "../src/lib/outbox";
import { clockTime, localTimeOf } from "../src/lib/region";
import { createResources } from "../src/lib/resources";
import { createBooking, createVenue } from "../src/lib/store";
import { addDays, formatHour, todayISO } from "../src/lib/time";

/**
 * Times in every language by one formatter (Intl.DateTimeFormat; lib/region.ts
 * `clockTime`, lib/time.ts `formatHour`), the same on pages and in messages,
 * in the venue's time zone: English "6:30 PM" as the pages always wrote it,
 * Malay "6:30 PTG", Chinese "下午6:30", Tamil on the 24-hour clock ("18:30").
 * Never Malay written in the English 12-hour form.
 */

const LOCALES = ["en", "ms", "zh", "ta"] as const;

/** Morning, afternoon, and a late booking that runs past midnight, as each language writes them. */
const EXPECTED = {
  en: { morning: ["9:30 AM", "10:30 AM"], afternoon: ["2:00 PM", "3:00 PM"], late: ["11:00 PM", "1:00 AM"] },
  ms: { morning: ["9:30 PG", "10:30 PG"], afternoon: ["2:00 PTG", "3:00 PTG"], late: ["11:00 PTG", "1:00 PG"] },
  zh: { morning: ["上午9:30", "上午10:30"], afternoon: ["下午2:00", "下午3:00"], late: ["下午11:00", "上午1:00"] },
  ta: { morning: ["09:30", "10:30"], afternoon: ["14:00", "15:00"], late: ["23:00", "01:00"] },
} as const;
const SPANS = { morning: [9.5, 10.5], afternoon: [14, 15], late: [23, 25] } as const;

describe("a time of day", () => {
  it("is written as each language writes one: morning, afternoon, and past midnight", () => {
    for (const locale of LOCALES)
      for (const [part, [from, to]] of Object.entries(SPANS) as [keyof typeof SPANS, readonly [number, number]][]) {
        expect([formatHour(from, locale), formatHour(to, locale)], `${locale} ${part}`).toEqual([...EXPECTED[locale][part]]);
        expect([formatMinute(from * 60, locale), formatMinute(to * 60, locale)]).toEqual([...EXPECTED[locale][part]]);
      }
    // English unchanged from what pages always showed, plain spaces and all; English is the default.
    expect(formatHour(18.5)).toBe("6:30 PM");
    expect(formatHour(0)).toBe("12:00 AM");
    expect(formatHour(12)).toBe("12:00 PM");
    expect(formatHour(18.5, "en")).not.toMatch(/[\u202f\u00a0]/);
  });

  it("is a moment read in the venue's zone, not the server's", () => {
    // 16:30 UTC is half past midnight the next day in Kuala Lumpur; 01:30 UTC is 9:30 in the morning there.
    const late = new Date("2026-10-27T16:30:00Z");
    const morning = new Date("2026-10-27T01:30:00Z");
    const kl = "Asia/Kuala_Lumpur";
    expect(LOCALES.map((l) => clockTime(late, kl, l))).toEqual(["12:30 AM", "12:30 PG", "上午12:30", "00:30"]);
    expect(LOCALES.map((l) => clockTime(morning, kl, l))).toEqual(["9:30 AM", "9:30 PG", "上午9:30", "09:30"]);
    // Somewhere else, the same moment is another time.
    expect(clockTime(morning, "America/New_York", "en")).toBe("9:30 PM");
    expect(localTimeOf("2026-10-27 06:00:00", kl, "ms")).toBe("2:00 PTG");
  });
});

describe("in a confirmation email", () => {
  let courtId: number;
  let n = 0;

  beforeAll(async () => {
    // A venue open until 2 AM, so a booking can run past midnight, on Kuala Lumpur's clock.
    const v = await createVenue({ name: "Dewan Malam", area: "Cheras", address: "x", phone: "0391110000", openMin: 7 * 60, closeMin: 26 * 60 });
    if (!v.ok) throw new Error(v.error);
    await getDb().prepare("UPDATE venues SET time_zone = 'Asia/Kuala_Lumpur' WHERE id = ?").run(v.venue.id);
    const r = await createResources({ venueId: v.venue.id, sport: "badminton", name: "Court A", offPeakRate: 20, peakRate: 20 });
    if (!r.ok) throw new Error(r.error);
    courtId = r.courts[0].id;
  });

  it("says the hours in the customer's language: Malay, Chinese and Tamil are not written the English way", async () => {
    for (const [i, locale] of LOCALES.entries())
      for (const [j, part] of (["morning", "afternoon", "late"] as const).entries()) {
        const [from, to] = SPANS[part];
        const date = addDays(todayISO("Asia/Kuala_Lumpur"), 2 + i * 3 + j);
        // Booked by staff past the hourly starts, so 9:30 is booked as it is.
        const made = await createBooking({ courtId, date, start: from * 60, end: to * 60, name: "Nurul Aina", phone: `0179${String(++n).padStart(6, "0")}`, email: `t${n}@times.test`, staff: { override: true } });
        if (!made.ok) throw new Error(`${locale} ${part}: ${made.error}`);
        await notifyBookingConfirmed([made.booking], locale, null);
        const mail = (await messagesForBooking(made.booking.id)).find((m) => m.channel === "email")!;
        const [a, b] = EXPECTED[locale][part];
        expect(mail.body, `${locale} ${part}`).toContain(a);
        expect(mail.body, `${locale} ${part}`).toContain(b);
        if (locale !== "en") expect(mail.body, `${locale} ${part}`).not.toMatch(/\d:\d\d (AM|PM)/);
      }
  });
});
