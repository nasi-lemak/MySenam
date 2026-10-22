import { NextRequest, NextResponse } from "next/server";
import { coachForToken } from "@/lib/coach-schedule";
import { addTimeOff, removeTimeOff } from "@/lib/coaching";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** `{ from, until?, reason? }`: days off, at the coach's own link. What is already booked then is counted, for the venue to move. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const limited = await rateLimit(req, "login", "coach-self");
  if (limited) return limited;
  const found = await coachForToken((await params).token);
  if (!found || !found.coach.active) return NextResponse.json({ error: "This link is no longer in use." }, { status: 404 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const added = await addTimeOff(found.coach.id, body ?? {});
  if (!added.ok) return NextResponse.json(added, { status: 400 });
  return NextResponse.json({ timeOff: added.coach.timeOff, clashes: added.clashes });
}

/** `?id`: back at work those days. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const found = await coachForToken((await params).token);
  if (!found) return NextResponse.json({ error: "This link is no longer in use." }, { status: 404 });
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || !(await removeTimeOff(found.coach.id, id))) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
