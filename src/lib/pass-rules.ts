import type { Pass } from "./types";

/**
 * What a booking spends from a pass (lib/store.ts `payBookingWithPass`),
 * browser-safe so the booking form can say it before the booking is made.
 *
 * A time pass spends the minutes booked, to the minute. A session pass
 * spends entries: one per `entryMinutes` or part of them, or one a booking
 * whatever its length when it has none. Either may cap the length of a
 * booking it pays for.
 */
export function passCost(
  pass: Pick<Pass, "kind" | "entryMinutes" | "maxMinutes">,
  minutes: number
): { ok: true; units: number } | { ok: false; error: string; maxMinutes: number } {
  if (pass.maxMinutes !== null && minutes > pass.maxMinutes)
    return { ok: false, error: `That pass pays for bookings up to ${pass.maxMinutes} minutes.`, maxMinutes: pass.maxMinutes };
  if (pass.kind === "time") return { ok: true, units: minutes };
  return { ok: true, units: pass.entryMinutes === null ? 1 : Math.ceil(minutes / pass.entryMinutes) };
}
