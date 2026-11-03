import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { playerLevels } from "@/lib/games";
import { playerProfile, saveProfile } from "@/lib/player-profiles";

export const dynamic = "force-dynamic";

/** How the signed-in player likes to play, and their levels (lib/player-profiles.ts). */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  return NextResponse.json({ profile: await playerProfile(user.id), levels: await playerLevels(user.id) });
}

/** `{ area?, near?, maxKm?, days?, times?, intensity?, maxShare?, discoverable?, invitable?, adult?, notifyMatches? }`: only what is given changes. */
export async function PUT(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const saved = await saveProfile(user.id, body);
  if (!saved.ok) return NextResponse.json({ error: saved.error, ...(saved.code ? { code: saved.code } : {}) }, { status: 400 });
  return NextResponse.json({ profile: saved.profile });
}
