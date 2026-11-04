import { NextRequest, NextResponse } from "next/server";
import { jsonObject } from "@/lib/api";
import { applyCorrectionRequest, declineCorrectionRequest, listCorrectionRequests, previewCorrectionRequest } from "@/lib/official-performances";
import { staffTournament } from "@/lib/tournament-access";
import { tournamentDetail } from "@/lib/tournaments";

export const dynamic = "force-dynamic";

/**
 * A manager reviews a correction an official asked for in a climbing event's finished round (`MANAGER_ONLY`; the correction flow
 * of docs/features/tournaments.md#officials-and-counted-results): `{ action: "preview" }` says what applying it would change and
 * gives the `token` of that look; `{ action: "apply", token }` saves the official's intended counts, only as previewed (409
 * `CHANGED` if the event moved since); `{ action: "decline", note }` declines it with a reason. Each is in the activity log.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; requestId: string }> }) {
  const { id, requestId } = await params;
  const found = await staffTournament(req, id);
  if (found instanceof NextResponse) return found;
  let body: Record<string, unknown>;
  try {
    body = (await jsonObject(req)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const request = Number(requestId);
  if (!Number.isInteger(request)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const admin = { id: found.admin.id, name: found.admin.name };
  if (body.action === "preview") {
    const preview = await previewCorrectionRequest(found.id, request);
    if (!preview.ok) return NextResponse.json({ error: preview.error, code: preview.code }, { status: preview.error === "Not found." ? 404 : 409 });
    return NextResponse.json({ preview: preview.value });
  }
  if (body.action === "apply") {
    const done = await applyCorrectionRequest(found.id, request, admin, body.token);
    if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: done.error === "Not found." ? 404 : 409 });
    return NextResponse.json({ tournament: done.value, requests: await listCorrectionRequests(found.id) });
  }
  if (body.action === "decline") {
    const done = await declineCorrectionRequest(found.id, request, admin, body.note);
    if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: done.error === "Not found." ? 404 : done.code === "OFC_REASON" ? 400 : 409 });
    return NextResponse.json({ tournament: await tournamentDetail(found.id, { forStaff: true }), requests: await listCorrectionRequests(found.id) });
  }
  return NextResponse.json({ error: "Preview it, apply it with the token, or decline it with a note." }, { status: 400 });
}
