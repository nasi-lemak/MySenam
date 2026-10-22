import { NextRequest, NextResponse } from "next/server";
import { coachForToken } from "@/lib/coach-schedule";
import { setCoachHours } from "@/lib/coaching";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * `{ hours: [{ weekday, from, until }] }`: a coach sets the hours they take
 * lessons, at the private link the venue gave them (lib/coach-schedule.ts).
 * Lessons already booked stand.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const limited = await rateLimit(req, "login", "coach-self");
  if (limited) return limited;
  const found = await coachForToken((await params).token);
  if (!found || !found.coach.active) return NextResponse.json({ error: "This link is no longer in use." }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { hours?: unknown } | null;
  const set = await setCoachHours(found.coach.id, body?.hours);
  if (!set.ok) return NextResponse.json(set, { status: 400 });
  return NextResponse.json({ coach: { hours: set.coach.hours, timeOff: set.coach.timeOff } });
}
