import { NextRequest, NextResponse } from "next/server";
import { readJsonObject } from "@/lib/api";
import { reportMessage } from "@/lib/messages";
import { messageRequest, refused } from "../../../respond";

export const dynamic = "force-dynamic";

/**
 * `{ messageId, reason: "abuse" | "spam" | "contact" | "safety" | "other", note? }`: report a message you can read, not your own. A copy of
 * the thread's last messages as you see them is kept with the report for the venue's staff (the platform owner where the context has no
 * venue). Reporting the same message again is the same report.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ kind: string; id: string }> }) {
  const asked = await messageRequest(req, params, "messageWrite");
  if (asked instanceof NextResponse) return asked;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const done = await reportMessage(asked.user.id, asked.kind, asked.id, { messageId: body.messageId, reason: body.reason, note: body.note });
  if (!done.ok) return refused(done);
  // Whether a report tipped somebody into a suspension is not told to the reporter.
  return NextResponse.json({ ok: true });
}
