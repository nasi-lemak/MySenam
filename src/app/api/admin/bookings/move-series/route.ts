import { NextRequest, NextResponse } from "next/server";
import { canAccessVenue, denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { readJsonObject, refusal } from "@/lib/api";
import { breachMessage } from "@/lib/booking-rules";
import { seriesVenueIds } from "@/lib/counter-refunds";
import { formatLength, formatMinute, isMinute, parseClock } from "@/lib/interval";
import { notifySeriesMoved, tickOutbox } from "@/lib/notify";
import { money } from "@/lib/region";
import { moveSeries, previewSeriesMove, seriesMoveChoices, type SeriesMoveTo } from "@/lib/series-moves";
import { getCourt, policyForCourt } from "@/lib/store";
import { windowOverrideFromBody } from "@/lib/counter-policy";

export const dynamic = "force-dynamic";

/** `?seriesCode=`: the series as it is now (weekday, start and court of its next week, how many weeks are left) and its venue's courts for it. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const seriesCode = req.nextUrl.searchParams.get("seriesCode") ?? "";
  if (seriesCode.trim() === "") return NextResponse.json({ error: "seriesCode is required." }, { status: 400 });
  const venueIds = await seriesVenueIds(seriesCode);
  if (venueIds.length === 0) return NextResponse.json({ error: "Series not found." }, { status: 404 });
  if (!venueIds.every((id) => canAccessVenue(admin, id))) return NextResponse.json({ error: "You do not manage that venue." }, { status: 403 });
  const choices = await seriesMoveChoices(seriesCode);
  if (!choices.ok) return refusal(choices, 404);
  return NextResponse.json({ weekday: choices.weekday, start: choices.start, courtId: choices.courtId, weeks: choices.weeks, courts: choices.courts });
}

/**
 * Staff move the weeks of a weekly series still to be played in one step
 * (lib/series-moves.ts): `{seriesCode, start, weekday?, courtId?, override?, preview: true}`
 * says, week by week, where each would go, what it would cost, and which
 * cannot move and why; `{…, codes?, reason?}` moves the weeks chosen (every
 * week that is still to be played where `codes` is not given), each by the
 * single staff move. `start` is minutes of the day or HH:MM; `weekday` 0
 * (Sunday) to 6, in each week's own Monday-to-Sunday week. The customer is
 * told once; each week and the series are in the activity log.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const { seriesCode, weekday, courtId, override, preview, codes, reason } = body;
  const start = typeof body.start === "string" ? parseClock(body.start) : body.start;
  if (typeof seriesCode !== "string" || seriesCode.trim() === "") return NextResponse.json({ error: "seriesCode is required." }, { status: 400 });
  if (!isMinute(start)) return NextResponse.json({ error: "start (minutes of the day or HH:MM) is required." }, { status: 400 });
  if (weekday !== undefined && weekday !== null && !(Number.isInteger(weekday) && (weekday as number) >= 0 && (weekday as number) <= 6))
    return NextResponse.json({ error: "weekday is 0 (Sunday) to 6 (Saturday)." }, { status: 400 });
  if (courtId !== undefined && courtId !== null && !Number.isInteger(courtId)) return NextResponse.json({ error: "courtId must be a court's id." }, { status: 400 });
  if (codes !== undefined && !(Array.isArray(codes) && codes.every((c) => typeof c === "string")))
    return NextResponse.json({ error: "codes must be a list of booking codes." }, { status: 400 });
  if (override === true && admin.role === "desk")
    return NextResponse.json({ error: "Only a manager may move a booking outside the court's booking rules.", code: "OVERRIDE_NOT_ALLOWED" }, { status: 403 });

  const venueIds = await seriesVenueIds(seriesCode);
  if (venueIds.length === 0) return NextResponse.json({ error: "Series not found." }, { status: 404 });
  if (!venueIds.every((id) => canAccessVenue(admin, id))) return NextResponse.json({ error: "You do not manage that venue." }, { status: 403 });
  if (typeof courtId === "number") {
    const court = await getCourt(courtId);
    if (!court) return NextResponse.json({ error: "Court not found." }, { status: 404 });
    const denied = denyVenue(admin, court.venueId);
    if (denied) return denied;
  }
  // A manager's override of an advisory launch or tide window for each week moved, with its reason (lib/window-overrides.ts).
  const windowAsk = await windowOverrideFromBody(body, admin, venueIds[0]);
  if (windowAsk.refuse) return windowAsk.refuse;
  const to: SeriesMoveTo = {
    start,
    ...(typeof weekday === "number" ? { weekday } : {}),
    ...(typeof courtId === "number" ? { courtId } : {}),
    ...(override === true ? { override: true } : {}),
    ...(windowAsk.record ? { windowOverride: windowAsk.record } : {}),
  };

  if (preview === true) {
    const plan = await previewSeriesMove(seriesCode, to);
    if (!plan.ok) return refusal(plan, 404);
    return NextResponse.json({ weeks: plan.weeks });
  }

  const result = await moveSeries(admin, seriesCode, to, {
    ...(codes !== undefined ? { codes: codes as string[] } : {}),
    reason: typeof reason === "string" ? reason : null,
  });
  if (!result.ok) return refusal(result);
  const venueId = venueIds[0];
  for (const m of result.moved) {
    const b = m.booking;
    await logAction(admin, {
      venueId,
      action: "booking.rescheduled",
      bookingCode: b.code,
      detail: `${m.from.date} ${formatMinute(m.from.startMin)} → ${b.date} ${formatMinute(b.startMin)}${m.priceChange !== 0 ? `, price ${m.priceChange > 0 ? "+" : ""}${money(m.priceChange)}` : ""}; with series ${seriesCode.trim().toUpperCase()}${
        m.refund ? `; ${money(m.refund.amount)} given back (${m.refund.how === "online" ? "owed back on the online payment" : m.refund.how === "credit" ? "to the customer's stored credit" : "owed back at the counter"})` : ""
      }${
        m.outcome === "venue" ? `; open game with players moved by the venue: ${String(reason).trim().slice(0, 300)}` : ""
      }`,
    });
    if (m.overrides && m.overrides.length > 0) {
      const rules = await policyForCourt(b.courtId);
      await logAction(admin, {
        venueId,
        action: "booking.override",
        bookingCode: b.code,
        detail: `${b.date} ${formatMinute(b.startMin)}, ${formatLength(b.endMin - b.startMin)}: past ${m.overrides.map((x) => (rules ? breachMessage(rules, x) : x)).join("; ")}`,
      });
    }
  }
  if (result.moved.length > 0) {
    await logAction(admin, {
      venueId,
      action: "booking.series_moved",
      bookingCode: seriesCode.trim().toUpperCase(),
      detail: `${result.moved.length} week(s) to ${formatMinute(start)}${typeof weekday === "number" ? `, weekday ${weekday}` : ""}: ${result.moved.map((m) => m.booking.code).join(", ")}${
        result.left.length > 0 ? `; left: ${result.left.map((l) => l.code).join(", ")}` : ""
      }`,
    });
    // One message for the weeks moved, as one booking moved by the venue is told.
    await notifySeriesMoved(seriesCode, result.moved);
    await tickOutbox();
  }
  return NextResponse.json({
    moved: result.moved.map((m) => ({ code: m.booking.code, date: m.booking.date, startMin: m.booking.startMin, courtId: m.booking.courtId, priceChange: m.priceChange, ...(m.refund ? { refund: m.refund } : {}) })),
    left: result.left,
  });
}
