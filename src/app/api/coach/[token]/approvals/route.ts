import { NextRequest, NextResponse } from "next/server";
import { coachApprovals, decide, refusalBody, type Decision } from "@/lib/approvals";
import { coachForToken } from "@/lib/coach-schedule";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const DECISIONS: Decision[] = ["approve", "reject", "ask", "in_person"];

/**
 * At a coach's own link: the applications they are authorised to review,
 * for the activities the venue named them for (lib/approvals.ts). Nothing
 * else of the venue's.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const limited = await rateLimit(req, "login", "coach-self");
  if (limited) return limited;
  const found = await coachForToken((await params).token);
  if (!found || !found.coach.active) return NextResponse.json({ error: "This link is no longer in use." }, { status: 404 });
  return NextResponse.json({ requests: await coachApprovals(found.coach.id) }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ id, action: "approve" | "reject" | "ask" | "in_person", reason? }`: the
 * coach's decision on an application they may review; refused for any other.
 * Recorded under their name.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const limited = await rateLimit(req, "login", "coach-self");
  if (limited) return limited;
  const found = await coachForToken((await params).token);
  if (!found || !found.coach.active) return NextResponse.json({ error: "This link is no longer in use." }, { status: 404 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Application not found." }, { status: 404 });
  if (!DECISIONS.includes(body.action as Decision)) return NextResponse.json({ error: "action is approve, reject, ask or in_person." }, { status: 400 });
  const done = await decide({ kind: "coach", coach: found.coach }, id, body.action as Decision, { reason: body.reason });
  if (!done.ok) return NextResponse.json(refusalBody(done), { status: done.status });
  return NextResponse.json({ request: done.request, bookingCode: done.booking?.code ?? null });
}
