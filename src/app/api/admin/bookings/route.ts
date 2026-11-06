import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { getVenueIdForBookingCode, listBookingsForDate, searchBookings } from "@/lib/store";
import { isValidDateString, todayISO } from "@/lib/time";
import { roundMoney } from "@/lib/region";
import { refusal } from "@/lib/api";
import { counterOwed, counterPayoutsOn } from "@/lib/counter-refunds";
import { entryFeesOwed } from "@/lib/entry-fee-refunds";
import { correctBookingDetails, type CorrectionScope } from "@/lib/booking-corrections";
import { policyRefused } from "@/lib/counter-policy";
import { overrideRefusal, readOverride } from "@/lib/policy-overrides";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  // A customer at the desk: their bookings by code, number, email or name.
  const q = req.nextUrl.searchParams.get("q");
  if (q !== null) return NextResponse.json({ hits: await searchBookings(q, admin.venueIds ?? undefined) });

  const date = req.nextUrl.searchParams.get("date") ?? todayISO();
  if (!isValidDateString(date)) {
    return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });
  }

  const bookings = await listBookingsForDate(date, admin.venueIds ?? undefined);
  const confirmed = bookings.filter((b) => b.status === "confirmed");
  // A dearer coach's difference on a paid lesson (lib/lesson-coaches.ts) is expected once owed, and collected once paid.
  const owedForCoach = (b: (typeof bookings)[number]) => (b.coachOwed ?? []).reduce((sum, o) => sum + o.amount, 0);
  const paidForCoach = (b: (typeof bookings)[number]) => (b.coachPaid ?? []).reduce((sum, o) => sum + o.amount, 0);
  const revenue = roundMoney(confirmed.reduce((sum, b) => sum + b.totalPrice + owedForCoach(b) + paidForCoach(b), 0));
  const collected = roundMoney(
    confirmed.reduce((sum, b) => sum + (b.paymentStatus === "paid" ? b.totalPrice : 0) + paidForCoach(b), 0)
  );
  return NextResponse.json({
    date,
    bookings,
    revenue,
    collected,
    outstanding: roundMoney(revenue - collected),
    // Money handed back at the counter that day, for the till (lib/counter-refunds.ts).
    payouts: await counterPayoutsOn(admin.venueIds ?? null, date),
    // Counter payments still owed back on bookings the venue cancelled, whatever their day (lib/counter-refunds.ts).
    owed: await counterOwed(admin.venueIds ?? null, admin.role),
    // Entry fees taken at the counter and owed back after a tournament was called off or an entrant taken out before the draw (lib/entry-fee-refunds.ts).
    feesOwed: await entryFeesOwed(admin.venueIds ?? null, admin.role),
  });
}

/**
 * Correct a booking's name, phone number or email (lib/booking-corrections.ts):
 * `{code, name?, phone?, email?, scope?: "booking" | "series" | "group"}`, and
 * a manager's `overridePolicies` and `overrideReason` where a new number is
 * refused by a policy the venue lets its managers override.
 */
export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let body: Record<string, unknown>;
  try {
    body = ((await req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { code, name, phone, email, scope } = body;
  if (typeof code !== "string" || code.trim() === "") return NextResponse.json({ error: "code is required." }, { status: 400 });
  for (const [key, v] of [["name", name], ["phone", phone]] as const)
    if (v !== undefined && typeof v !== "string") return NextResponse.json({ error: `${key} must be text.` }, { status: 400 });
  if (email !== undefined && email !== null && typeof email !== "string") return NextResponse.json({ error: "email must be text or null." }, { status: 400 });
  if (scope !== undefined && scope !== "booking" && scope !== "series" && scope !== "group")
    return NextResponse.json({ error: "scope must be booking, series or group." }, { status: 400 });

  const venueId = await getVenueIdForBookingCode(code);
  if (venueId === null) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  // A manager's override of the venue's policies for the new number, where the venue permits it (ADR 0026).
  const ask = readOverride(body);
  if (ask && "ok" in ask) return refusal(ask, 400);
  if (ask) {
    const no = await overrideRefusal(admin, venueId, ask);
    if (no) return refusal(no.refusal, no.status);
  }

  const result = await correctBookingDetails({
    code,
    ...(name !== undefined ? { name: name as string } : {}),
    ...(phone !== undefined ? { phone: phone as string } : {}),
    ...(email !== undefined ? { email: email as string | null } : {}),
    scope: (scope as CorrectionScope | undefined) ?? "booking",
    staff: admin,
    ...(ask ? { override: ask } : {}),
  });
  if (!result.ok) {
    if ("policyRefusal" in result && result.policyRefusal) return policyRefused("staff", result, { staff: admin, venueId });
    return refusal(result);
  }
  return NextResponse.json({ codes: result.codes, changed: result.changed, overridden: result.overridden });
}
