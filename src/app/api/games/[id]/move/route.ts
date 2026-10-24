import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { refusal } from "@/lib/api";
import { gameById } from "@/lib/games";
import { hostMove, previewMove, withdrawMove } from "@/lib/game-moves";
import { isMinute, parseClock } from "@/lib/interval";
import { rateLimit } from "@/lib/rate-limit";
import { rescheduleOptions } from "@/lib/store";
import { notifyRescheduled, tickOutbox } from "@/lib/notify";

export const dynamic = "force-dynamic";

/** The game's host, or a response refusing anybody else. */
async function asHost(req: NextRequest, params: Promise<{ id: string }>) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const gameId = Number((await params).id);
  if (!Number.isInteger(gameId) || gameId <= 0) return NextResponse.json({ error: "Invalid game." }, { status: 400 });
  const game = await gameById(gameId);
  if (!game || game.hostId !== user.id) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return { user, game };
}

/** `?date` → the start times the host's game could move to that day (as its booking could). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const host = await asHost(req, params);
  if (host instanceof NextResponse) return host;
  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "date is required." }, { status: 400 });
  return NextResponse.json({ options: await rescheduleOptions(host.game.bookingCode, date) });
}

/**
 * The host moving their game (lib/game-moves.ts): `{ date, start, courtId?, preview? }`
 * → with `preview`, what it would do and change nothing; otherwise moved at
 * once while nobody is in it, or proposed to its players, the new time held
 * while they answer. `{ action: "withdraw" }` withdraws a proposal.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const host = await asHost(req, params);
  if (host instanceof NextResponse) return host;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (body.action === "withdraw") {
    const done = await withdrawMove(host.user.id, host.game.id);
    if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status ?? 409 });
    await tickOutbox();
    return NextResponse.json({ withdrawn: true });
  }
  const start = typeof body.start === "string" ? parseClock(body.start) : body.start;
  if (typeof body.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.date) || !isMinute(start))
    return NextResponse.json({ error: "date and start (minutes of the day or HH:MM) are required." }, { status: 400 });
  // The court of the time the host chose from those offered.
  const court = Number.isInteger(body.courtId) ? { courtId: body.courtId as number } : {};
  if (body.preview === true) {
    const seen = await previewMove(host.game.bookingCode, { date: body.date, start, ...court }, "customer");
    if (!seen.ok) return refusal(seen, ("status" in seen && typeof seen.status === "number" ? seen.status : 409));
    return NextResponse.json({ preview: seen.preview });
  }
  const limited = await rateLimit(req, "booking");
  if (limited) return limited;
  const moved = await hostMove(host.user.id, host.game.id, { date: body.date, start, ...court });
  if (!moved.ok) return refusal(moved, moved.status ?? 409);
  if (moved.outcome === "move") await notifyRescheduled(moved.result.booking, "customer", moved.result.priceChange);
  await tickOutbox();
  return NextResponse.json(moved.outcome === "proposal" ? { outcome: "proposal", move: moved.move } : { outcome: moved.outcome, booking: moved.result.booking });
}
