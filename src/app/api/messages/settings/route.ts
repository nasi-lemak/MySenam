import { NextRequest, NextResponse } from "next/server";
import { readJsonObject } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { messageSettings, saveMessageSettings } from "@/lib/messages";
import { rateLimit } from "@/lib/rate-limit";
import { refused } from "../respond";

export const dynamic = "force-dynamic";

/** Whether the signed-in player lets people they play with message them, and whether they are emailed of a message. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  return NextResponse.json({ settings: await messageSettings(user.id) }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ enabled?, emailNotices?, understood? }`. Turning messaging on takes a player who says they are 18 or over and has read the first
 * screen (`understood: true` the first time); joining a game never turns it on.
 */
export async function PUT(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "messageWrite");
  if (limited) return limited;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const saved = await saveMessageSettings(user.id, body);
  if (!saved.ok) return refused(saved);
  return NextResponse.json({ settings: saved.settings });
}
