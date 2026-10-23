import { Court, LATEST_CLOSE_HOUR, OPEN_HOUR, Venue } from "@/lib/types";
import { formatHour } from "@/lib/time";
import { intlTag, region } from "@/lib/region";

/** A venue as the admin panel sees it: the venue and everything bookable in it. */
export type ManagedVenue = Venue & { courts: Court[] };

/** A UTC timestamp as Malaysia-time HH:MM. */
export function localTime(iso: string): string {
  return new Date(iso.includes("Z") || iso.includes("+") ? iso : `${iso.replace(" ", "T")}Z`)
    .toLocaleTimeString(intlTag("en"), {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: region().timeZone,
    });
}

/** Every hour a venue may open or close on, closing up to the small hours of the next morning. */
export const HOUR_CHOICES = Array.from(
  { length: LATEST_CLOSE_HOUR - OPEN_HOUR + 1 },
  (_, i) => OPEN_HOUR + i
);

/** A closing hour as staff read it: past midnight says so. */
export function closeLabel(h: number): string {
  if (h === 24) return "Midnight";
  return h > 24 ? `${formatHour(h)} (next day)` : formatHour(h);
}

/** Today, local time, as the date input wants it. */
export function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: region().timeZone }).format(new Date());
}

/**
 * A venue at 0.4% and a venue at 0% are not the same venue, and rounding both
 * to "0%" hides the only thing the number is for.
 */
export function percent(fraction: number): string {
  const value = fraction * 100;
  if (value === 0) return "0%";
  if (value < 10) return `${value.toFixed(1)}%`;
  return `${Math.round(value)}%`;
}
