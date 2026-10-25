import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { LIVE_STATUSES, apply, customerApprovals, readSubmission, refusalBody, requirementFor } from "@/lib/approvals";
import { courtOffers } from "@/lib/court-activities";
import { declaredAdult } from "@/lib/player-profiles";
import { rateLimit } from "@/lib/rate-limit";
import { getVenue } from "@/lib/store";
import { currentWaiver, waiverSigned } from "@/lib/waivers";

export const dynamic = "force-dynamic";

/**
 * The signed-in customer's applications to be approved for an activity
 * (lib/approvals.ts), newest first. With `?venueId&sport`, also what that
 * venue asks before approving somebody for it, to fill in. `courts`: where a
 * slot can be asked for, for each live application (by `venueId:sport`).
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const requests = await customerApprovals(user.id);
  // Where a slot can still be asked for, for each live application: the venue's resources for that activity.
  const courts: Record<string, { id: number; name: string }[]> = {};
  for (const r of requests) {
    const key = `${r.venueId}:${r.sport}`;
    if (courts[key] || !LIVE_STATUSES.includes(r.status)) continue;
    const venue = await getVenue(r.venueId);
    courts[key] = (venue?.courts ?? []).filter((c) => courtOffers(c, r.sport)).map((c) => ({ id: c.id, name: c.name }));
  }
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  const sport = req.nextUrl.searchParams.get("sport");
  if (!Number.isInteger(venueId) || venueId <= 0 || !sport) return NextResponse.json({ requests, courts }, { headers: { "Cache-Control": "no-store" } });
  const requirement = await requirementFor(venueId, sport);
  const venue = requirement?.open ? await getVenue(venueId) : null;
  if (!requirement || !requirement.open || !venue) return NextResponse.json({ requests, courts, apply: null }, { headers: { "Cache-Control": "no-store" } });
  const waiver = requirement.waiver ? await currentWaiver(venueId) : null;
  const { coachIds: _reviewers, ...asked } = requirement;
  return NextResponse.json(
    {
      requests,
      courts,
      apply: {
        ...asked,
        venueName: venue.name,
        courts: venue.courts.filter((c) => courtOffers(c, sport)).map((c) => ({ id: c.id, name: c.name })),
        waiverText: waiver && !(await waiverSigned(venueId, user.phone)) ? waiver.text : null,
        adult: await declaredAdult(user.id),
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * Apply: a form upload with `data` (JSON: `{ venueId, sport, answers?,
 * declaration?, videoWatched?, waiver?, adult, guardianName?,
 * guardianDeclaration?, certReference?, certExpiresOn?, slot?: { courtId,
 * date, start, end } }`) and up to three `document` files where the venue
 * asks for one; or the same JSON alone.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "booking", "approval");
  if (limited) return limited;
  const read = await readSubmission(req);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.status });
  const venueId = Number(read.body.venueId);
  if (!Number.isInteger(venueId) || venueId <= 0 || typeof read.body.sport !== "string")
    return NextResponse.json({ error: "venueId and sport are required." }, { status: 400 });
  const made = await apply(user, { ...read.body, venueId, sport: read.body.sport }, read.files);
  if (!made.ok) return NextResponse.json(refusalBody(made), { status: made.status });
  return NextResponse.json({ request: made.request }, { status: 201 });
}
