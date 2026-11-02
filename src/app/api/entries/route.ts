import { NextRequest, NextResponse } from "next/server";
import { jsonObject, refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { admitEntry, entryCount, entryOptions, entryResource, selfPerson } from "@/lib/entries";
import { mayShowVenue } from "@/lib/listing";
import { rateLimit } from "@/lib/rate-limit";
import { getVenue } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Letting yourself in where no booking is needed (lib/entries.ts;
 * docs/features/venue-operations.md#entry-with-no-set-time): the page the
 * resource's check-in code opens.
 *
 * `?courtId`: the resource, whether it lets customers in by themselves, how
 * full it is now as a level (never who is there), and, signed in, what of
 * the account's own would let it in (a membership that admits, passes and day
 * passes).
 */
export async function GET(req: NextRequest) {
  const courtId = Number(req.nextUrl.searchParams.get("courtId"));
  if (!Number.isInteger(courtId) || courtId <= 0) return NextResponse.json({ error: "courtId is required." }, { status: 400 });
  const resource = await entryResource(courtId);
  if (!resource || !(await mayShowVenue(resource.venueId, req)).show)
    return NextResponse.json({ error: "Nothing here takes entries without a booking.", code: "NBK_NOT_ENTRY", vars: { name: "" } }, { status: 404 });
  const venue = (await getVenue(resource.venueId))!;
  const count = await entryCount(resource);
  const user = await getSessionUser(req);
  const person = user ? await selfPerson(user.id) : null;
  const mine = person && resource.selfCheckIn ? await entryOptions(resource, person, "self") : null;
  return NextResponse.json({
    resource: { courtId: resource.courtId, name: resource.name, sport: resource.sport, price: resource.price, selfCheckIn: resource.selfCheckIn },
    venue: { id: venue.id, name: venue.name, area: venue.area },
    level: count.level,
    signedIn: user !== null,
    mine,
  });
}

/**
 * `{ courtId, by: "membership" | "pass", passId?, agreeWaiver? }`: the signed-in customer lets themself in, on
 * their own membership that admits here or one of their own passes or day passes, where the resource lets
 * customers check themselves in. Everything the desk would ask is asked; nothing is paid here.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Sign in to check yourself in.", code: "NBK_SIGN_IN" }, { status: 401 });
  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;
  let body: Record<string, unknown>;
  try {
    body = await jsonObject(req);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!Number.isInteger(body.courtId)) return NextResponse.json({ error: "courtId is required." }, { status: 400 });
  const resource = await entryResource(body.courtId as number);
  if (!resource || !(await mayShowVenue(resource.venueId, req)).show)
    return NextResponse.json({ error: "Nothing here takes entries without a booking.", code: "NBK_NOT_ENTRY", vars: { name: "" } }, { status: 404 });
  const person = await selfPerson(user.id);
  if (!person) return NextResponse.json({ error: "Sign in to check yourself in.", code: "NBK_SIGN_IN" }, { status: 401 });
  const by =
    body.by === "membership" ? ({ kind: "membership" } as const) : body.by === "pass" && Number.isInteger(body.passId) ? ({ kind: "pass", passId: body.passId as number } as const) : null;
  if (!by) return NextResponse.json({ error: "by is membership, or pass with passId." }, { status: 400 });
  const admitted = await admitEntry({ courtId: resource.courtId, person, by, channel: "self", agreeWaiver: body.agreeWaiver === true, staff: null });
  if (!admitted.ok) return refusal(admitted);
  return NextResponse.json(
    {
      admission: {
        name: admitted.name,
        admittedBy: admitted.admittedBy,
        stayUntil: admitted.stayUntil,
        ...(admitted.pass ? { pass: admitted.pass } : {}),
        level: admitted.count.level,
      },
    },
    { status: 201 }
  );
}
