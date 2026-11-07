import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { jsonObject } from "@/lib/api";
import { flaggedHosts, listNoShowMarks, reviewNoShow } from "@/lib/no-show-marks";

export const dynamic = "force-dynamic";

/**
 * A manager's (the platform owner's for every venue): hosts' no-show marks in open games (lib/no-show-marks.ts, ADR 0072).
 * `?show=review` (default): answers waiting for a decision, oldest first, and for the owner marks from before scopes that count everywhere;
 * `?show=recent`: every mark of the last 90 days. With `hosts`: hosts whose marks reviewers often reversed. Front desk is refused
 * (lib/roles.ts). Names are first names only; a manager sees only marks made at their own venues.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const show = req.nextUrl.searchParams.get("show") === "recent" ? "recent" : "review";
  return NextResponse.json({ marks: await listNoShowMarks(admin, show), hosts: await flaggedHosts(admin) });
}

/**
 * `{ id, decision: "reverse" | "uphold" | "platform", note }` — decide one mark. `note` (why) is required and kept. `platform`, the
 * platform owner's alone, makes the mark count at every venue and needs the written justification in `note`. Each decision is in the
 * staff activity log and the player is told by email.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let body: Record<string, unknown>;
  try {
    body = (await jsonObject(req)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!Number.isInteger(body.id)) return NextResponse.json({ error: "Which mark?" }, { status: 400 });
  const done = await reviewNoShow(admin, body.id as number, body.decision, body.note);
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: done.status ?? 409 });
  return NextResponse.json({ marks: await listNoShowMarks(admin, "review"), hosts: await flaggedHosts(admin) });
}
