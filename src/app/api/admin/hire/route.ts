import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { getVenue, getVenueIdForBookingCode, listOpenHires, returnHire, takeHire } from "@/lib/store";
import { deductionTreatments } from "@/lib/deposit-deductions";
import { COUNTER_METHODS, type CounterMethod, HIRE_CONDITIONS, HireCondition } from "@/lib/types";

export const dynamic = "force-dynamic";

/** What is still out at a venue, and how each reason for keeping money back is treated there. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  if (!await getVenue(venueId)) return NextResponse.json({ error: "Venue not found." }, { status: 404 });

  return NextResponse.json({ hires: await listOpenHires(venueId), deductions: await deductionTreatments(venueId) });
}

/** Hand kit over (`action: "take"`) or take it back in (`action: "return"`). */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { code, action, deposit, condition, deductions, withheld, note, via } = (body ?? {}) as Record<
    string,
    unknown
  >;
  if (typeof code !== "string" || code.trim() === "")
    return NextResponse.json({ error: "code is required." }, { status: 400 });
  if (action !== "take" && action !== "return")
    return NextResponse.json({ error: 'action must be "take" or "return".' }, { status: 400 });

  const venueId = await getVenueIdForBookingCode(code);
  if (venueId === null) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  if (action === "take") {
    if (deposit !== undefined && typeof deposit !== "number")
      return NextResponse.json({ error: "deposit must be a number." }, { status: 400 });
    const result = await takeHire(code, deposit as number | undefined);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
    return NextResponse.json({ hire: result.hire, booking: result.booking });
  }

  if (typeof condition !== "string" || !HIRE_CONDITIONS.includes(condition as HireCondition))
    return NextResponse.json({ error: "condition is required." }, { status: 400 });
  if (deductions !== undefined && !Array.isArray(deductions))
    return NextResponse.json({ error: "deductions must be a list of { reason, amount }." }, { status: 400 });
  if (withheld !== undefined && typeof withheld !== "number")
    return NextResponse.json({ error: "withheld must be a number." }, { status: 400 });
  if (note !== undefined && typeof note !== "string")
    return NextResponse.json({ error: "note must be text." }, { status: 400 });

  if (via !== undefined && !COUNTER_METHODS.includes(via as CounterMethod))
    return NextResponse.json({ error: "via is cash, qr, transfer or card." }, { status: 400 });
  const result = await returnHire(code, {
    condition: condition as HireCondition,
    deductions: deductions as { reason: unknown; amount: unknown }[] | undefined,
    withheld: withheld as number | undefined,
    note: note as string | undefined,
    // How the deposit was held, so what is kept is in the takings under the same method.
    via: via as CounterMethod | undefined,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ hire: result.hire, booking: result.booking });
}
