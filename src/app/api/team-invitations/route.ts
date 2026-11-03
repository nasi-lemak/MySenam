import { NextRequest, NextResponse } from "next/server";
import { readJsonObject, refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { acceptInvitation, previewInvitation } from "@/lib/teams";

export const dynamic = "force-dynamic";

/**
 * `?token=`: what an invitation to a team is for, to the account it is for (the team's name, who invited, and the
 * people you manage, who could be put on it instead of you). Whatever cannot be used is refused in the same words.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in.", signIn: true }, { status: 401 });
  const limited = await rateLimit(req, "social");
  if (limited) return limited;
  const preview = await previewInvitation(user, req.nextUrl.searchParams.get("token"));
  if (!preview.ok) return refusal(preview, preview.status ?? 404);
  return NextResponse.json({ invitation: preview.value });
}

/** `{ token, participantId?, birthDate?, gender? }`: accept it, for yourself or for a child you manage. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in.", signIn: true }, { status: 401 });
  const limited = await rateLimit(req, "social");
  if (limited) return limited;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const done = await acceptInvitation(user, body.token, { participantId: body.participantId, birthDate: body.birthDate, gender: body.gender });
  if (!done.ok) return refusal(done, done.status ?? 409);
  return NextResponse.json({ team: done.value }, { status: 201 });
}
