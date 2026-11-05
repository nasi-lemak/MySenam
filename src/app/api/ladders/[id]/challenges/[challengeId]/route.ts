import { NextRequest, NextResponse } from "next/server";
import { readJsonObject } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ladderResponse } from "@/lib/ladder-access";
import { answer, attachBooking, confirm, detachBooking, dispute, report, withdraw } from "@/lib/ladders";
import { answerMove, proposeMove } from "@/lib/ladders";
import { rateLimit } from "@/lib/rate-limit";
import { requestLadderForfeit, withdrawLadderForfeitRequest } from "@/lib/team-forfeits";
import { reportTeamResult, setTeamLineup } from "@/lib/team-ladders";

export const dynamic = "force-dynamic";

/**
 * A player on one of their own challenges (or one of somebody they act for), `version` being the challenge as they saw it
 * (`ChallengeView.version`; an answer to a challenge that changed since is refused, 409 `LD_CHANGED`):
 * `{ action: "accept", onDate?, minute?, version? }`, `{ action: "decline", version? }`,
 * `{ action: "propose", onDate, minute?, version? }` (a time, which hands the answer to the other side),
 * `{ action: "withdraw", version? }` (the challenger, before it is played), `{ action: "report", winner, score, version? }` (their games
 * first), `{ action: "confirm", version }` and `{ action: "dispute", note, version }`. A challenge holds no court time: once a time is
 * agreed the players book through the venue's ordinary booking page, and either adds that booking to an accepted challenge with
 * `{ action: "attach_booking", code }` (a confirmed booking of this ladder's venue and sport, today or later, made through the account of one of
 * the two players, not on another challenge; refusals `LD_BK_*`) and takes it off with `{ action: "detach_booking" }`. Attaching changes nothing
 * about the booking; if it is cancelled the attachment is dropped and both are told.
 *
 * A ladder that holds court time (a manager turned it on; the venue then holds a court when a day and time are agreed, no money moving): a time is
 * agreed by `{ action: "propose_move", onDate, minute, version? }` (the first specific time, or a move), which the other player answers with
 * `{ action: "agree_move", version? }` (the new time is held first, then the old let go; refused with the reason if nothing is free) or
 * `{ action: "decline_move" }`; the one who asked takes it back with `{ action: "withdraw_move" }` (`LAD2_*` refusals). A ladder of teams: the captain
 * names the lineup with `{ action: "set_lineup", picks: [{ rubber, memberIds }] }` and reports the games with `{ action: "report_team", rubbers:
 * [{ winner: "home" | "away", score?, walkover? }] }` (the challenger's side is `home`; confirm and dispute as above), and asks for a forfeit with
 * `{ action: "request_forfeit", forfeitPlayer, reason, note? }` (a manager decides it) and takes the request back with `{ action:
 * "withdraw_forfeit_request", requestId }`.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; challengeId: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const { id, challengeId } = await params;
  const found = (await getDb().prepare("SELECT id FROM ladder_challenges WHERE id = ? AND ladder_id = ?").get(Number(challengeId), Number(id))) as { id: number } | undefined;
  if (!found) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const limited = await rateLimit(req, "booking");
  if (limited) return limited;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const version = Number.isInteger(body.version) ? (body.version as number) : undefined;
  // An answer is to the challenge the player saw, so it names it.
  if ((body.action === "confirm" || body.action === "dispute") && version === undefined)
    return NextResponse.json({ error: "Say which result you are answering: version is needed." }, { status: 400 });
  // No court is held for a challenge: the players book as anybody does, then add that booking's code to it (lib/ladders.ts `attachBooking`).
  if (body.action === "attach_booking") {
    const done = await attachBooking(user.id, found.id, body.code);
    return done.ok ? NextResponse.json({ booking: done.value }) : ladderResponse(done);
  }
  if (body.action === "detach_booking") {
    const done = await detachBooking(user.id, found.id);
    return done.ok ? NextResponse.json({ ok: true }) : ladderResponse(done);
  }
  // Court time held by the venue, on a ladder that holds it.
  if (body.action === "propose_move") {
    const done = await proposeMove(user.id, found.id, { onDate: body.onDate, minute: body.minute }, { version });
    return done.ok ? NextResponse.json({ challenge: done.value }) : ladderResponse(done);
  }
  if (body.action === "agree_move" || body.action === "decline_move" || body.action === "withdraw_move") {
    const done = await answerMove(user.id, found.id, body.action === "agree_move", { version });
    return done.ok ? NextResponse.json({ challenge: done.value }) : ladderResponse(done);
  }
  // A ladder of teams.
  if (body.action === "set_lineup") {
    const done = await setTeamLineup(user.id, found.id, body.picks);
    return done.ok ? NextResponse.json({ ok: true }) : ladderResponse(done);
  }
  if (body.action === "report_team") {
    const done = await reportTeamResult(user.id, found.id, body.rubbers, { version });
    return done.ok ? NextResponse.json({ result: done.value }) : ladderResponse(done);
  }
  if (body.action === "request_forfeit") {
    const done = await requestLadderForfeit({ userId: user.id }, found.id, { forfeitPlayer: body.forfeitPlayer, reason: body.reason, note: body.note });
    return done.ok ? NextResponse.json({ request: done.value }, { status: 201 }) : ladderResponse(done);
  }
  if (body.action === "withdraw_forfeit_request") {
    const asked = (await getDb().prepare("SELECT id FROM team_forfeit_requests WHERE id = ? AND ladder_challenge_id = ?").get(Number(body.requestId), found.id)) as { id: number } | undefined;
    if (!asked) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const done = await withdrawLadderForfeitRequest({ userId: user.id }, asked.id);
    return done.ok ? NextResponse.json({ ok: true }) : ladderResponse(done);
  }
  const when = { onDate: typeof body.onDate === "string" ? body.onDate : undefined, minute: body.minute === undefined || body.minute === null ? undefined : Number(body.minute) };
  const result =
    body.action === "accept"
      ? await answer(user.id, found.id, { accept: true, ...when }, { version })
      : body.action === "decline"
        ? await answer(user.id, found.id, { decline: true }, { version })
        : body.action === "propose"
          ? await answer(user.id, found.id, { propose: true, onDate: when.onDate ?? "", minute: when.minute }, { version })
          : body.action === "withdraw"
            ? await withdraw(user.id, found.id, { version })
            : body.action === "report"
              ? await report(user.id, found.id, { winner: Number(body.winner), score: String(body.score ?? "") }, { version })
              : body.action === "confirm"
                ? await confirm(user.id, found.id, { version })
                : body.action === "dispute"
                  ? await dispute(user.id, found.id, String(body.note ?? ""), { version })
                  : null;
  if (!result) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (!result.ok) return ladderResponse(result);
  return NextResponse.json({ challenge: result.value });
}
