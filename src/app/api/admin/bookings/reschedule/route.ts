import { NextRequest, NextResponse } from "next/server";
import { formatLength, formatMinute, isMinute, parseClock } from "@/lib/interval";
import { breachMessage } from "@/lib/booking-rules";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { notifyRescheduled, tickOutbox } from "@/lib/notify";
import { findBookingByCode, getCourt, getVenueIdForBookingCode, policyForCourt, rescheduleOptions } from "@/lib/store";
import { previewMove, staffMove } from "@/lib/game-moves";
import { logAction } from "@/lib/activity";
import { money } from "@/lib/region";
import { coachNames } from "@/lib/coaching";
import { coachChangeDetail, notifyCoachChanged } from "@/lib/lesson-coaches";
import { bookingLocale } from "@/lib/place-withdrawals";
import { refundCancelled } from "@/lib/payments";
import { jsonObject } from "@/lib/api";

export const dynamic = "force-dynamic";

/** `?code&date[&coachId]` → the start times this booking could change to that day (a lesson: with its coach, or with `coachId`). */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const code = req.nextUrl.searchParams.get("code") ?? "";
  const date = req.nextUrl.searchParams.get("date") ?? "";
  const coach = req.nextUrl.searchParams.get("coachId");
  const coachId = coach ? Number(coach) : undefined;
  if (!code || !/^\d{4}-\d{2}-\d{2}$/.test(date) || (coachId !== undefined && !(Number.isInteger(coachId) && coachId > 0)))
    return NextResponse.json({ error: "code and date are required." }, { status: 400 });
  const venueId = await getVenueIdForBookingCode(code);
  if (venueId === null) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ options: await rescheduleOptions(code, date, coachId !== undefined ? { coachId } : {}) });
}

/**
 * `{ code, date, start, courtId?, coachId?, coachMoney?, override?, preview?, reason? }` →
 * the booking at its new time (`start` in minutes of the day or HH:MM;
 * `startHour` the older form); the customer is told. A lesson moves with its
 * coach, who is told; `coachId` (a manager only) gives it to another of the
 * venue's coaches, at the same time or another; a paid one needs `coachMoney`,
 * `keep` (the price stays as paid) or `adjust` (the difference owed, or given
 * back with a credit note), and the preview shows both (lib/lesson-coaches.ts).
 * The customer and both coaches are told, and the change is in the activity
 * log with who did it, from and to which coach, and the money. `override`: a manager
 * going past the court's booking rules, recorded in the activity log.
 * `preview`: what it would do, changing nothing (lib/game-moves.ts). A
 * booking whose open game has players moves only as the venue's change: a
 * manager's, with a `reason` the players are given, recorded in the log.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let body: Record<string, unknown>;
  try {
    body = (await jsonObject(req)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { code, date, startHour, courtId, coachId, coachMoney, override, preview, reason } = body ?? {};
  const start =
    body.start !== undefined ? (typeof body.start === "string" ? parseClock(body.start) : body.start) : typeof startHour === "number" ? Math.round(startHour * 60) : null;
  if (typeof code !== "string" || typeof date !== "string" || !isMinute(start))
    return NextResponse.json({ error: "code, date and start (minutes of the day or HH:MM) are required." }, { status: 400 });
  if (override === true && admin.role === "desk")
    return NextResponse.json({ error: "Only a manager may move a booking outside the court's booking rules.", code: "OVERRIDE_NOT_ALLOWED" }, { status: 403 });
  if (courtId !== undefined && courtId !== null && !Number.isInteger(courtId))
    return NextResponse.json({ error: "courtId must be a court's id." }, { status: 400 });
  if (coachId !== undefined && coachId !== null && !Number.isInteger(coachId))
    return NextResponse.json({ error: "coachId must be a coach's id." }, { status: 400 });
  if (coachMoney !== undefined && coachMoney !== null && coachMoney !== "keep" && coachMoney !== "adjust")
    return NextResponse.json({ error: "coachMoney is keep or adjust." }, { status: 400 });
  const venueId = await getVenueIdForBookingCode(code);
  if (venueId === null) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  if (typeof courtId === "number") {
    const target = await getCourt(courtId);
    if (!target) return NextResponse.json({ error: "Court not found." }, { status: 404 });
    const deniedTarget = denyVenue(admin, target.venueId);
    if (deniedTarget) return deniedTarget;
  }
  // Another coach for a lesson is a manager's decision (owner's decision, 27 October 2026); the desk moves it with its own.
  const lessonCoach = typeof coachId === "number" ? ((await findBookingByCode(code))?.coachId ?? null) : null;
  const coachChanging = lessonCoach !== null && coachId !== lessonCoach;
  if (coachChanging && admin.role === "desk")
    return NextResponse.json({ error: "Only a manager can give a lesson to another coach.", code: "COACH_CHANGE_MANAGER" }, { status: 403 });
  const to = {
    date,
    start,
    ...(typeof courtId === "number" ? { courtId } : {}),
    ...(typeof coachId === "number" ? { coachId } : {}),
    ...(coachMoney === "keep" || coachMoney === "adjust" ? { coachMoney: coachMoney as "keep" | "adjust" } : {}),
    changedBy: { adminId: admin.id, name: admin.name },
    override: override === true,
  };
  if (preview === true) {
    const seen = await previewMove(code, to, "staff");
    if (!seen.ok) return NextResponse.json(seen, { status: 409 });
    return NextResponse.json({ preview: seen.preview });
  }
  const moved = await staffMove(admin, code, to, typeof reason === "string" ? reason : null);
  if (!moved.ok) return NextResponse.json(moved, { status: moved.status ?? 409 });
  if (moved.outcome === "proposal") return NextResponse.json({ error: "Unexpected." }, { status: 500 });
  const result = moved.result;
  await logAction(admin, {
    venueId,
    action: "booking.rescheduled",
    bookingCode: result.booking.code,
    detail: `${result.from.date} ${formatMinute(result.from.startMin)} → ${result.booking.date} ${formatMinute(result.booking.startMin)}${
      result.priceChange !== 0 ? `, price ${result.priceChange > 0 ? "+" : ""}${money(result.priceChange)}` : ""
    }${moved.outcome === "venue" ? `; open game with players moved by the venue: ${String(reason).trim().slice(0, 300)}` : ""}${
      typeof coachId === "number" && result.booking.coachId === coachId ? `; lesson with ${(await coachNames([result.booking.id])).get(result.booking.id) ?? `coach ${coachId}`}` : ""
    }`,
  });
  const change = result.coachChange;
  if (change)
    await logAction(admin, {
      venueId,
      action: "lesson.coach_changed",
      bookingCode: result.booking.code,
      detail: `${change.fromCoach.name} → ${change.toCoach.name}; ${coachChangeDetail(change)}`,
    });
  if (result.overrides && result.overrides.length > 0) {
    const rules = await policyForCourt(result.booking.courtId);
    await logAction(admin, {
      venueId,
      action: "booking.override",
      bookingCode: result.booking.code,
      detail: `${result.booking.date} ${formatMinute(result.booking.startMin)}, ${formatLength(result.booking.endMin - result.booking.startMin)}: past ${result.overrides
        .map((b) => (rules ? breachMessage(rules, b) : b))
        .join("; ")}`,
    });
  }
  const timeChanged = result.from.date !== result.booking.date || result.from.startMin !== result.booking.startMin || result.from.courtId !== result.booking.courtId;
  if (change) {
    // Given back on the online payment: through the venue's refund path now, as when staff cancel.
    if (change.refund > 0 && change.refundHow === "online") await refundCancelled([result.booking.id], { byVenue: true });
    // The customer hears of the new coach (with the time, and the money) by email, in the language they booked in.
    await notifyCoachChanged(result.booking, change, await bookingLocale(result.booking.id));
  }
  // A new time or court is the venue's change of time as ever: the notice the customer acknowledges.
  if (!change || timeChanged) await notifyRescheduled(result.booking, "staff", result.priceChange);
  await tickOutbox();
  return NextResponse.json({
    booking: result.booking,
    priceChange: result.priceChange,
    unchargedDifference: result.unchargedDifference,
    ...(change ? { coachChange: change } : {}),
  });
}
