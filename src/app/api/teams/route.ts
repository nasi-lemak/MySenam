import { NextRequest, NextResponse } from "next/server";
import { readJsonObject, refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { captainedTeams, createTeam, myTeams } from "@/lib/teams";

export const dynamic = "force-dynamic";

/**
 * The teams you are on, or act for a child who is (lib/teams.ts); `?captain=1&sport=` the ones you captain, to enter
 * one in an event.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const q = req.nextUrl.searchParams;
  if (q.get("captain")) return NextResponse.json({ captained: await captainedTeams(user.id, q.get("sport") || undefined) });
  return NextResponse.json({ teams: await myTeams(user.id) });
}

/** `{ name, sport, venueId?, groupId?, description?, published? }`: start a team, which you captain. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "social");
  if (limited) return limited;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const made = await createTeam(user.id, body);
  if (!made.ok) return refusal(made, made.status ?? 409);
  return NextResponse.json({ team: made.value }, { status: 201 });
}
