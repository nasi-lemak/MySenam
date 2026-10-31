import { getDb } from "../db";
import { getVenue, quoteFor } from "../store";
import { COUNTER_METHODS, type Court } from "../types";
import { addDays, dayOfWeek, todayISO } from "../time";
import { venueZoneOf } from "../zones";
import { buildSetupPlan, focusIds } from "./plan";
import { setupView, type SetupView } from "./http";
import type { GuideRole } from "./shell";

/**
 * What the setup journey shows beside the plan, read afresh from the venue's
 * saved state for one request (docs/features/venue-guide.md#the-setup-journey):
 *
 * - the plan for a targeted journey (`focus`), built by the same
 *   `buildSetupPlan` from the same profile;
 * - the venue's hours and courts as the existing editors need them, from the
 *   same `getVenue` the dashboard reads;
 * - a **price example**: what one hour at 8 pm on the next Saturday costs on
 *   the venue's own courts, computed by `quoteFor`, the very function a
 *   booking is priced by (never a second price calculation);
 * - the state of *Try it*: what test bookings the venue has made and whether a
 *   counter payment or a cancellation was recorded on one. It is read from
 *   bookings, never ticked by hand.
 *
 * Nothing is stored and nothing is written.
 */

export interface PriceExample {
  courtId: number;
  court: string;
  sport: string;
  /** The Saturday the example is for (YYYY-MM-DD, the venue's own date). */
  date: string;
  /** Minutes of the day the hour starts. */
  startMin: number;
  minutes: number;
  total: number;
  /** Any of the hour is at the peak rate. */
  peak: boolean;
}

export interface TryItState {
  live: boolean;
  /** Test bookings made at this venue (any state). */
  made: number;
  /** Still standing. */
  standing: number;
  /** Cancelled by staff or the customer: not cleared in bulk by the banner. */
  cancelled: number;
  /** One has a payment recorded at the counter. */
  counterPaid: number;
  /** An email service is set up on this install (a message arriving is not checked). */
  emailService: boolean;
  /** The venue's public booking page, where a test booking is made as a customer. */
  publicPath: string;
}

export interface JourneyExtras {
  focus: string | null;
  venue: { openMin: number; closeMin: number; weekHours: unknown; cancelCutoffHours: number; timeZone: string };
  courts: Court[];
  prices: PriceExample[];
  tryIt: TryItState;
}

export type JourneyView = SetupView & { extras: JourneyExtras };

/** The next Saturday after today, in the venue's own zone. */
export function nextSaturday(today: string): string {
  let date = addDays(today, 1);
  while (dayOfWeek(date) !== 6) date = addDays(date, 1);
  return date;
}

const MAX_EXAMPLES = 4;

/** One hour at 8 pm, or the last hour before closing where the venue closes earlier, priced as a booking is. */
async function priceExamples(courts: Court[], date: string, closeMin: number, openMin: number): Promise<PriceExample[]> {
  const out: PriceExample[] = [];
  const seen = new Set<string>();
  for (const court of courts) {
    if (out.length >= MAX_EXAMPLES) break;
    if (court.classesOnly || seen.has(court.sport)) continue;
    if (court.offPeakRate <= 0 && court.peakRate <= 0) continue;
    for (const start of [20 * 60, Math.max(openMin, closeMin - 60)]) {
      const quote = await quoteFor({ courtId: court.id, date, start, minutes: 60 });
      if (!quote.ok) continue;
      seen.add(court.sport);
      out.push({
        courtId: court.id,
        court: court.name,
        sport: court.sport,
        date,
        startMin: start,
        minutes: 60,
        total: quote.quote.total,
        peak: quote.quote.lines.some((l) => l.peak === true),
      });
      break;
    }
  }
  return out;
}

async function tryItState(venueId: number, live: boolean, emailService: boolean): Promise<TryItState> {
  const rows = (await getDb()
    .prepare(
      `SELECT b.status, b.payment_status, b.paid_via,
              EXISTS (SELECT 1 FROM staff_actions a WHERE a.booking_code = b.code AND a.action = 'booking.test_cleared') AS cleared
         FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id = ? AND b.test`
    )
    .all(venueId)) as { status: string; payment_status: string; paid_via: string | null; cleared: boolean }[];
  return {
    live,
    made: rows.length,
    standing: rows.filter((r) => r.status === "confirmed").length,
    cancelled: rows.filter((r) => r.status === "cancelled" && !r.cleared).length,
    counterPaid: rows.filter((r) => r.payment_status === "paid" && (COUNTER_METHODS as readonly string[]).includes(r.paid_via ?? "")).length,
    emailService: emailService,
    publicPath: `/venue/${venueId}`,
  };
}

/** Whether `focus` names a group or a capability a step concerns. */
export const isFocus = (focus: unknown): focus is string => typeof focus === "string" && focusIds().includes(focus);

/**
 * The journey for one venue: the setup view (profile, answers, plan, readiness,
 * discoveries), the plan narrowed to `focus` where one is asked for, and the
 * extras above. All of it is this venue's own and read afresh.
 */
export async function journeyView(venueId: number, role: GuideRole, focus: string | null): Promise<JourneyView> {
  const base = await setupView(venueId, role);
  const plan = focus ? buildSetupPlan({ profile: base.profile, answers: base.answers, acknowledged: base.acknowledged, role, focus }) : base.plan;
  const venue = await getVenue(venueId);
  const zone = venueZoneOf({ time_zone: venue?.timeZone ?? null, lat: venue?.lat ?? null, lng: venue?.lng ?? null });
  const courts = venue?.courts ?? [];
  const today = todayISO(zone);
  return {
    ...base,
    plan,
    extras: {
      focus,
      venue: {
        openMin: venue?.openMin ?? base.profile.hours.openMin,
        closeMin: venue?.closeMin ?? base.profile.hours.closeMin,
        weekHours: venue?.weekHours ?? null,
        cancelCutoffHours: venue?.cancelCutoffHours ?? base.profile.policies.cancellation.cutoffHours,
        timeZone: zone,
      },
      courts,
      prices: await priceExamples(courts, nextSaturday(today), base.profile.hours.closeMin, base.profile.hours.openMin),
      tryIt: await tryItState(venueId, base.profile.identity.live, base.profile.install.emailTransport),
    },
  };
}
