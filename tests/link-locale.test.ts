import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

// The language the person chose (the cookie the switch sets), and the one a link carried (the middleware's header).
let cookieLang: string | undefined;
let linkLang: string | undefined;
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000", ...(linkLang ? { "x-mysenam-link-locale": linkLang } : {}) }),
  cookies: async () => ({ get: (name: string) => (name === "ms_lang" && cookieLang ? { value: cookieLang } : undefined) }),
}));

import { NextRequest } from "next/server";
import { middleware } from "../src/middleware";
import { LOCALE_COOKIE, LOCALES } from "../src/lib/i18n";
import { CHOSEN_LOCALE_COOKIE, LINK_LOCALE_COOKIE, LINK_LOCALE_HEADER, LINK_LOCALES, linkIn } from "../src/lib/link-locale";
import { currentLocale } from "../src/lib/locale";
import { notifyBookingConfirmed, notifyPaid, notifyPendingOffers, notifyVenueCancelled } from "../src/lib/notify";
import { cancelBooking, claimWaitlistOffer, createBooking, joinSlotWaitlist, listVenues, setPaymentStatus } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * A link in a message opens in the message's language (lib/link-locale.ts;
 * docs/product/regions-and-tax.md): a fixed `lang` parameter, one
 * of the four languages, read only where the person has not chosen one; the
 * link otherwise exactly what it was, token and all.
 */

afterEach(() => {
  cookieLang = undefined;
  linkLang = undefined;
});

describe("the parameter", () => {
  it("is one of the four languages, added beside what the link already carries, before its fragment", () => {
    expect([...LINK_LOCALES]).toEqual([...LOCALES]);
    expect(linkIn("https://book.example.my/waitlist/abc123", "ms")).toBe("https://book.example.my/waitlist/abc123?lang=ms");
    expect(linkIn("https://book.example.my/receipt/MS-1?t=deadbeef", "zh")).toBe("https://book.example.my/receipt/MS-1?t=deadbeef&lang=zh");
    expect(linkIn("https://book.example.my/account#people", "ta")).toBe("https://book.example.my/account?lang=ta#people");
    // Anything else leaves the link as it was; one that names a language already is not given a second.
    expect(linkIn("https://book.example.my/my-booking", "fr")).toBe("https://book.example.my/my-booking");
    expect(linkIn("https://book.example.my/my-booking", "ms&next=https://evil.example")).toBe("https://book.example.my/my-booking");
    expect(linkIn("https://book.example.my/my-booking?lang=en", "ms")).toBe("https://book.example.my/my-booking?lang=en");
  });

  it("reaches the page through the middleware only as one of the four; what a browser sends of its own is dropped; nothing redirects", () => {
    const forwarded = (url: string, headers: Record<string, string> = {}) => {
      const res = middleware(new NextRequest(url, { headers }));
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      return res.headers.get(`x-middleware-request-${LINK_LOCALE_HEADER}`);
    };
    expect(forwarded("http://localhost/waitlist/abc123?lang=ms")).toBe("ms");
    expect(forwarded("http://localhost/receipt/MS-1?t=x&lang=ta")).toBe("ta");
    expect(forwarded("http://localhost/waitlist/abc123?lang=fr")).toBeNull();
    expect(forwarded("http://localhost/waitlist/abc123?lang=https%3A%2F%2Fevil.example")).toBeNull();
    expect(forwarded("http://localhost/waitlist/abc123", { [LINK_LOCALE_HEADER]: "zh" })).toBeNull();
    expect(forwarded("http://localhost/waitlist/abc123?lang=en", { [LINK_LOCALE_HEADER]: "zh" })).toBe("en");
  });
});

describe("the pages reached from a link", () => {
  const visit = (url: string, cookie?: string) => {
    const res = middleware(new NextRequest(url, { headers: cookie ? { cookie } : {} }));
    return { language: res.headers.get(`x-middleware-request-${LINK_LOCALE_HEADER}`), kept: res.cookies.get(LINK_LOCALE_COOKIE) };
  };

  it("keep the link's language for the visit, by a session cookie of its own, while nobody has chosen one", () => {
    expect(CHOSEN_LOCALE_COOKIE).toBe(LOCALE_COOKIE);
    const opened = visit("https://book.example.my/my-booking?lang=ms");
    expect(opened.language).toBe("ms");
    // Only the language; for the browser session (no expiry); not for scripts; sent back only over HTTPS here.
    expect(opened.kept).toMatchObject({ name: LINK_LOCALE_COOKIE, value: "ms", path: "/", httpOnly: true, sameSite: "lax", secure: true });
    expect(opened.kept?.maxAge).toBeUndefined();
    expect(opened.kept?.expires).toBeUndefined();
    // The next page, without the parameter, is in the link's language too.
    expect(visit("https://book.example.my/venue/3", `${LINK_LOCALE_COOKIE}=ms`)).toEqual({ language: "ms", kept: undefined });
    // A newer link's language replaces it.
    expect(visit("https://book.example.my/receipt/R1?lang=zh", `${LINK_LOCALE_COOKIE}=ms`).kept?.value).toBe("zh");
  });

  it("never override a language chosen with the switch, and keep nothing that is not one of the four", () => {
    expect(visit("https://book.example.my/my-booking?lang=ms", `${LOCALE_COOKIE}=zh`).kept).toBeUndefined();
    expect(visit("https://book.example.my/my-booking?lang=fr").kept).toBeUndefined();
    expect(visit("https://book.example.my/venue/3", `${LINK_LOCALE_COOKIE}=https%3A%2F%2Fevil.example`).language).toBeNull();
  });
});

describe("the language a page opens in", () => {
  it("is the one chosen where there is one, else the link's, else the install's first", async () => {
    expect(await currentLocale()).toBe("en");
    linkLang = "ms";
    expect(await currentLocale()).toBe("ms");
    // An explicit choice wins over the link.
    cookieLang = "zh";
    expect(await currentLocale()).toBe("zh");
    // A language this install does not offer, or none at all, is not taken from a link.
    cookieLang = undefined;
    linkLang = "xx";
    expect(await currentLocale()).toBe("en");
  });
});

describe("links in messages", () => {
  let courtId: number;
  let n = 0;
  const phone = () => `0177${String(++n).padStart(6, "0")}`;
  const book = async (date: string, hour: number, email?: string) => {
    const made = await createBooking({ courtId, date, hours: [hour], name: "Kumar Selvam", phone: phone(), ...(email ? { email } : {}) });
    if (!made.ok) throw new Error(made.error);
    return made.booking;
  };

  beforeAll(async () => {
    const venue = (await listVenues())[0];
    courtId = venue.courts.find((c) => c.capacity === 1)!.id;
  });

  it("a waiting-list offer opens in the entry's language, its token and expiry as they were", async () => {
    const date = addDays(todayISO(), 4);
    const mine = await book(date, 15);
    const joined = await joinSlotWaitlist({ courtId, date, startHour: 15, endHour: 16, name: "Siti Aminah", phone: phone(), email: "siti@lang.test", locale: "ms" });
    expect(joined.ok).toBe(true);
    expect((await cancelBooking(mine.code, mine.phone)).ok).toBe(true);
    const offers = await notifyPendingOffers();
    const email = offers.find((m) => m.channel === "email")!;
    expect(email.locale).toBe("ms");
    const link = /https:\/\/\S+\/waitlist\/([A-Za-z0-9_-]+)\?lang=ms\b/.exec(email.body);
    expect(link).not.toBeNull();
    // The token in the link is the offer's, untouched: it claims the place.
    const claimed = await claimWaitlistOffer(link![1]);
    expect(claimed.ok).toBe(true);
  });

  it("a confirmation, a receipt and a venue's cancellation open in the booking's language", async () => {
    const date = addDays(todayISO(), 5);
    const booking = await book(date, 10, "kumar@lang.test");
    await notifyBookingConfirmed([booking], "zh", null);
    const { messagesForBooking } = await import("../src/lib/outbox");
    const sent = await messagesForBooking(booking.id);
    // On the booking itself, by its signed link (lib/booking-access.ts), the language after it.
    expect(sent.find((m) => m.kind === "booking_confirmed")!.body).toMatch(/\/my-booking\?code=[A-Z0-9-]+&t=[0-9a-z]+\.[0-9a-f]+&lang=zh\b/);

    const { rememberLocale } = await import("../src/lib/notify");
    await rememberLocale([booking.id], "ta");
    expect((await setPaymentStatus(booking.code, true, "cash")).ok).toBe(true);
    await notifyPaid([{ ...booking, paymentStatus: "paid" }], "counter");
    expect((await messagesForBooking(booking.id)).find((m) => m.kind === "payment_received")!.body).toMatch(/\/receipt\/[^?\s]+\?t=[0-9a-f]+&lang=ta\b/);

    await notifyVenueCancelled(booking);
    expect((await messagesForBooking(booking.id)).find((m) => m.kind === "booking_cancelled_by_venue")!.body).toMatch(/\/ack\/[A-Za-z0-9_-]+\?lang=ta\b/);
  });
});
