import { NextRequest, NextResponse } from "next/server";
import { readJsonObject, refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import {
  addOwnChild,
  archiveTeam,
  createInviteLink,
  inviteByEmail,
  leaveTeam,
  removeMember,
  restoreTeam,
  setMemberDetails,
  teamView,
  transferCaptain,
  updateTeam,
  withdrawInvitation,
} from "@/lib/teams";

export const dynamic = "force-dynamic";


/** One team as you may see it: its members the roster; anybody else its name and sport, if the captain published it. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid team." }, { status: 400 });
  const user = await getSessionUser(req);
  const team = await teamView(id, user?.id ?? null);
  if (!team) return NextResponse.json({ error: "That team is not there.", code: "TM_NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ team, signedIn: user !== null });
}

/** The captain's changes: `{ name?, description?, venueId?, groupId?, published? }`. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid team." }, { status: 400 });
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const done = await updateTeam(user.id, id, body);
  if (!done.ok) return refusal(done, done.status ?? 409);
  return NextResponse.json({ team: done.value });
}

/**
 * `{ action }`: for the captain, "inviteEmail" (`email`), "inviteLink" (the link comes back once), "withdrawInvitation"
 * (`invitationId`), "addChild" (`participantId`, `birthDate?`, `gender?`: a child you manage yourself), "remove"
 * (`memberId`), "transfer" (`memberId`), "archive", "restore"; for a member, "leave" (`participantId?` for a child you
 * act for) and "details" (`memberId`, `birthDate?`, `gender?`: what you say about yourself or the child, for an event's
 * age range and category).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid team." }, { status: 400 });
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  if (body.action === "inviteEmail" || body.action === "inviteLink") {
    const limited = await rateLimit(req, "social");
    if (limited) return limited;
  }
  switch (body.action) {
    case "inviteEmail": {
      const done = await inviteByEmail(user.id, id, body.email);
      return done.ok ? NextResponse.json({ ...done.value, team: await teamView(id, user.id) }) : refusal(done, done.status ?? 409);
    }
    case "inviteLink": {
      const done = await createInviteLink(user.id, id);
      return done.ok ? NextResponse.json({ ...done.value, team: await teamView(id, user.id) }, { status: 201 }) : refusal(done, done.status ?? 409);
    }
    case "withdrawInvitation": {
      const done = await withdrawInvitation(user.id, id, body.invitationId);
      return done.ok ? NextResponse.json({ ...done.value, team: await teamView(id, user.id) }) : refusal(done, done.status ?? 409);
    }
    case "addChild": {
      const done = await addOwnChild(user.id, id, body.participantId, { birthDate: body.birthDate, gender: body.gender });
      return done.ok ? NextResponse.json({ team: done.value }) : refusal(done, done.status ?? 409);
    }
    case "remove": {
      const done = await removeMember(user.id, id, body.memberId);
      return done.ok ? NextResponse.json({ team: done.value }) : refusal(done, done.status ?? 409);
    }
    case "transfer": {
      const done = await transferCaptain(user.id, id, body.memberId);
      return done.ok ? NextResponse.json({ team: done.value }) : refusal(done, done.status ?? 409);
    }
    case "archive":
    case "restore": {
      const done = body.action === "archive" ? await archiveTeam(user.id, id) : await restoreTeam(user.id, id);
      return done.ok ? NextResponse.json({ team: done.value }) : refusal(done, done.status ?? 409);
    }
    case "leave": {
      const done = await leaveTeam(user.id, id, body.participantId);
      return done.ok ? NextResponse.json({ left: true, team: await teamView(id, user.id) }) : refusal(done, done.status ?? 409);
    }
    case "details": {
      const done = await setMemberDetails(user.id, body.memberId, { birthDate: body.birthDate, gender: body.gender });
      return done.ok ? NextResponse.json({ team: done.value }) : refusal(done, done.status ?? 409);
    }
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
}
