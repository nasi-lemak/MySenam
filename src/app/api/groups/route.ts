import { isActivity } from "@/lib/activities";
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { createGroup, listGroups } from "@/lib/groups";
import { rateLimit } from "@/lib/rate-limit";
import type { Sport } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Community groups to ask to join, `?sport=&area=&offset=`; signed in, your own too, with where you stand (lib/groups.ts). */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const sport = q.get("sport");
  if (sport && !(await isActivity(sport))) return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
  const user = await getSessionUser(req);
  const groups = await listGroups({
    sport: (sport as Sport) || undefined,
    area: q.get("area") || undefined,
    viewerId: user?.id,
    offset: Number(q.get("offset")) || 0,
  });
  return NextResponse.json({ groups, signedIn: user !== null });
}

/** `{ name, sport, area?, description?, privacy?, capacity? }`: start a group, which you organise. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "social");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const made = await createGroup(user.id, body as Parameters<typeof createGroup>[1]);
  if (!made.ok) return NextResponse.json({ error: made.error }, { status: made.status ?? 400 });
  return NextResponse.json({ group: made.group }, { status: 201 });
}
