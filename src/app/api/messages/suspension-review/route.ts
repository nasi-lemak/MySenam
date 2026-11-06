import { NextRequest, NextResponse } from "next/server";
import { readJsonObject } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { askForSuspensionReview, mySuspensionReview } from "@/lib/suspension-reviews";
import { refused } from "../respond";

export const dynamic = "force-dynamic";

/**
 * Where this person's latest request for a review of a suspension of their messaging stands: `{ state: "none" | "received" | "decided", outcome: "lifted" | "continues" | null,
 * suspended }`. It says nothing about any report, any reporter or why, and gives the same answer to anybody who never asked (ADR 0059).
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "messageRead");
  if (limited) return limited;
  return NextResponse.json(await mySuspensionReview(user.id), { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ text? }`: a person whose messaging is suspended (by staff or by the published rule) asks for it to be looked at again, with one short text (up to 300 characters; nothing of
 * any report is shown or asked). It is decided by somebody who may lift it, with a reason. `404 PM_NOT_FOUND` for anybody who is not suspended (as for a stranger),
 * `409 PM_REVIEW_DUP` while one request is open. This promises no legal right to a review or to notification: those are pending legal review (ADR 0052, ADR 0059).
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "messageWrite");
  if (limited) return limited;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const done = await askForSuspensionReview(user.id, body.text);
  if (!done.ok) return refused(done);
  return NextResponse.json({ ok: true, state: done.state });
}
