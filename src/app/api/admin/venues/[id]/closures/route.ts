import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin, type Admin } from "@/lib/admin-auth";
import { logAction, logCancelledBookings, logClassCancelled } from "@/lib/activity";
import { refundCancelled } from "@/lib/payments";
import { refusal } from "@/lib/api";
import { closeVenueDay, closureRefusal, listVenueClosures, reopenVenueDay, venueHours } from "@/lib/store";
import { instantOf } from "@/lib/interval";
import { venueCancel } from "@/lib/counter-refunds";
import { owingCustomer } from "@/lib/notices-owed";
import { getDb } from "@/lib/db";
import { cancelClassAndTell, notifyVenueCancelled, tickOutbox } from "@/lib/notify";
import { isValidDateString, todayISO } from "@/lib/time";
import type { Booking } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Resolve the venue in the path, checking this admin may touch it. */
async function scope(
  req: NextRequest,
  params: Promise<{ id: string }>
): Promise<{ admin: Admin; venueId: number } | NextResponse> {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const { id } = await params;
  const venueId = Number(id);
  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "Invalid venue id." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return { admin, venueId };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const scoped = await scope(req, params);
  if (scoped instanceof NextResponse) return scoped;
  return NextResponse.json({ closures: await listVenueClosures(scoped.venueId, todayISO()) });
}

/**
 * `{ date, reason?, cancelAffected?, safety? }` — close the venue for a day (`safety`: a safety closure, ADR 0046). Written
 * in the activity log: the closure with what it called off, a
 * `class.cancelled` for each class, and a `booking.cancelled` for each
 * booking and enrolment it cancelled, so each customer's booking says who.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const scoped = await scope(req, params);
  if (scoped instanceof NextResponse) return scoped;
  const { admin, venueId } = scoped;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;
  const date = input.date;
  if (typeof date !== "string" || !isValidDateString(date))
    return NextResponse.json({ error: "A valid date is required." }, { status: 400 });
  const reason = typeof input.reason === "string" ? input.reason : undefined;

  // A day gone by cannot be shut: said before anything is cancelled or refunded.
  const past = await closureRefusal(venueId, date);
  if (past) return refusal(past, 400);

  // Closing over bookings: not without saying so, and then the customers are
  // told — an unexpected closure is exactly what must not go unheard. What
  // has been played (a booking or class that ended) is history and is left
  // alone, as it is by every cancellation the venue makes.
  const db = getDb();
  const { zone } = await venueHours(venueId, date);
  const standing = async () => {
    const now = Date.now();
    const bookings = (await db
      .prepare(
        `SELECT b.code, b.end_min FROM bookings b JOIN courts c ON c.id = b.court_id
          WHERE c.venue_id = ? AND b.date = ? AND b.status = 'confirmed' AND b.class_id IS NULL ORDER BY b.start_min`
      )
      .all(venueId, date)) as { code: string; end_min: number }[];
    const classes = (await db
      .prepare(
        `SELECT cl.id, cl.end_min FROM classes cl JOIN courts c ON c.id = cl.court_id
          WHERE c.venue_id = ? AND cl.date = ? AND cl.status = 'scheduled' ORDER BY cl.start_min`
      )
      .all(venueId, date)) as { id: number; end_min: number }[];
    return {
      bookings: bookings.filter((b) => instantOf(date, b.end_min, zone).getTime() > now),
      classes: classes.filter((c) => instantOf(date, c.end_min, zone).getTime() > now),
    };
  };
  const first = await standing();
  if ((first.bookings.length > 0 || first.classes.length > 0) && input.cancelAffected !== true)
    return NextResponse.json(
      {
        error: `${date} has ${first.bookings.length} booking${first.bookings.length === 1 ? "" : "s"} and ${first.classes.length} class${first.classes.length === 1 ? "" : "es"}. Cancel them and tell the customers, or move them first.`,
        bookings: first.bookings.length,
        classes: first.classes.length,
      },
      { status: 409 }
    );

  // The closure is the decision, and it is written first: from the moment it is committed nothing is offered, claimed or
  // booked on that day, and a booking made at the same moment either completes before it (and is cancelled below with the
  // rest) or is refused after it. Then what is booked is cancelled, refunded and told, and the sweep goes round again for
  // anything that arrived before the closure was written. Run again after an error, it carries on with what is left.
  const safety = input.safety === true;
  const result = await closeVenueDay(venueId, date, reason, { safety, refuseIfBooked: input.cancelAffected !== true });
  if (!result.ok) return refusal(result, "code" in result && result.code ? 400 : 409);

  const why = `the venue closed for ${date}${reason?.trim() ? ` (${reason.trim().slice(0, 80)})` : ""}`;
  let cancelled = 0;
  let classesOff = 0;
  let enrolments = 0;
  const offed: Booking[] = [];
  // What could not be called off (kit still out): named, so the desk deals with it once the kit is back.
  const left = new Map<string, { ref: string; why: string }>();
  const handled = new Set<string>();
  for (let round = 0; round < 4; round++) {
    const now = await standing();
    const classes = now.classes.filter((c) => !handled.has(`c${c.id}`));
    const bookings = now.bookings.filter((b) => !handled.has(`b${b.code}`));
    if (classes.length === 0 && bookings.length === 0) break;
    for (const cl of classes) {
      handled.add(`c${cl.id}`);
      const done = await cancelClassAndTell(cl.id, undefined, "closure");
      if (!done.ok) continue;
      cancelled++;
      classesOff++;
      enrolments += done.cancelled?.length ?? 0;
      if (done.session) await logClassCancelled(admin, done.session, done.cancelled ?? [], why);
    }
    for (const b of bookings) {
      handled.add(`b${b.code}`);
      // A counter payment is owed back, for the desk to settle (lib/counter-refunds.ts). Nothing is offered: the day is closed.
      const done = await owingCustomer("booking_cancelled_by_venue", () => venueCancel(b.code, "closure", { offer: false }));
      if (!done.ok) {
        if (!("code" in done && (done.code === "ALREADY_CANCELLED" || done.code === "CANCEL_PLAYED"))) left.set(b.code, { ref: b.code, why: done.error });
        continue;
      }
      cancelled++;
      offed.push(done.booking);
      await refundCancelled([done.booking.id], { byVenue: true });
      await notifyVenueCancelled(done.booking);
    }
  }
  if (cancelled > 0) await tickOutbox();
  await logCancelledBookings(admin, venueId, offed, why);

  await logAction(admin, {
    venueId,
    action: "day.closed",
    detail: `${date}${safety ? " [safety closure]" : ""}${result.closure.reason ? ` (${result.closure.reason})` : ""}: ${offed.length} booking(s) and ${classesOff} class(es) with ${enrolments} enrolment(s) cancelled${left.size > 0 ? `; still standing, for the desk: ${[...left.keys()].join(", ")}` : ""}`,
  });
  // Tournament matches and team-league fixtures drawn at the venue that day stay where they were drawn: staff are shown them, the entrants and captains
  // are told once (the venue will rearrange them), and staff move them with one action per day (lib/competition-fixtures.ts, ADR 0059).
  const competition = await import("@/lib/competition-fixtures");
  const fixtures = await competition.fixturesOnVenueDay(venueId, date);
  await competition.tellFixturesLost(fixtures, "closure");
  if (fixtures.length > 0) {
    await tickOutbox();
    await logAction(admin, { venueId, action: "day.closed", detail: `${date}: ${fixtures.length} tournament or team-league fixture(s) still drawn that day, their people told, to be rearranged` });
  }
  return NextResponse.json({ closure: result.closure, cancelled, left: [...left.values()], fixtures }, { status: 201 });
}

/** `?date=` — open a closed day again. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const scoped = await scope(req, params);
  if (scoped instanceof NextResponse) return scoped;

  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!isValidDateString(date))
    return NextResponse.json({ error: "A valid date is required." }, { status: 400 });
  if (!(await reopenVenueDay(scoped.venueId, date)).ok)
    return NextResponse.json({ error: "That day is not closed." }, { status: 404 });
  await logAction(scoped.admin, { venueId: scoped.venueId, action: "day.reopened", detail: date });
  return NextResponse.json({ ok: true });
}
