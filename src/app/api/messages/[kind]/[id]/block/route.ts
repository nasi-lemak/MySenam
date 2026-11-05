import { NextRequest, NextResponse } from "next/server";
import { readJsonObject } from "@/lib/api";
import { blockSender } from "@/lib/messages";
import { messageRequest, refused } from "../../../respond";

export const dynamic = "force-dynamic";

/**
 * `{ messageId }`: block whoever wrote a message you can read. The same block as everywhere else (lib/player-safety.ts): nothing they
 * write reaches you, nothing you write reaches them, and neither is told. It is undone where blocks are listed.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ kind: string; id: string }> }) {
  const asked = await messageRequest(req, params, "messageWrite");
  if (asked instanceof NextResponse) return asked;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  if (!Number.isInteger(body.messageId)) return NextResponse.json({ error: "Which message?" }, { status: 400 });
  const done = await blockSender(asked.user.id, asked.kind, asked.id, body.messageId as number);
  if (!done.ok) return refused(done);
  return NextResponse.json({ ok: true });
}
