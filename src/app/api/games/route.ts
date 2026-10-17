import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { findGames, LEVELS, openGame, type Level } from "@/lib/games";
import { rateLimit } from "@/lib/rate-limit";
import { readNear } from "@/lib/store";
import { storefrontForRequest } from "@/lib/storefront";
import { isValidDateString } from "@/lib/time";
import { SPORTS, type Sport } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Open games with room, soonest first: `?sport=&date=&area=&level=`, or
 * `?near=lat,lng&km=` for nearest. Signed in, each says where you stand in it.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const sport = params.get("sport");
  if (sport && !SPORTS.includes(sport as Sport)) return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
  const date = params.get("date");
  if (date && !isValidDateString(date)) return NextResponse.json({ error: "Invalid date." }, { status: 400 });
  const level = params.get("level");
  if (level && !LEVELS.includes(level as Level)) return NextResponse.json({ error: "Unknown level." }, { status: 400 });
  const user = await getSessionUser(req);
  const games = await findGames({
    sport: (sport as Sport) || undefined,
    date: date || undefined,
    area: params.get("area") || undefined,
    near: readNear(params.get("near"), params.get("km")) ?? undefined,
    level: (level as Level) || undefined,
    venueIds: (await storefrontForRequest(req))?.venueIds,
    forUser: user?.id,
  });
  return NextResponse.json({ games, signedIn: user !== null });
}

/** `{ bookingCode, spots, level, share, autoAccept, note? }` — open one of your bookings to other players. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = rateLimit(req, "booking");
  if (limited) return limited;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof body.bookingCode !== "string") return NextResponse.json({ error: "Which booking?" }, { status: 400 });
  const result = await openGame(user.id, {
    bookingCode: body.bookingCode,
    spots: Number(body.spots),
    level: typeof body.level === "string" && body.level ? (body.level as Level) : null,
    share: Number(body.share),
    autoAccept: body.autoAccept === true,
    note: typeof body.note === "string" ? body.note : undefined,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status ?? 400 });
  return NextResponse.json({ game: result.game }, { status: 201 });
}
