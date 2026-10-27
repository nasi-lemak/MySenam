import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { accountRequests } from "@/lib/guardian-requests";
import { addManaged, editManaged, endManaging, listManaged, ownParticipant, type ManagedRefusal } from "@/lib/managed-people";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * People the signed-in adult manages from their own account, a child most
 * often (lib/managed-people.ts; ADR 0022, ADR 0023): `?archived=1` includes
 * those no longer managed. Only those this account acts for, never anybody
 * else's; `own` is the participant this account is linked to as their own
 * login, if any. `requests` (lib/guardian-requests.ts): another adult's
 * requests waiting for this guardian's answer, this account's own still
 * pending (that one is pending, for whom, nothing more), its relationships
 * paused for a manager's review, and recent changes to who acts for the
 * people it manages, which it may report as a mistake.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const people = await listManaged(user.id, { archived: req.nextUrl.searchParams.get("archived") === "1" });
  const own = await ownParticipant(user.id);
  return NextResponse.json(
    { people, own: own ? { id: own.id, displayName: own.displayName } : null, requests: await accountRequests(user.id) },
    { headers: { "Cache-Control": "no-store" } }
  );
}

const refusal = (r: ManagedRefusal) => NextResponse.json({ error: r.error, code: r.code, ...(r.vars ? { vars: r.vars } : {}) }, { status: r.status });

/**
 * Add somebody: `{ displayName, birthYear?, relationship: "parent" |
 * "guardian" | "other", authority: true }`. Anything else (an email, a phone,
 * a photo, a school, an identity number) is refused, never stored.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "booking", "managed-people");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const made = await addManaged(user.id, body, user.name);
  if (!made.ok) return refusal(made);
  return NextResponse.json({ person: made.person }, { status: 201 });
}

/**
 * Change one: `{ id, displayName?, birthYear?, relationship?, authority?,
 * archived? }`. A changed relationship needs `authority: true` again (a
 * correction: the old declaration is kept, ended); `archived: true` stops
 * managing them for now (nothing is deleted), `false` brings them back.
 * `{ id, end: true, reason? }` ends this account's relationship for good:
 * nothing new from it for them; what it made stays.
 */
export async function PATCH(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "booking", "managed-people");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const { id, end, reason, ...fields } = body;
  if (end === true) {
    const ended = await endManaging(user.id, id, reason, user.name);
    if (!ended.ok) return refusal(ended);
    return NextResponse.json({ ok: true });
  }
  const done = await editManaged(user.id, id, fields, user.name);
  if (!done.ok) return refusal(done);
  return NextResponse.json({ person: done.person });
}
