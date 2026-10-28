import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { jsonBody, staffLeague } from "@/lib/league-access";
import { leagueDetail, setPlacePaid } from "@/lib/leagues";
import { asStaff } from "@/lib/acting-staff";
import { COUNTER_METHODS, type CounterMethod } from "@/lib/types";

export const dynamic = "force-dynamic";

/** `{ paid, via? }` — a season's fee taken at the counter, and how (cash, qr, transfer or card; required for a fee), or not. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; placeId: string }> }) {
  const { id, placeId } = await params;
  const found = await staffLeague(req, id);
  if (found instanceof NextResponse) return found;
  const place = (await getDb()
    .prepare(
      `SELECT lp.id, s.number FROM league_places lp JOIN league_seasons s ON s.id = lp.season_id
        WHERE lp.id = ? AND s.league_id = ?`
    )
    .get(Number(placeId), found.id)) as { id: number; number: number } | undefined;
  if (!place) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await jsonBody(req);
  if (body instanceof NextResponse) return body;
  if (typeof body.paid !== "boolean") return NextResponse.json({ error: "Paid, or not?" }, { status: 400 });
  // How the desk took a fee (cash, qr, transfer or card): on its receipt and in the cash-up; asked for any fee.
  const via = body.via === undefined || body.via === null || body.via === "" ? null : body.via;
  if (via !== null && !COUNTER_METHODS.includes(via as CounterMethod))
    return NextResponse.json({ error: `via must be one of ${COUNTER_METHODS.join(", ")}.` }, { status: 400 });
  const { fee } = (await getDb().prepare("SELECT fee::float AS fee FROM leagues WHERE id = ?").get(found.id)) as { fee: number };
  if (body.paid && via === null && Number(fee) > 0) return NextResponse.json({ error: "Say how it was paid.", code: "P8B_VIA_REQUIRED" }, { status: 400 });
  // As the member of staff, so the receipt or credit note says who (lib/acting-staff.ts).
  const result = await asStaff(found.admin, () => setPlacePaid(place.id, body.paid as boolean, via as CounterMethod | null));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ league: await leagueDetail(found.id, { forStaff: true, season: place.number }) });
}
