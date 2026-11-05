import { NextRequest, NextResponse } from "next/server";
import { readJsonObject } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { askForReview, myReviewState } from "@/lib/youth-restrictions";

export const dynamic = "force-dynamic";

/**
 * `?groupId=`: where this person's latest request for a review of a restriction in that group stands: `none`, `received`, or `decided` with the outcome in
 * neutral words (`lifted` or `continues`) and what the reviewer chose to add. It says nothing about any report, any reporter or why, and gives the same answer
 * to anybody who never asked (docs/features/player-messages.md#a-restriction-on-an-adult-is-protective-or-a-decision; ADR 0052).
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "messageRead");
  if (limited) return limited;
  const groupId = Number(req.nextUrl.searchParams.get("groupId"));
  if (!Number.isInteger(groupId) || groupId <= 0) return NextResponse.json({ error: "That group is not here.", code: "YG_NOT_FOUND" }, { status: 404 });
  return NextResponse.json(await myReviewState(user.id, groupId), { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ groupId, text? }`: an adult whose access to a youth group's conversation is restricted, for whatever cause, asks for it to be looked at again, with one short
 * text (up to 300 characters; nothing of any report is shown or asked). It is decided by somebody other than whoever applied the restriction. `404 YG_NOT_FOUND` for
 * anybody who is not restricted there (as for a stranger), `409 YG_APPEAL_DUP` while one request is open, `409 YG_OFF` while youth messaging is not enabled. This
 * promises no legal right: rights to review and notification are pending legal review.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "messageWrite");
  if (limited) return limited;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  if (!Number.isInteger(body.groupId) || (body.groupId as number) <= 0) return NextResponse.json({ error: "That group is not here.", code: "YG_NOT_FOUND" }, { status: 404 });
  const done = await askForReview(user.id, body.groupId as number, body.text);
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: done.status });
  return NextResponse.json({ ok: true, state: done.state });
}
