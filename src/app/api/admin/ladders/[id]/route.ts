import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { readJsonObject, refusal } from "@/lib/api";
import { getDb } from "@/lib/db";
import { ladderResponse, staffLadder } from "@/lib/ladder-access";
import { changeCourtTime, changeHoldLimits, changeSettings, decide, endSeason, freeze, ladderDetail, leave, liftHoldPause, moveTo, staffHold, thaw, type Decision, type LadderSettings } from "@/lib/ladders";
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
 *
 * Court time (the venue holds a court for an accepted challenge, no money moving; off unless turned on): `{ action: "court_time", on?, courtIds?,
 * minutes?, needsConfirmation? }`; `{ action: "hold_limits", scope: "venue" | "ladder", maxLive?, maxActive?, maxCancelled?, reason? }` sets the limits: holds
 * live at once on a ladder, holds live at once for one player (`maxWeek` is its old name), and the holds that really reserved a court that a player may cancel themself in the window
 * before a pause on creating new ones (`maxCancelled`; `maxAbandoned` is its old name; ADR 0051), each a number within the install's bounds, `null` for the default above (`LAD3_BOUNDS`);
 * `{ action: "hold_pause_lift", playerId, reason }` lifts a player's pause on creating new holds, with a reason (kept and logged); `{ action: "hold_confirm", challengeId, reason? }` confirms a tentative hold for both
 * players and `{ action: "hold_extend", challengeId, reason }` gives it more time, once (ADR 0048); `{ action: "hold_release", challengeId, reason }` lets a challenge's hold go; `{ action: "hold_move", challengeId, onDate, minute, courtId?,
 * reason }` moves it (the new time is held first; refused with the reason, the old court staying held, if it cannot be). A ladder of teams decides a
 * match with `{ action: "decide", challengeId, reason, rubbers: [{ winner: "home" | "away", score?, walkover? }] }` (the challenger's side is `home`).
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

  if (body.action === "court_time") {
    const done = await changeCourtTime(found.id, { on: body.on, courtIds: body.courtIds, minutes: body.minutes, needsConfirmation: body.needsConfirmation });
    if (!done.ok) return ladderResponse(done);
    await log(
      "ladder.court_time",
      `${done.value.courtTime.on ? `the venue holds court time for accepted challenges (${done.value.courtTime.matchMinutes} minutes)` : "the venue does not hold court time for challenges"}; ${done.value.courtTime.needsConfirmation ? "a hold has to be confirmed by both players" : "a hold is confirmed when made"}`
    );
  } else if (body.action === "hold_limits") {
    // The caps on held court time (ADR 0048): the venue's or this ladder's, within the install's bounds. Logged with who, before and after, and why.
    const scope = body.scope === "venue" ? "venue" : "ladder";
    const done = await changeHoldLimits(found.id, scope, { maxLive: body.maxLive, maxActive: body.maxActive, maxWeek: body.maxWeek, maxCancelled: body.maxCancelled, maxAbandoned: body.maxAbandoned });
    if (!done.ok) return ladderResponse(done);
    const { before: was, after: now } = done.value;
    const of = (v: typeof was) => (scope === "venue" ? v.venue : v.ladder);
    const show = (n: number | null) => (n === null ? "default" : String(n));
    await log(
      "ladder.hold_limits",
      `${scope === "venue" ? "the venue's" : "this ladder's"} limits on held court time: live per ladder ${show(of(was).maxLivePerLadder)} to ${show(of(now).maxLivePerLadder)}, live per player ${show(of(was).maxActivePerPlayer)} to ${show(of(now).maxActivePerPlayer)}, own cancellations of held courts before a pause on new holds ${show(of(was).cancelThreshold)} to ${show(of(now).cancelThreshold)}${reason.trim() ? ` (${reason.trim().slice(0, 200)})` : ""}`
    );
  } else if (body.action === "hold_pause_lift") {
    // A pause on creating new holds is temporary and a manager can lift it, with a reason (ADR 0051): kept in the neutral record and logged by the lift itself.
    const done = await liftHoldPause(found.id, body.playerId, by, reason);
    if (!done.ok) return ladderResponse(done);
  } else if (body.action === "hold_confirm" || body.action === "hold_extend") {
    const challenge = (before.challenges ?? []).find((c) => c.id === Number(body.challengeId));
    if (!challenge) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const done = await staffHold(challenge.id, by, body.action === "hold_confirm" ? { confirm: true } : { extend: true }, reason);
    if (!done.ok) return ladderResponse(done);
    await log(
      body.action === "hold_confirm" ? "ladder.hold_confirmed" : "ladder.hold_extended",
      `${challenge.challengerName} v ${challenge.challengedName}${reason.trim() ? ` (${reason.trim().slice(0, 200)})` : ""}`
    );
  } else if (body.action === "hold_release" || body.action === "hold_move") {
    const challenge = (before.challenges ?? []).find((c) => c.id === Number(body.challengeId));
    if (!challenge) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const done = await staffHold(challenge.id, by, body.action === "hold_release" ? { release: true } : { move: { onDate: body.onDate, minute: body.minute, courtId: body.courtId } }, reason);
    if (!done.ok) return ladderResponse(done);
    await log(
      body.action === "hold_release" ? "ladder.hold_released" : "ladder.hold_moved",
      `${challenge.challengerName} v ${challenge.challengedName}${body.action === "hold_move" && done.value.hold ? `: now ${done.value.hold.court} on ${done.value.hold.date}` : ""} (${reason.trim().slice(0, 200)})`
    );
  } else if (body.action === "settings") {
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
    const challenge = (before.challenges ?? []).find((c) => c.id === Number(body.challengeId));
    if (!challenge) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const decision: Decision =
      body.void === true ? { void: true } : body.clear === true ? { clear: true } : body.rubbers !== undefined ? { rubbers: body.rubbers } : { winner: Number(body.winner), score: typeof body.score === "string" ? body.score : undefined, walkover: body.walkover === true };
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
