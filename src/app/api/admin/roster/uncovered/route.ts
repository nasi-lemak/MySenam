import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { jsonObject } from "@/lib/api";
import { coverSession, overrideSession, recommendedGaps, undoDecision, uncoveredSessions } from "@/lib/rosters";
import { getVenue } from "@/lib/store";

export const dynamic = "force-dynamic";

const venueIdOf = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * Sessions to come that have too few qualified people on shift and no decision of a manager (lib/rosters.ts
 * `uncoveredSessions`): the manager's worklist, which the needs-attention panel shows too. `?venueId` for one venue,
 * else every venue the account manages. Front desk may read it.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const asked = req.nextUrl.searchParams.get("venueId");
  const venueId = asked === null ? undefined : (venueIdOf(asked) ?? -1);
  if (venueId !== undefined) {
    if (venueId < 0) return NextResponse.json({ error: "venueId is not a venue." }, { status: 400 });
    const denied = denyVenue(admin, venueId);
    if (denied) return denied;
  }
  return NextResponse.json(
    {
      sessions: await uncoveredSessions(admin.venueIds, venueId === undefined ? {} : { venueId }),
      // Covered, but by somebody a recommended qualification is not recorded for (advisory, ADR 0046): for one venue.
      ...(venueId === undefined ? {} : { advisory: await recommendedGaps(venueId) }),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * A manager decides an uncovered session: `{ venueId, action: "cover", kind, id, roleId, personKind, personId }` names
 * another person to supervise it; `{ …, action: "override", kind, id, roleId, reason }` lets it stand without, with the reason
 * (kept); `{ …, action: "undo", decisionId }` takes either back. Moving or cancelling the session is the usual path.
 * Nothing here cancels a booking or tells a customer.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let b: Record<string, unknown>;
  try {
    b = await jsonObject(req);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const venueId = venueIdOf(b.venueId);
  if (venueId === null || !(await getVenue(venueId))) return NextResponse.json({ error: "Venue not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const by = { id: admin.id, name: admin.name };
  const session = `${String(b.kind)} ${String(b.id)}`;
  if (b.action === "cover") {
    const done = await coverSession(venueId, { kind: b.kind, id: b.id, roleId: b.roleId, personKind: b.personKind, personId: b.personId }, by);
    if (!done.ok) return NextResponse.json({ error: done.error }, { status: (done as { status?: number }).status ?? 400 });
    await logAction(admin, { venueId, action: "roster.cover", detail: `Named ${String(b.personKind)} ${String(b.personId)} to supervise ${session}` });
  } else if (b.action === "override") {
    const done = await overrideSession(venueId, { kind: b.kind, id: b.id, roleId: b.roleId, reason: b.reason }, by);
    if (!done.ok) return NextResponse.json({ error: done.error }, { status: (done as { status?: number }).status ?? 400 });
    await logAction(admin, { venueId, action: "roster.override", detail: `Let ${session} stand without a supervisor: ${String(b.reason).slice(0, 200)}` });
  } else if (b.action === "undo") {
    const done = await undoDecision(venueId, b.decisionId);
    if (!done.ok) return NextResponse.json({ error: done.error }, { status: (done as { status?: number }).status ?? 400 });
    await logAction(admin, { venueId, action: "roster.decision_undone", detail: `Took back decision ${String(b.decisionId)}` });
  } else {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
  return NextResponse.json({ sessions: await uncoveredSessions(admin.venueIds, { venueId }) });
}
