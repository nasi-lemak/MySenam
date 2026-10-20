import type { ProviderId } from "./gateways/types";

/**
 * Which country this install serves: `MYSENAM_COUNTRY`, Malaysia by default.
 *
 * MySenam runs one install per country, so everything that differs between
 * them — the currency, phone numbers, the clock, the languages, the map, the
 * gateway venues connect by default — is read from here rather than written
 * into the code.
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
  };
  timeZone: string;
  /** The gateway a venue connects unless the install offers others. */
  gateway: ProviderId;
}

const REGIONS: Record<CountryCode, Region> = {
  MY: {
    country: "MY",
    name: "Malaysia",
    currency: { code: "MYR", symbol: "RM", minorUnits: 2 },
    timeZone: "Asia/Kuala_Lumpur",
    gateway: "billplz",
  },
  SG: {
    country: "SG",
    name: "Singapore",
    currency: { code: "SGD", symbol: "S$", minorUnits: 2 },
    timeZone: "Asia/Singapore",
    gateway: "stripe",
  },
};

export function region(): Region {
  const code = (process.env.MYSENAM_COUNTRY ?? "MY").trim().toUpperCase();
  return Object.hasOwn(REGIONS, code) ? REGIONS[code as CountryCode] : REGIONS.MY;
}
