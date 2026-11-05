import { NextRequest, NextResponse } from "next/server";
import { readJsonObject } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { myYouthGroups, setMinorOptIn } from "@/lib/youth-messages";

export const dynamic = "force-dynamic";

/**
 * The supervised youth groups the signed-in account is in, with where each of the three consents stands (the child's own opt-in, a
 * guardian's consent, the group being marked), for the child's first-use screen (docs/features/player-messages.md#supervised-youth-groups).
 * Only for an account that has not declared it is 18 or over; an adult gets `eligible: false` and no groups.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "messageRead");
  if (limited) return limited;
  return NextResponse.json(await myYouthGroups(user.id), { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ groupId, on: boolean }`: the child's own opt-in to messages in a supervised youth group they are a member of, or taking it back.
 * Turning it on is not enough on its own: a linked, live guardian's consent for this child and group has to be on too (`YG_NO_GUARDIAN`
 * where nobody is linked). Declared adults are refused (`YG_OPTIN_ADULT`): they use the ordinary setting.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "messageWrite");
  if (limited) return limited;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  if (!Number.isInteger(body.groupId) || typeof body.on !== "boolean") return NextResponse.json({ error: "Which group, on or off?" }, { status: 400 });
  const done = await setMinorOptIn(user.id, body.groupId as number, body.on);
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code, vars: done.vars }, { status: done.status });
  return NextResponse.json({ ok: true, ...(await myYouthGroups(user.id)) });
}
