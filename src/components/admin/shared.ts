import { Court, LATEST_CLOSE_HOUR, OPEN_HOUR, Venue } from "@/lib/types";
import { momentClock, region } from "@/lib/region";

/** A venue as the admin panel sees it: the venue and everything bookable in it. */
export type ManagedVenue = Venue & { courts: Court[] };

/**
 * A stored moment (UTC) as the time of day in a zone, in a language
 * (lib/region.ts `clockTime`): "6:30 PM", "6:30 PTG", "下午6:30". Screens
 * use `useStaffClock` (StaffLanguage.tsx), which knows the staff language and
 * each venue's zone.
 */
export function localTime(iso: string, locale: string = "en", zone: string = region().timeZone): string {
  return momentClock(iso, zone, locale);
}

/** Every hour a venue may open or close on, closing up to the small hours of the next morning. */
export const HOUR_CHOICES = Array.from(
  { length: LATEST_CLOSE_HOUR - OPEN_HOUR + 1 },
  (_, i) => OPEN_HOUR + i
);

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
