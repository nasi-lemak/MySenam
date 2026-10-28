import type { ProviderId } from "./gateways/types";

/**
 * Which country this install serves: `MYSENAM_COUNTRY`, Malaysia by default.
 *
 * MySenam runs one install per country, so everything that differs between
 * them — the currency, phone numbers, the clock, the languages, the map, the
 * gateway venues connect by default, the laws the terms cite — is read from
 * here rather than written into the code.
 *
 * It works in the browser too: the root layout hands the country code to
 * the language provider, which records it (`setBrowserCountry`) before any
 * client component renders, so the browser formats money as the server does.
 */

export type CountryCode = "MY" | "SG";

export interface Region {
  country: CountryCode;
  name: string;
  currency: {
    /** ISO 4217. */
    code: string;
    /** Written before an amount: RM12, S$12. */
    symbol: string;
    minorUnits: number;
    /** The unit in words: ringgit, dollars. */
    major: string;
    /** Its smallest part in words: sen, cent. */
    minor: string;
  };
  timeZone: string;
  /** Every zone a venue here can be in, the main one first. */
  timeZones: string[];
  /**
   * Hours ahead of UTC. Every country MySenam runs in keeps one offset all
   * year (no daylight saving), so arithmetic on it is safe; a country that
   * changes its clocks would need the zone itself instead.
   */
  utcOffsetHours: number;
  phone: {
    /** Without the plus. */
    countryCode: string;
    /** The local trunk prefix written before a national number, if any. */
    trunk: string;
    /** The fewest digits a phone number can have here, as typed locally. */
    minDigits: number;
    /** How a mobile number is written locally, for placeholders. */
    example: string;
  };
  /** Places people search near, for a placeholder. */
  placeExample: string;
  /** The line under the site's name in the footer. */
  tagline: string;
  /** The languages offered, the first the default. */
  locales: ("en" | "ms" | "zh" | "ta")[];
  map: {
    bounds: { south: number; north: number; west: number; east: number };
    center: [number, number];
    zoom: number;
  };
  gateway: ProviderId;
  /** What sales tax is called here, and a usual rate for a venue to start from. */
  tax: { name: string; venueRate: number };
  /** What the national QR payment scheme is called, for the counter. */
  qrName: string;
  /** What every business SMS must start with here, if anything. */
  smsPrefix: string;
  /** Who to call when somebody is hurt or in danger, as it is dialled there. */
  emergencyNumber: string;
  legal: {
    /** "the laws of Malaysia" */
    governingLaw: string;
    consumerAct: string;
    dataAct: string;
  };
}

const REGIONS: Record<CountryCode, Region> = {
  MY: {
    country: "MY",
    name: "Malaysia",
    currency: { code: "MYR", symbol: "RM", minorUnits: 2, major: "ringgit", minor: "sen" },
    timeZone: "Asia/Kuala_Lumpur",
    // Sabah and Sarawak keep their own name for the same UTC+8.
    timeZones: ["Asia/Kuala_Lumpur", "Asia/Kuching"],
    utcOffsetHours: 8,
    phone: { countryCode: "60", trunk: "0", minDigits: 9, example: "012-345 6789" },
    placeExample: "Bangsar, KLCC",
    tagline: "gelanggang, gim dan kelas, satu tempahan",
    locales: ["en", "ms", "zh", "ta"],
    // Perlis to Sabah, Johor to the Thai border.
    map: { bounds: { south: 0.85, north: 7.4, west: 99.6, east: 119.3 }, center: [4.2, 108], zoom: 5 },
    gateway: "billplz",
    // Service tax on rental and leasing, from 1 January 2026; a venue's
    // accountant says whether court hire is that.
    tax: { name: "SST", venueRate: 6 },
    qrName: "DuitNow QR",
    // Malaysian rules want a text from a business to start with "RM0".
    smsPrefix: "RM0",
    emergencyNumber: "999",
    legal: {
      governingLaw: "the laws of Malaysia",
      consumerAct: "the Consumer Protection Act 1999",
      dataAct: "the Personal Data Protection Act 2010",
    },
  },
  SG: {
    country: "SG",
    name: "Singapore",
    currency: { code: "SGD", symbol: "S$", minorUnits: 2, major: "dollars", minor: "cent" },
    timeZone: "Asia/Singapore",
    timeZones: ["Asia/Singapore"],
    utcOffsetHours: 8,
    phone: { countryCode: "65", trunk: "", minDigits: 8, example: "9123 4567" },
    placeExample: "Tampines, Bishan",
    tagline: "courts, gyms and classes, one booking",
    locales: ["en", "zh", "ta"],
    map: { bounds: { south: 1.15, north: 1.48, west: 103.59, east: 104.1 }, center: [1.352, 103.82], zoom: 11 },
    gateway: "stripe",
    tax: { name: "GST", venueRate: 9 },
    qrName: "PayNow QR",
    smsPrefix: "",
    // Ambulance and fire on 995, police on 999.
    emergencyNumber: "995 / 999",
    legal: {
      governingLaw: "the laws of Singapore",
      consumerAct: "the Consumer Protection (Fair Trading) Act 2003",
      dataAct: "the Personal Data Protection Act 2012",
    },
  },
};

declare global {
  interface Window {
    __MYSENAM_COUNTRY__?: string;
  }
}

function countryCode(): string {
  if (typeof window !== "undefined") return window.__MYSENAM_COUNTRY__ ?? "MY";
  return (process.env.MYSENAM_COUNTRY ?? "MY").trim().toUpperCase();
}

/** Every country an install can be set to, with its zones: for checks across all of them. */
export function allRegions(): Region[] {
  return Object.values(REGIONS);
}

export function region(): Region {
  const code = countryCode();
  return Object.hasOwn(REGIONS, code) ? REGIONS[code as CountryCode] : REGIONS.MY;
}

/**
 * In the browser: which country the server said this install is. Called by
 * the language provider as it renders, before anything below it does.
 */
export function setBrowserCountry(code: string): void {
  if (typeof window !== "undefined") window.__MYSENAM_COUNTRY__ = code;
}

/**
 * An amount as it is shown: RM12, S$18.50. A whole amount has no decimals;
 * any other is shown to the cent, and arithmetic noise (4.8 × 3 =
 * 14.399999…) is rounded away. A string is written as given.
 */
export function money(amount: number | string): string {
  return `${region().currency.symbol}${typeof amount === "number" ? plainAmount(amount) : amount}`;
}

/** The number alone, as `money()` writes it: 12, 18.50. */
export function plainAmount(amount: number): string {
  const r = roundMoney(amount);
  return Number.isInteger(r) ? String(r) : r.toFixed(region().currency.minorUnits);
}

/** Rounded to the currency's smallest unit: to the sen or the cent. */
export function roundMoney(amount: number): number {
  const scale = 10 ** region().currency.minorUnits;
  return Math.round(amount * scale) / scale;
}

/**
 * A price as staff may enter it: a number from `min` to `max`, to the sen
 * or the cent at most (18.50 is a price, 18.505 is not).
 */
export function isAmount(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return false;
  const scale = 10 ** region().currency.minorUnits;
  return Math.abs(value * scale - Math.round(value * scale)) < 1e-6;
}

/** The currency symbol on its own, for a column heading: "Price (RM)". */
export function currencySymbol(): string {
  return region().currency.symbol;
}

/** The install's offset from UTC as ISO 8601 writes it: +08:00. */
export function isoOffset(): string {
  const h = region().utcOffsetHours;
  const sign = h < 0 ? "-" : "+";
  const abs = Math.abs(h);
  return `${sign}${String(Math.floor(abs)).padStart(2, "0")}:${String(Math.round((abs % 1) * 60)).padStart(2, "0")}`;
}

/** The install's offset from UTC, in milliseconds. */
export function offsetMs(): number {
  return region().utcOffsetHours * 3_600_000;
}

/** A BCP 47 tag for Intl formatting in this language and country: en-MY, en-SG. */
export function intlTag(locale: string): string {
  // Simplified script, as Malaysia and Singapore write it.
  return `${locale === "zh" ? "zh-Hans" : locale}-${region().country}`;
}

/**
 * A date as a short label: "24 Oct", or "Sat, 24 Oct" with the weekday.
 *
 * Tamil is put together from its parts, day before month: the CLDR data that
 * orders them differs between Node and browsers (and browser to browser), so
 * a whole-date format would read one way on the server and another on the
 * page, and React would throw the server's render away.
 */
export function shortDate(date: string, locale: string, weekday = false): string {
  const d = new Date(`${date}T00:00:00Z`);
  const tag = intlTag(locale);
  if (locale !== "ta")
    return d.toLocaleDateString(tag, { ...(weekday ? { weekday: "short" } : {}), day: "numeric", month: "short", timeZone: "UTC" });
  const part = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString(tag, { ...o, timeZone: "UTC" });
  const dayMonth = `${d.getUTCDate()} ${part({ month: "short" })}`;
  return weekday ? `${part({ weekday: "short" })}, ${dayMonth}` : dayMonth;
}

/**
 * A time of day as each language writes it, by the one formatter every page,
 * email and message uses (Intl.DateTimeFormat): English "6:30 PM", as the
 * pages have always written it; Malay "6:30 PTG"; Chinese "下午6:30"; Tamil
 * "18:30". Tamil takes the 24-hour clock because its 12-hour form differs
 * between the server's CLDR data ("6:30 PM") and browsers' ("பிற்பகல் 6:30"),
 * and a page must read the same on both (as `shortDate` above). The
 * narrow spaces some runtimes put before "PM" are written as plain spaces,
 * so a time reads (and is found) the same everywhere.
 */
const clockFormats = new Map<string, Intl.DateTimeFormat>();
function clockFormat(locale: string, zone: string): Intl.DateTimeFormat {
  const key = `${locale}|${region().country}|${zone}`;
  let f = clockFormats.get(key);
  if (!f) {
    const tag = locale === "en" ? "en-US" : ["ms", "zh", "ta"].includes(locale) ? intlTag(locale) : "en-US";
    // Chinese is asked for the 12-hour clock outright: browsers without data for "zh-Hans-MY" (Chromium's) fall
    // back to "zh-Hans", whose default is 24-hour ("18:30"), while the server's full data says "下午6:30".
    const cycle = locale === "ta" ? { hourCycle: "h23" as const } : locale === "zh" ? { hourCycle: "h12" as const } : {};
    f = new Intl.DateTimeFormat(tag, { timeZone: zone, hour: "numeric", minute: "2-digit", ...cycle });
    clockFormats.set(key, f);
  }
  return f;
}

/** A moment as the time of day in a zone (a venue's or an event's), in a language: see `clockFormat`. */
export function clockTime(at: Date, zone: string, locale: string = "en"): string {
  return clockFormat(locale, zone).format(at).replace(/[  ]/g, " ");
}

/** A UTC "YYYY-MM-DD HH:MM:SS" as the venue's time of day, for the customer, in their language. */
export function localTimeOf(utc: string, zone: string = region().timeZone, locale: string = "en"): string {
  return clockTime(new Date(`${utc.replace(" ", "T")}Z`), zone, locale);
}

/**
 * A minute of a venue's day (its wall clock: 1110 is 18:30, past 1440 the
 * next morning) as a language writes a time, by `clockTime`: "6:30 PM",
 * "6:30 PTG", "下午6:30", "18:30". The minute is already the venue's clock, so
 * it is written as it stands, whatever zone the reader is in.
 */
export function minuteClock(minute: number, locale: string = "en"): string {
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  return clockTime(new Date(Date.UTC(2000, 0, 1, 0, m)), "UTC", locale);
}

/** An hour as a narrow column's heading, by `minuteClock` less its ":00": "6PM", "6 PTG", "下午6", "18". */
export function hourHeading(minute: number, locale: string = "en"): string {
  const time = minuteClock(minute, locale).replace(":00", "");
  return locale === "en" ? time.replace(" ", "") : time;
}

/** From one minute of a venue's day to another, as a language writes them: "6:00 PM–7:30 PM", "下午6:00–下午7:30". */
export function clockRange(start: number, end: number, locale: string = "en"): string {
  return `${minuteClock(start, locale)}–${minuteClock(end, locale)}`;
}

/** A stored moment: a Date, an ISO time, or the database's UTC "YYYY-MM-DD HH:MM:SS". */
export function momentOf(at: Date | string): Date {
  if (at instanceof Date) return at;
  return new Date(/[TZ+]/.test(at.slice(10)) ? at : `${at.replace(" ", "T")}Z`);
}

/** A day on its own (YYYY-MM-DD) is no moment: it is written as it is, in any zone. */
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * The day (YYYY-MM-DD) a moment falls on in a zone (a venue's or an event's),
 * not the day it was in UTC: a log line from 00:30 in Kuala Lumpur is that
 * day's, though UTC was still on the day before. Staff screens write days so,
 * the same in every language, as a booking's date is written.
 */
export function momentDay(at: Date | string, zone: string): string {
  let f = dayFormats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormats.set(zone, f);
  }
  if (typeof at === "string" && DAY_ONLY.test(at)) return at;
  const d = momentOf(at);
  // Something that is not a moment at all is shown as it came, never thrown over.
  return Number.isNaN(d.getTime()) ? String(at) : f.format(d);
}

/**
 * A moment as staff screens and staff messages write one: its day in the
 * zone and its time of day in the reader's language ("2026-10-24 6:30 PM",
 * "2026-10-24 6:30 PTG", "2026-10-24 下午6:30"). For people only: what is
 * stored, exported or sent to software keeps its own form.
 */
export function momentText(at: Date | string, zone: string, locale: string = "en"): string {
  if (typeof at === "string" && DAY_ONLY.test(at)) return at;
  const d = momentOf(at);
  return Number.isNaN(d.getTime()) ? String(at) : `${momentDay(d, zone)} ${clockTime(d, zone, locale)}`;
}

/** A stored moment's time of day in a zone and a language (`clockTime`); what is not a moment, as it came. */
export function momentClock(at: Date | string, zone: string, locale: string = "en"): string {
  const d = momentOf(at);
  return Number.isNaN(d.getTime()) ? String(at) : clockTime(d, zone, locale);
}

/**
 * English times ("6:30 PM") in text the server wrote in English, as another
 * language writes them: for a refusal shown in that language, whose sentence
 * is translated around the values it carried (lib/staff-i18n). English, and
 * text with no such time, come back as they were.
 */
export function retellTimes(text: string, locale: string): string {
  if (locale === "en") return text;
  return text.replace(/\b(1[0-2]|[1-9]):([0-5]\d) (AM|PM)\b/g, (_, h: string, m: string, half: string) =>
    minuteClock(((Number(h) % 12) + (half === "PM" ? 12 : 0)) * 60 + Number(m), locale)
  );
}
