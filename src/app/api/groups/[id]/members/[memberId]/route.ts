import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { decideMember } from "@/lib/groups";

export const dynamic = "force-dynamic";

const ACTIONS = ["accept", "decline", "remove"] as const;

/** `{ action: "accept" | "decline" | "remove" }`: the organiser on one person. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; memberId: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const memberId = Number((await params).memberId);
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  if (!Number.isInteger(memberId) || !ACTIONS.includes(body?.action as (typeof ACTIONS)[number]))
    return NextResponse.json({ error: "Who, and what?" }, { status: 400 });
  const done = await decideMember(user.id, memberId, body!.action as (typeof ACTIONS)[number]);
  if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status ?? 409 });
  return NextResponse.json({ group: done.group });
}
