import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { mySeries, startSeries } from "@/lib/game-series";
import type { Level } from "@/lib/games";
import type { Intensity } from "@/lib/player-profiles";
import { phoneRefusal } from "@/lib/phone-check";
import { refusal } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import type { Who } from "@/lib/who";

export const dynamic = "force-dynamic";

/** The signed-in host's weekly games, each with its dates' games (lib/game-series.ts). */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  return NextResponse.json({ series: await mySeries(user.id) });
}

/**
 * `{ bookingCode, title?, spots, level, share, autoAccept, note?, who?, visibility?, waitlist?, intensity?, adultsOnly? }`:
 * make one of your weekly bookings a weekly game, a game on each upcoming date.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const noPhone = await phoneRefusal(user.id);
  if (noPhone) return refusal(noPhone, 403);
  const limited = await rateLimit(req, "booking");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.bookingCode !== "string") return NextResponse.json({ error: "Which booking?" }, { status: 400 });
  const result = await startSeries(user.id, {
    bookingCode: body.bookingCode,
    title: typeof body.title === "string" ? body.title : undefined,
    spots: Number(body.spots),
    level: typeof body.level === "string" && body.level ? (body.level as Level) : null,
    share: Number(body.share),
    autoAccept: body.autoAccept === true,
    note: typeof body.note === "string" ? body.note : undefined,
    who: typeof body.who === "string" ? (body.who as Who) : undefined,
    visibility: body.visibility === "private" ? "private" : "public",
    waitlist: body.waitlist === true,
    intensity: typeof body.intensity === "string" ? (body.intensity as Intensity) : undefined,
    adultsOnly: body.adultsOnly === true,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status ?? 400 });
  return NextResponse.json({ series: result.series, skipped: result.skipped }, { status: 201 });
}
