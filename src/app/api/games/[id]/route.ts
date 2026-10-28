import { NextRequest, NextResponse } from "next/server";
import { phoneRefusal } from "@/lib/phone-check";
import { jsonObject, refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import {
  askToJoin,
  cancelGame,
  closeGame,
  createGameLink,
  gameForViewer,
  inviteByEmail,
  invitePlayer,
  leaveGame,
  revokeGameLinks,
  withdrawEmailInvitation,
} from "@/lib/games";
import { startSharePayment } from "@/lib/payments";
import { inviteRegulars } from "@/lib/game-series";
import { keepPlace } from "@/lib/game-moves";
import { tickOutbox } from "@/lib/notify";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * One game, as the signed-in player (or nobody) may see it: a private game
 * only to its host, whoever is in it or invited, and `?link=` holders. Its
 * host also sees everybody who asked.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gameId = Number((await params).id);
  if (!Number.isInteger(gameId) || gameId <= 0) return NextResponse.json({ error: "Invalid game." }, { status: 400 });
  const user = await getSessionUser(req);
  const game = await gameForViewer(gameId, user?.id ?? null, req.nextUrl.searchParams.get("link") ?? undefined);
  if (!game) return NextResponse.json({ error: "That game is not there any more." }, { status: 404 });
  return NextResponse.json({ game, signedIn: user !== null });
}

/**
 * `{ action }` on one game, by the signed-in player: "join" (ask, join
 * outright where the host lets everybody in, join the waiting list, or take
 * up an invitation or a held place; `link` for a private game), "leave"
 * (also turns down an invitation or a held place), "pay" (your share,
 * online, to the venue — answers with where to pay), "invite" (`userId` or
 * `email`); or, for its host, "close", "cancel" (call it off, keeping the
 * court), "link" (`hours`: a link to share), "unlink" (withdraw them all)
 * and, for a weekly game, "inviteRegulars" (last week's players invited);
 * for its host or whoever sent it, "withdrawInvitation" (`invitationId`: an
 * invitation by email not yet accepted; its link then works no more);
 * "keepPlace" (a player in it agreeing to a new time it is moving to, or
 * confirming the venue's change; to say no, "leave").
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in to join a game." }, { status: 401 });
  const gameId = Number((await params).id);
  if (!Number.isInteger(gameId) || gameId <= 0) return NextResponse.json({ error: "Invalid game." }, { status: 400 });
  let body: Record<string, unknown>;
  try {
    body = (await jsonObject(req)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (body.action === "pay") {
    const limited = await rateLimit(req, "payment");
    if (limited) return limited;
    const paying = await startSharePayment(user, gameId);
    if (!paying.ok) return NextResponse.json({ error: paying.error }, { status: paying.status });
    return NextResponse.json({ url: paying.url, amount: paying.amount });
  }
  if (body.action === "invite") {
    const limited = await rateLimit(req, "social");
    if (limited) return limited;
    const invited =
      typeof body.email === "string"
        ? await inviteByEmail(user.id, gameId, body.email)
        : Number.isInteger(body.userId)
          ? await invitePlayer(user.id, gameId, body.userId as number)
          : null;
    if (!invited) return NextResponse.json({ error: "Who?" }, { status: 400 });
    if (!invited.ok) return NextResponse.json({ error: invited.error, code: invited.code }, { status: invited.status ?? 409 });
    return NextResponse.json({ game: invited.game });
  }
  if (body.action === "link") {
    const made = await createGameLink(user.id, gameId, body.hours === undefined ? undefined : Number(body.hours));
    if (!made.ok) return NextResponse.json({ error: made.error }, { status: made.status ?? 409 });
    return NextResponse.json({ url: made.url, expiresAt: made.expiresAt });
  }
  if (body.action === "unlink") return NextResponse.json({ revoked: await revokeGameLinks(user.id, gameId) });
  if (body.action === "withdrawInvitation") {
    const withdrawn = await withdrawEmailInvitation(user.id, gameId, body.invitationId);
    if (!withdrawn.ok) return NextResponse.json({ error: withdrawn.error, code: withdrawn.code }, { status: withdrawn.status });
    return NextResponse.json({ withdrawn: true, game: await gameForViewer(gameId, user.id) });
  }
  if (body.action === "keepPlace") {
    const kept = await keepPlace(user.id, gameId);
    if (!kept.ok) return NextResponse.json({ error: kept.error }, { status: kept.status ?? 409 });
    await tickOutbox();
    return NextResponse.json({ game: await gameForViewer(gameId, user.id) });
  }
  if (body.action === "inviteRegulars") {
    const limited = await rateLimit(req, "social");
    if (limited) return limited;
    const sent = await inviteRegulars(user.id, gameId);
    if (!sent.ok) return NextResponse.json({ error: sent.error }, { status: sent.status });
    return NextResponse.json(sent);
  }
  if (body.action === "join") {
    const limited = await rateLimit(req, "booking");
    if (limited) return limited;
    const noPhone = await phoneRefusal(user.id);
    if (noPhone) return refusal(noPhone, 403);
  }
  const result =
    body.action === "join"
      ? await askToJoin(user, gameId, { link: typeof body.link === "string" ? body.link : undefined })
      : body.action === "leave"
        ? await leaveGame(user.id, gameId)
        : body.action === "close"
          ? await closeGame(user.id, gameId)
          : body.action === "cancel"
            ? await cancelGame(user.id, gameId)
            : null;
  if (!result) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status ?? 409 });
  return NextResponse.json({ game: result.game });
}
