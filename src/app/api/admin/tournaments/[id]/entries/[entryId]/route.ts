import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { getDb } from "@/lib/db";
import { previewTakeOut, setEntry, takeOut, tournamentDetail } from "@/lib/tournaments";
import { OUT_REASONS, type OutReason } from "@/lib/tournament-rules";
import { staffTournament } from "@/lib/tournament-access";

export const dynamic = "force-dynamic";

/**
 * `{ paid?, seed? }` — staff on one entry; or `{ withdraw: true, reason?, note?, preview? }` to take them out
 * (withdrawn, retired or disqualified): with `preview`, what it would change, and nothing changed.
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
    if (body.preview === true) {
      const preview = await previewTakeOut(entry.id, reason);
      if (!preview.ok) return NextResponse.json({ error: preview.error }, { status: 409 });
      return NextResponse.json({ changes: preview.value.changes });
    }
    const out = await takeOut(entry.id, reason, typeof body.note === "string" ? body.note : undefined);
    if (!out.ok) return NextResponse.json({ error: out.error }, { status: 409 });
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
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ tournament: await tournamentDetail(found.id, { forStaff: true }) });
}
