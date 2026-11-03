import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { readJsonObject, refusal } from "@/lib/api";
import { getDb } from "@/lib/db";
import { ladderResponse, staffLadder } from "@/lib/ladder-access";
import { changeSettings, decide, endSeason, freeze, ladderDetail, leave, moveTo, thaw, type Decision, type LadderSettings } from "@/lib/ladders";
import { setEventRated } from "@/lib/ratings";

export const dynamic = "force-dynamic";

/** The ladder as staff see it, `?season=` for an earlier one: every place with who it is, the ledger and every challenge. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffLadder(req, (await params).id);
  if (found instanceof NextResponse) return found;
  const raw = req.nextUrl.searchParams.get("season");
  return NextResponse.json({ ladder: await ladderDetail(found.id, { forStaff: true, season: raw ? Number(raw) : undefined }) });
}

/**
 * A manager's (the desk reads, and adds players at the counter on `/players`). `{ action: "settings", settings }`; `{ action: "rated",
 * rated }` (until the first result is in); `{ action: "end_season" }` archives the final order and carries the ladder into the next
 * season; `{ action: "close" }` ends the season and the ladder; `{ action: "decide", challengeId, reason, winner?, score?, walkover? | void:
 * true | clear: true }` decides or corrects a challenge's result (its place in the ledger is kept, every rank after it is replayed);
 * `{ action: "move", playerId, rank, reason }`; `{ action: "remove", playerId, reason }`; `{ action: "freeze", playerId, until }` and
 * `{ action: "thaw", playerId }`. Each is in the activity log, with the reason where it has one.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffLadder(req, (await params).id);
  if (found instanceof NextResponse) return found;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const before = (await ladderDetail(found.id, { forStaff: true }))!;
  const log = (action: string, detail: string) => logAction(found.admin, { venueId: before.venueId, action, detail: `${before.name}: ${detail}` });
  const reason = typeof body.reason === "string" ? body.reason : "";
  const by = { adminId: found.admin.id, name: found.admin.name ?? found.admin.email };
  const playerOf = async (raw: unknown) => {
    const p = (await getDb().prepare("SELECT id, name FROM ladder_players WHERE id = ? AND ladder_id = ?").get(Number(raw), found.id)) as { id: number; name: string } | undefined;
    return p ?? null;
  };

  if (body.action === "settings") {
    const done = await changeSettings(found.id, (body.settings && typeof body.settings === "object" ? body.settings : {}) as Partial<LadderSettings>);
    if (!done.ok) return ladderResponse(done);
    await log("ladder.settings", JSON.stringify(done.value.settings));
  } else if (body.action === "rated") {
    const done = await setEventRated("ladder", found.id, body.rated === true);
    if (!done.ok) return refusal(done, done.status ?? 409);
    await log("ladder.rated", done.value.rated ? "its results count towards ratings" : "its results no longer count towards ratings");
  } else if (body.action === "end_season" || body.action === "close") {
    const done = await endSeason(found.id, { close: body.action === "close" });
    if (!done.ok) return ladderResponse(done);
    await log(body.action === "close" ? "ladder.closed" : "ladder.season_ended", `season ${before.season?.number ?? ""}`);
  } else if (body.action === "decide") {
    const challenge = before.challenges.find((c) => c.id === Number(body.challengeId));
    if (!challenge) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const decision: Decision =
      body.void === true ? { void: true } : body.clear === true ? { clear: true } : { winner: Number(body.winner), score: typeof body.score === "string" ? body.score : undefined, walkover: body.walkover === true };
    const done = await decide(challenge.id, by, decision, reason);
    if (!done.ok) return ladderResponse(done);
    await log("ladder.result_decided", `${challenge.challengerName} v ${challenge.challengedName}: ${"void" in decision ? "struck" : "clear" in decision ? "put back to be played" : done.value.forfeit ? "walkover" : done.value.score ?? ""} (${reason.trim().slice(0, 200)})`);
  } else if (body.action === "move") {
    const p = await playerOf(body.playerId);
    if (!p) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const done = await moveTo(p.id, Number(body.rank), { name: by.name }, reason);
    if (!done.ok) return ladderResponse(done);
    await log("ladder.moved", `${p.name} to rank ${done.value.rank} (${reason.trim().slice(0, 200)})`);
  } else if (body.action === "remove") {
    const p = await playerOf(body.playerId);
    if (!p) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const done = await leave(p.id, { name: by.name, reason });
    if (!done.ok) return ladderResponse(done);
    await log("ladder.removed", `${p.name} (${reason.trim().slice(0, 200)})`);
  } else if (body.action === "freeze" || body.action === "thaw") {
    const p = await playerOf(body.playerId);
    if (!p) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const done = body.action === "freeze" ? await freeze(null, p.id, String(body.until ?? ""), { name: by.name }) : await thaw(null, p.id, { name: by.name });
    if (!done.ok) return ladderResponse(done);
    await log(body.action === "freeze" ? "ladder.frozen" : "ladder.thawed", body.action === "freeze" ? `${p.name} until ${String(body.until)}` : p.name);
  } else return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  return NextResponse.json({ ladder: await ladderDetail(found.id, { forStaff: true }) });
}
