import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { readJsonObject } from "@/lib/api";
import { getDb } from "@/lib/db";
import { staffTournament } from "@/lib/tournament-access";
import { callFixture, dayBoard, decideNoShow, releaseCall, setDaySettings, startFixture, type Actor, type NoShowDecision } from "@/lib/tournament-day";
import { tournamentById } from "@/lib/tournaments";

export const dynamic = "force-dynamic";

/** The *Now and next* board of a tournament that is drawn: each court's fixture and the next, who is waiting and why not yet, the latest results. Any staff of the venue may read it. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffTournament(req, (await params).id);
  if (found instanceof NextResponse) return found;
  return NextResponse.json({ board: await dayBoard(found.id) }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * A manager's calls on the day (the desk checks in and enters results, and is refused these: `MANAGER_ONLY`):
 * `{ action: "call", matchId, courtId? }` (to `courtId` when given: a freed court, from the next minute, held like any
 * move), `{ action: "start", matchId }`, `{ action: "release", matchId }`, `{ action: "decide", matchId, decision:
 * { action: "wait" } | { action: "forfeit", absent, outOfEvent?, note? } | { action: "swap" } }` for a called fixture nobody
 * came to, `{ action: "settings", minRestMinutes?, callWaitMinutes?, announceNext?, liveNames? }`.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffTournament(req, (await params).id);
  if (found instanceof NextResponse) return found;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const t = (await tournamentById(found.id))!;
  const actor: Actor = { id: found.admin.id, name: found.admin.name, role: "manager" };
  const matchId = Number(body.matchId);
  const refuse = (r: { error: string; code?: string; vars?: Record<string, string | number> }) =>
    NextResponse.json({ error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.vars ? { vars: r.vars } : {}) }, { status: 409 });
  const label = (board: { waiting: { id: number; label: string; a: { name: string | null }; b: { name: string | null } }[]; courts: { now: { id: number; label: string; a: { name: string | null }; b: { name: string | null } } | null }[] }) => {
    const f = board.waiting.find((x) => x.id === matchId) ?? board.courts.map((c) => c.now).find((x) => x?.id === matchId);
    return f ? `${f.label}: ${f.a.name ?? "?"} v ${f.b.name ?? "?"}` : `match ${matchId}`;
  };

  if (body.action === "settings") {
    const done = await setDaySettings(found.id, {
      minRestMinutes: body.minRestMinutes,
      callWaitMinutes: body.callWaitMinutes,
      announceNext: body.announceNext,
      liveNames: body.liveNames,
    });
    if (!done.ok) return NextResponse.json({ error: done.error }, { status: 400 });
    const s = done.value.settings;
    await logAction(found.admin, {
      venueId: t.venueId,
      action: "tournament.day_settings",
      detail: `${t.name}: rest ${s.minRestMinutes} min, a called match waits ${s.callWaitMinutes} min, entrants ${s.announceNext ? "are" : "are not"} told, live names ${s.liveNames} (was: rest ${t.minRestMinutes}, wait ${t.callWaitMinutes}, ${t.announceNext ? "told" : "not told"}, ${t.liveNames})`,
    });
    return NextResponse.json({ board: done.value });
  }
  if (!Number.isInteger(matchId)) return NextResponse.json({ error: "Give the match." }, { status: 400 });
  const mine = await getDb().prepare("SELECT 1 FROM tournament_matches WHERE id = ? AND tournament_id = ?").get(matchId, found.id);
  if (!mine) return NextResponse.json({ error: "That match is not in this tournament." }, { status: 404 });

  if (body.action === "call") {
    const done = await callFixture(matchId, actor, Number.isInteger(body.courtId) ? { courtId: body.courtId as number } : {});
    if (!done.ok) return refuse(done);
    await logAction(found.admin, {
      venueId: t.venueId,
      action: "tournament.match_called",
      detail: `${t.name}, ${label(done.value.board)}, ${done.value.moved ?? `on ${done.value.board.courts.find((c) => c.now?.id === matchId)?.name ?? "its court"}`}`,
    });
    return NextResponse.json({ board: done.value.board, moved: done.value.moved });
  }
  if (body.action === "start") {
    const done = await startFixture(matchId, actor);
    if (!done.ok) return refuse(done);
    await logAction(found.admin, { venueId: t.venueId, action: "tournament.match_started", detail: `${t.name}, ${label(done.value.board)}` });
    return NextResponse.json({ board: done.value.board });
  }
  if (body.action === "release") {
    const done = await releaseCall(matchId, actor);
    if (!done.ok) return refuse(done);
    await logAction(found.admin, { venueId: t.venueId, action: "tournament.call_released", detail: `${t.name}, match ${matchId}` });
    return NextResponse.json({ board: done.value.board });
  }
  if (body.action === "decide") {
    const d = (body.decision ?? {}) as Record<string, unknown>;
    const decision: NoShowDecision | null =
      d.action === "wait"
        ? { action: "wait" }
        : d.action === "swap"
          ? { action: "swap" }
          : d.action === "forfeit"
            ? { action: "forfeit", absent: Number(d.absent), outOfEvent: d.outOfEvent === true, note: typeof d.note === "string" ? d.note : undefined }
            : null;
    if (!decision) return NextResponse.json({ error: 'decision.action is "wait", "forfeit" or "swap".' }, { status: 400 });
    const done = await decideNoShow(matchId, decision, actor);
    if (!done.ok) return refuse(done);
    await logAction(found.admin, {
      venueId: t.venueId,
      action: "tournament.no_show_decided",
      detail: `${t.name}, match ${matchId}: ${decision.action}${done.value.detail ? `. ${done.value.detail}` : ""}`,
    });
    return NextResponse.json({ board: done.value.board, detail: done.value.detail ?? null });
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
