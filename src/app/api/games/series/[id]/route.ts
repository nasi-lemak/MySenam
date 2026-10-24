import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { endSeries } from "@/lib/game-series";

export const dynamic = "force-dynamic";

/** `{ action: "end", callOffUpcoming? }`: the host ends a weekly game; the court bookings stay theirs. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const id = Number((await params).id);
  const body = (await req.json().catch(() => null)) as { action?: unknown; callOffUpcoming?: unknown } | null;
  if (!Number.isInteger(id) || body?.action !== "end") return NextResponse.json({ error: "Which, and what?" }, { status: 400 });
  const done = await endSeries(user.id, id, body.callOffUpcoming === true);
  if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
  return NextResponse.json(done);
}
