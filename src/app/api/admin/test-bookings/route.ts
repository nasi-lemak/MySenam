import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { readJsonObject } from "@/lib/api";
import { clearTestBookings, counterPaidTests, isMoneyTaken, keepTestBookings, standingTestBookings, TEST_REFUSALS } from "@/lib/test-bookings";

export const dynamic = "force-dynamic";

function venueOf(raw: unknown): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** `?venueId=` — the venue's test bookings still standing, made before it went live (lib/test-bookings.ts). */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = venueOf(req.nextUrl.searchParams.get("venueId"));
  if (venueId === null) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json(await standingTestBookings(venueId), { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ venueId, action: "clear", codes?, moneyTaken? }` — cancel test bookings (those named, or all), everything paid
 * given back, nobody messaged. Where any of them has a counter payment on it `moneyTaken` is required: `none`
 * (declared synthetic: reversed by its credit note, nothing handed back) or `real` (owed back at the counter until
 * staff settle it from the day list); it is ignored for what was paid online, with credit or with a pass.
 * `{ venueId, action: "keep", codes }` — keep these as real bookings. A manager's.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const venueId = venueOf(body.venueId);
  if (venueId === null) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const codes = body.codes;
  if (codes !== undefined && (!Array.isArray(codes) || codes.length > 500 || !codes.every((c) => typeof c === "string" && c.length <= 40)))
    return NextResponse.json({ error: "codes must be a list of booking codes." }, { status: 400 });
  if (body.action === "clear") {
    if (body.moneyTaken !== undefined && !isMoneyTaken(body.moneyTaken)) return NextResponse.json({ error: TEST_REFUSALS.moneyTakenValue }, { status: 400 });
    if (body.moneyTaken === undefined && (await counterPaidTests(venueId, codes as string[] | undefined)).length > 0)
      return NextResponse.json({ error: TEST_REFUSALS.moneyTaken }, { status: 400 });
    return NextResponse.json(await clearTestBookings(admin, venueId, codes as string[] | undefined, body.moneyTaken));
  }
  if (body.action === "keep") {
    if (codes === undefined || codes.length === 0) return NextResponse.json({ error: "Say which bookings to keep." }, { status: 400 });
    return NextResponse.json(await keepTestBookings(admin, venueId, codes as string[]));
  }
  return NextResponse.json({ error: "action must be clear or keep." }, { status: 400 });
}
