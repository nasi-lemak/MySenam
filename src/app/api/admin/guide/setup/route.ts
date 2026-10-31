import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { jsonObject } from "@/lib/api";
import { logAction } from "@/lib/activity";
import { acknowledge, dismiss, isGuideId, saveAnswers, validatePatch } from "@/lib/guide/answers";
import { DISCOVERY_RULES } from "@/lib/guide/discover";
import { guideVenue, ownRole, setupView } from "@/lib/guide/http";
import { reviewStepIds } from "@/lib/guide/steps";

export const dynamic = "force-dynamic";

const STALE = "Somebody saved the guide's answers since you opened them. The latest are shown; check them and save again.";

/**
 * The setup view of a venue (`?venueId=`, or the admin's own): its profile
 * read from the saved configuration, the answers and their revision, the
 * plan, the launch readiness and the discoveries. A manager's (lib/roles.ts
 * MANAGER_ONLY: front desk is refused); a branch manager reads their own
 * branches only, as everywhere under /api/admin.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = guideVenue(admin, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  return NextResponse.json(await setupView(venueId, ownRole(admin)), { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ venueId?, action: "answers", answers: { …, key: value | null }, rev }`: save discovery answers on top of
 * revision `rev` (409 with the current view if somebody saved since);
 * `{ action: "acknowledge", step }`: say a review step was reviewed;
 * `{ action: "dismiss", id }`: stop suggesting a capability. Each answers
 * with the venue's setup view and writes one staff log entry.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let body: Record<string, unknown>;
  try {
    body = await jsonObject(req);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const venueId = guideVenue(admin, body.venueId);
  if (venueId instanceof NextResponse) return venueId;
  const role = ownRole(admin);
  const actor = { id: admin.id, name: admin.name };

  if (body.action === "answers") {
    if (!Number.isInteger(body.rev) || (body.rev as number) < 0) return NextResponse.json({ error: "Give the revision (rev) of the answers you were looking at." }, { status: 400 });
    const patch = validatePatch(body.answers);
    if (!patch.ok) return NextResponse.json({ error: patch.error }, { status: 400 });
    const saved = await saveAnswers(venueId, patch.patch, body.rev as number, actor);
    if (!saved.ok) return NextResponse.json({ error: STALE, stale: true, ...(await setupView(venueId, role, saved.state)) }, { status: 409 });
    await logAction(admin, { venueId, action: "guide.answers", detail: `Answers: ${Object.keys(patch.patch).join(", ") || "none"}` });
    return NextResponse.json(await setupView(venueId, role, saved.state));
  }
  if (body.action === "acknowledge") {
    if (!isGuideId(body.step) || !reviewStepIds().includes(body.step)) return NextResponse.json({ error: "That step is not one to review." }, { status: 400 });
    const state = await acknowledge(venueId, body.step, actor);
    await logAction(admin, { venueId, action: "guide.acknowledged", detail: `Step ${body.step}` });
    return NextResponse.json(await setupView(venueId, role, state));
  }
  if (body.action === "dismiss") {
    if (!isGuideId(body.id) || !DISCOVERY_RULES.some((r) => r.capability === body.id)) return NextResponse.json({ error: "That suggestion is not one MySenam makes." }, { status: 400 });
    const state = await dismiss(venueId, body.id, actor);
    await logAction(admin, { venueId, action: "guide.dismissed", detail: `Suggestion ${body.id}` });
    return NextResponse.json(await setupView(venueId, role, state));
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
