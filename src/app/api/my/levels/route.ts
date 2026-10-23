import { isActivity } from "@/lib/activities";
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { LEVELS, playerLevels, setPlayerLevel, type Level } from "@/lib/games";
import { type Sport } from "@/lib/types";

export const dynamic = "force-dynamic";

/** The signed-in player's level in each sport they have given one for. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  return NextResponse.json({ levels: await playerLevels(user.id) });
}

/** `{ sport, level | null }` */
export async function PUT(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!(await isActivity(body.sport))) return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
  if (body.level !== null && !LEVELS.includes(body.level as Level))
    return NextResponse.json({ error: "Unknown level." }, { status: 400 });
  await setPlayerLevel(user.id, body.sport as Sport, body.level as Level | null);
  return NextResponse.json({ levels: await playerLevels(user.id) });
}
