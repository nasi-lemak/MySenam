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
  /** The languages offered, the first the default. */
  locales: ("en" | "ms")[];
  map: {
    bounds: { south: number; north: number; west: number; east: number };
    center: [number, number];
    zoom: number;
  };
  gateway: ProviderId;
  /** What the national QR payment scheme is called, for the counter. */
  qrName: string;
  /** What every business SMS must start with here, if anything. */
  smsPrefix: string;
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
    utcOffsetHours: 8,
    phone: { countryCode: "60", trunk: "0", minDigits: 9, example: "012-345 6789" },
    placeExample: "Bangsar, KLCC",
    locales: ["en", "ms"],
    // Perlis to Sabah, Johor to the Thai border.
    map: { bounds: { south: 0.85, north: 7.4, west: 99.6, east: 119.3 }, center: [4.2, 108], zoom: 5 },
    gateway: "billplz",
    qrName: "DuitNow QR",
    // Malaysian rules want a text from a business to start with "RM0".
    smsPrefix: "RM0",
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
    utcOffsetHours: 8,
    phone: { countryCode: "65", trunk: "", minDigits: 8, example: "9123 4567" },
    placeExample: "Tampines, Bishan",
    locales: ["en"],
    map: { bounds: { south: 1.15, north: 1.48, west: 103.59, east: 104.1 }, center: [1.352, 103.82], zoom: 11 },
    gateway: "stripe",
    qrName: "PayNow QR",
    smsPrefix: "",
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
  return `${locale}-${region().country}`;
}
