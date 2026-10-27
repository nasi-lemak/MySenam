import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { refusal } from "@/lib/api";
import { coachById } from "@/lib/coaching";
import { coachChangeRefusal, coachChangeTerms, collectCoachDifference } from "@/lib/lesson-coaches";
import { money } from "@/lib/region";
import { findBookingByCode, getVenueIdForBookingCode } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Giving a lesson to another coach (lib/lesson-coaches.ts). The change itself
 * is made by a manager through `POST /api/admin/bookings/reschedule` with
 * `coachId` (and, paid, `coachMoney`).
 *
 * GET `?code&coachId` → `{ keep, adjust }`: what it would do to the money each
 * way (the old fee and the new for the lesson's minutes, the difference, and
 * whether it is owed or given back, and how), shown before the manager
 * confirms; or why it cannot be done (a lesson pack, a part paid by others).
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const p = req.nextUrl.searchParams;
  const code = p.get("code") ?? "";
  const coachId = Number(p.get("coachId"));
  if (!code || !Number.isInteger(coachId) || coachId <= 0) return NextResponse.json({ error: "code and coachId are required." }, { status: 400 });
  const venueId = await getVenueIdForBookingCode(code);
  if (venueId === null) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const booking = (await findBookingByCode(code))!;
  const coach = await coachById(coachId);
  if (!booking.coachId || !coach || !coach.active || coach.venueId !== venueId || coach.id === booking.coachId || !coach.sports.includes(booking.sport))
    return refusal({ ok: false, error: "That coach does not give lessons in this sport here.", code: "COACH_NOT_FOUND" }, 404);
  const why = await coachChangeRefusal(booking, "keep");
  if (why) return refusal(why);
  return NextResponse.json(
    { keep: await coachChangeTerms(booking, coach, "keep"), adjust: await coachChangeTerms(booking, coach, "adjust") },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * `{ venueId, changeId, method }`: the difference owed for a dearer coach,
 * taken at the counter (cash, qr, transfer or card), once, with a receipt of
 * its own. Front desk too, as marking a booking paid is.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Number.isInteger(body.venueId) || !Number.isInteger(body.changeId))
    return NextResponse.json({ error: "venueId, changeId and method are required." }, { status: 400 });
  const venueId = body.venueId as number;
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const done = await collectCoachDifference(body.changeId as number, venueId, body.method);
  if (!done.ok) return NextResponse.json({ error: done.error, ...(done.code ? { code: done.code } : {}) }, { status: done.status });
  await logAction(admin, {
    venueId,
    action: "lesson.coach_difference_paid",
    bookingCode: done.bookingCode,
    detail: `Coach change ${done.changeId}: ${money(done.amount)} taken (${String(body.method)})${done.receipt ? `, receipt ${done.receipt}` : ""}`,
  });
  return NextResponse.json(done);
}
