import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { goLiveStatus, requestGoLive } from "@/lib/applications";
import { jsonObject } from "@/lib/api";
import { logAction } from "@/lib/activity";
import { clearTestBookings, counterPaidTests, isMoneyTaken, TEST_REFUSALS, type TestOutcome } from "@/lib/test-bookings";

export const dynamic = "force-dynamic";

function venueOf(raw: unknown): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** `?venueId=` — draft, waiting, live or off the marketplace, and what it still needs. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = venueOf(req.nextUrl.searchParams.get("venueId"));
  if (venueId === null) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const status = await goLiveStatus(venueId);
  if (!status) return NextResponse.json({ error: "Venue not found." }, { status: 404 });
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ venueId, clearTests?, moneyTaken? }` — send a draft to the platform owner to go live, clearing its test bookings
 * if asked (with the same answer as clearing them from the banner: `moneyTaken`, none or real, required where any has
 * a counter payment on it). Refused (409, listing the codes) while a test booking with a payment on it stands that
 * the same request does not clear: clear them or keep them as real first.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let body: { venueId?: unknown; clearTests?: unknown; moneyTaken?: unknown };
  try {
    body = await jsonObject(req);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const venueId = venueOf(body.venueId);
  if (venueId === null) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const clearing = body.clearTests === true;
  if (body.moneyTaken !== undefined && !isMoneyTaken(body.moneyTaken)) return NextResponse.json({ error: TEST_REFUSALS.moneyTakenValue }, { status: 400 });
  if (clearing && body.moneyTaken === undefined && (await counterPaidTests(venueId)).length > 0)
    return NextResponse.json({ error: TEST_REFUSALS.moneyTaken }, { status: 400 });
  // Offered as it is sent: the test bookings made while setting up, cleared (lib/test-bookings.ts) once the request can
  // go; any still standing with a payment on them (kit out on hire) stop it.
  const done: { cleared: TestOutcome | null } = { cleared: null };
  const result = await requestGoLive(admin, venueId, {
    ...(clearing
      ? {
          clearTests: async () => {
            done.cleared = await clearTestBookings(admin, venueId, undefined, isMoneyTaken(body.moneyTaken) ? body.moneyTaken : undefined);
          },
        }
      : {}),
  });
  if (!result.ok) return NextResponse.json({ error: result.error, ...(done.cleared ? { cleared: done.cleared } : {}) }, { status: 409 });
  await logAction(admin, {
    venueId,
    action: "venue.go_live",
    detail: result.live ? "Put the venue live" : "Sent the venue to the platform to go live",
  });
  return NextResponse.json({ live: result.live, status: await goLiveStatus(venueId), cleared: done.cleared });
}
