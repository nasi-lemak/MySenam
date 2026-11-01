import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { jsonObject } from "@/lib/api";
import { grantsFor, revokeGrantAs } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";

/**
 * AI assistants connected by signing in (docs/integrations/mcp.md#revoking):
 * every member of staff sees and revokes their own; a manager also those of
 * anybody at the venues they manage. Each with the client's name as it gave
 * it (not verified), the venue, whose it is, what it may do, and when it was
 * last used.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json({ assistants: await grantsFor(admin) }, { headers: { "Cache-Control": "no-store" } });
}

/** `{ action: "revoke", id }`: the connection ends at once, every token of it; in the staff activity log (`oauth.revoked`). */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let body: Record<string, unknown>;
  try {
    body = await jsonObject(req);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (body.action !== "revoke" || !Number.isInteger(body.id)) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  const done = await revokeGrantAs(admin, body.id as number);
  if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
  return NextResponse.json({ assistants: await grantsFor(admin) });
}
