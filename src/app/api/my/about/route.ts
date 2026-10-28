import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isGender, playerGender, setPlayerGender } from "@/lib/who";
import { jsonObject } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Which games the account plays in: woman, man, prefer not to say — or not said yet (null). */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  return NextResponse.json({ gender: await playerGender(user.id) });
}

/** `{ gender: "woman" | "man" | "unsaid" }` */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = (await jsonObject(req)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!isGender(body.gender)) return NextResponse.json({ error: "Woman, man, or prefer not to say." }, { status: 400 });
  await setPlayerGender(user.id, body.gender);
  return NextResponse.json({ gender: body.gender });
}
