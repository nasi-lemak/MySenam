import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { readJsonObject, refusal } from "@/lib/api";
import { logAction } from "@/lib/activity";
import { addGames, getVenueIdForBookingCode } from "@/lib/store";
import { money } from "@/lib/region";
import { formatMinute } from "@/lib/interval";

export const dynamic = "force-dynamic";

/**
 * `{ code, add }`: more games on a booking sold by the game, at the desk, when
 * the players want to play on (lib/store.ts `addGames`): the lane is held on
 * from where the booking ends while that time on it is free, and the games are
 * added to what is still to pay. Front desk and managers; logged
 * (`booking.games_added`).
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const { code, add } = body;
  if (typeof code !== "string" || code.trim() === "") return NextResponse.json({ error: "code is required." }, { status: 400 });
  if (!Number.isInteger(add) || (add as number) < 1) return NextResponse.json({ error: "add must be a whole number of games." }, { status: 400 });

  const venueId = await getVenueIdForBookingCode(code);
  if (venueId === null) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  const result = await addGames(code, add as number);
  if (!result.ok) return refusal(result);
  await logAction(admin, {
    venueId,
    action: "booking.games_added",
    bookingCode: result.booking.code,
    detail: `${result.added} more game${result.added === 1 ? "" : "s"} (${result.booking.games} in all), until ${formatMinute(result.booking.endMin)}, ${money(result.priceChange)} more`,
  });
  return NextResponse.json({ booking: result.booking, added: result.added, priceChange: result.priceChange });
}
