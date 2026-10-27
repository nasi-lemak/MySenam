import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listMembershipsFor } from "@/lib/store";
import { startMembershipPayment, stopRenewal } from "@/lib/payments";
import { changeCovers, pendingPurchasesFor, readPurchaseRequest } from "@/lib/membership-purchases";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** The signed-in customer's memberships, and purchases still waiting on their payment. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  return NextResponse.json({
    memberships: await listMembershipsFor(user.id),
    pending: await pendingPurchasesFor(user.id),
  });
}

/**
 * `{ planId, participantId?, covers?, autoRenew? }` → the page to pay the
 * venue on: for the customer, for somebody they look after
 * (`participantId`), or a family membership covering `covers` besides them
 * (lib/membership-purchases.ts). The membership is made once it is paid, and
 * with `autoRenew`, made again each period.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "payment");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const request = readPurchaseRequest(body);
  if ("ok" in request) return NextResponse.json({ error: request.error, code: request.code, vars: request.vars }, { status: request.status });
  const started = await startMembershipPayment(user, request.planId, {
    autoRenew: body?.autoRenew === true,
    participantId: request.participantId,
    covers: request.covers,
  });
  if (!started.ok)
    return NextResponse.json({ error: started.error, code: started.code, vars: started.vars }, { status: started.status });
  return NextResponse.json({ url: started.url, amount: started.amount, reused: started.reused });
}

/**
 * `{ membershipId, covers }`: whom a family membership bought online covers
 * besides the customer, from now: added within its plan's limit, or removed.
 * The price stays as it was sold.
 */
export async function PATCH(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { membershipId?: unknown; covers?: unknown } | null;
  if (!body || !Number.isInteger(body.membershipId)) return NextResponse.json({ error: "membershipId is required." }, { status: 400 });
  const changed = await changeCovers(user.id, body.membershipId as number, body.covers);
  if (!changed.ok) return NextResponse.json({ error: changed.error, code: changed.code, vars: changed.vars }, { status: changed.status });
  return NextResponse.json({ membership: changed.membership });
}

/** `?renewal=<id>` → stop renewing: the membership runs to its end, and nothing more is charged. */
export async function DELETE(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const id = Number(req.nextUrl.searchParams.get("renewal"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "renewal is required." }, { status: 400 });
  const stopped = await stopRenewal(user.id, id);
  if (!stopped.ok) return NextResponse.json(stopped, { status: 409 });
  return NextResponse.json({ ok: true });
}
