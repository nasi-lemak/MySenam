import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { getDb } from "@/lib/db";
import { previewTakeOut, setEntry, takeOut, tournamentDetail } from "@/lib/tournaments";
import { OUT_REASONS, type OutReason } from "@/lib/tournament-rules";
import { staffTournament } from "@/lib/tournament-access";

export const dynamic = "force-dynamic";

/**
 * `{ paid?, seed?, checkedIn?, eligibilityChecked? }` — staff on one entry (an eligibility check records who checked,
 * never the document seen); or `{ withdraw: true, reason?, note?, preview?, token? }` to take them out
 * (withdrawn, retired or disqualified): with `preview`, what it would change and a token, nothing changed; after
 * the draw, made only with that token (code CONFIRM without one, CHANGED if the tournament changed since).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; entryId: string }> }) {
  const { id, entryId } = await params;
  const found = await staffTournament(req, id);
  if (found instanceof NextResponse) return found;
  const entry = (await getDb()
    .prepare("SELECT id FROM tournament_entries WHERE id = ? AND tournament_id = ?")
    .get(Number(entryId), found.id)) as { id: number } | undefined;
  if (!entry) return NextResponse.json({ error: "Not found." }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (body.withdraw === true) {
    const reason: OutReason = OUT_REASONS.includes(body.reason as OutReason) ? (body.reason as OutReason) : "withdrawn";
    // Disqualifying somebody is a decision about the competition, not the desk's to make.
    if (reason === "disqualified" && found.admin.role === "desk")
      return NextResponse.json({ error: "Only a manager can disqualify an entrant." }, { status: 403 });
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (reason === "disqualified" && body.preview !== true && note.length < 5)
      return NextResponse.json({ error: "Say why they are disqualified: it is kept with the record." }, { status: 400 });
    if (body.preview === true) {
      const preview = await previewTakeOut(entry.id, reason);
      if (!preview.ok) return NextResponse.json({ error: preview.error }, { status: 409 });
      return NextResponse.json(preview.value);
    }
    // After the draw it changes matches and tables: made only as confirmed against its preview.
    const t = (await getDb().prepare("SELECT status FROM tournaments WHERE id = ?").get(found.id)) as { status: string };
    const token = typeof body.token === "string" ? body.token : null;
    if (t.status === "drawn" && !token)
      return NextResponse.json({ error: "Review what this changes, then confirm it.", code: "CONFIRM" }, { status: 409 });
    const out = await takeOut(entry.id, reason, note || undefined, token ? { token } : undefined);
    if (!out.ok) return NextResponse.json({ error: out.error, code: out.code }, { status: 409 });
    const d = (await tournamentDetail(found.id, { forStaff: true }))!;
    await logAction(found.admin, {
      venueId: d.venueId,
      action: `tournament.${reason}`,
      detail: `${d.name}: ${out.value.entry.name} ${reason}. ${out.value.changes.join(" ")}`,
    });
    return NextResponse.json({ tournament: d, changes: out.value.changes });
  }
  const result = await setEntry(entry.id, {
    paid: typeof body.paid === "boolean" ? body.paid : undefined,
    seed: body.seed === null ? null : body.seed !== undefined ? Number(body.seed) : undefined,
    checkedIn: typeof body.checkedIn === "boolean" ? body.checkedIn : undefined,
    eligibilityCheckedBy: typeof body.eligibilityChecked === "boolean" ? (body.eligibilityChecked ? found.admin.name || found.admin.email : null) : undefined,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ tournament: await tournamentDetail(found.id, { forStaff: true }) });
}
