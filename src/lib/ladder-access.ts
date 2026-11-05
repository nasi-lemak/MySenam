import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin, type Admin } from "./admin-auth";
import { refusal } from "./api";
import { ladderById, type LadderRefusal } from "./ladders";

/** The ladder, if this admin runs its venue; else the response to send. */
export async function staffLadder(req: NextRequest, rawId: string): Promise<{ admin: Admin; id: number } | NextResponse> {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const ladder = await ladderById(Number(rawId));
  if (!ladder) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const denied = denyVenue(admin, ladder.venueId);
  if (denied) return denied;
  return { admin, id: ladder.id };
}

/** A ladder's refusal on its way to the browser, with the status it carries (code and variables for the reader's language). */
export const ladderResponse = (r: LadderRefusal): NextResponse => {
  // A stale act (`LAD5_STALE`) is answered with the challenge as it is now, so the page shows the current proposal again (ADR 0051).
  if (r.challenge) return NextResponse.json({ error: r.error, code: r.code, vars: r.vars, challenge: r.challenge }, { status: r.status });
  return refusal(r, r.status);
};
