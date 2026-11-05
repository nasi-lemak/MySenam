import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, type User } from "@/lib/auth";
import { kindFromUrl, type ContextKind } from "@/lib/message-contexts";
import type { Refusal } from "@/lib/messages";
import { rateLimit, type PolicyName } from "@/lib/rate-limit";

/** A refusal of messages, as the browser reads it: the sentence, its code and what fills it. */
export const refused = (r: Refusal): NextResponse => NextResponse.json({ error: r.error, code: r.code, vars: r.vars }, { status: r.status, headers: { "Cache-Control": "no-store" } });

/**
 * Who is asking, which context they name, and the address's rate limit: or the answer to send. Somebody who is not signed in is told so;
 * a context kind or number that is not one is the same 404 as a context somebody is not in.
 */
export async function messageRequest(
  req: NextRequest,
  params: Promise<{ kind: string; id: string }>,
  policy: PolicyName
): Promise<{ user: User; kind: ContextKind; id: number } | NextResponse> {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, policy);
  if (limited) return limited;
  const p = await params;
  const kind = kindFromUrl(p.kind);
  const id = Number(p.id);
  if (!kind || !Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Not found.", code: "PM_NOT_FOUND" }, { status: 404 });
  return { user, kind, id };
}
