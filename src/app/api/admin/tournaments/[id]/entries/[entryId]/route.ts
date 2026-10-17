import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { setEntry, tournamentDetail, withdraw } from "@/lib/tournaments";
import { staffTournament } from "@/lib/tournament-access";

export const dynamic = "force-dynamic";

/** `{ paid?, seed?, withdraw? }` — staff on one entry. */
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
  const result =
    body.withdraw === true
      ? await withdraw(entry.id)
      : await setEntry(entry.id, {
          paid: typeof body.paid === "boolean" ? body.paid : undefined,
          seed: body.seed === null ? null : body.seed !== undefined ? Number(body.seed) : undefined,
        });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ tournament: await tournamentDetail(found.id, { forStaff: true }) });
}
