import { NextRequest, NextResponse } from "next/server";
import { readJsonObject } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ladderResponse } from "@/lib/ladder-access";
import { answer, attachBooking, confirm, detachBooking, dispute, report, withdraw } from "@/lib/ladders";
import { rateLimit } from "@/lib/rate-limit";

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
