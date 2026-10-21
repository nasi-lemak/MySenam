import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listMembershipsFor } from "@/lib/store";
import { startMembershipPayment, stopRenewal } from "@/lib/payments";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** The signed-in customer's memberships. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  return NextResponse.json({
    memberships: await listMembershipsFor(user.id),
  });
}

/**
 * `{ planId, autoRenew? }` → the page to pay the venue on; the membership is
 * made once it is paid, and with `autoRenew`, made again each period.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = rateLimit(req, "payment");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as { planId?: unknown; autoRenew?: unknown } | null;
  if (!body || !Number.isInteger(body.planId)) return NextResponse.json({ error: "planId is required." }, { status: 400 });
  const started = await startMembershipPayment(user, body.planId as number, { autoRenew: body.autoRenew === true });
  if (!started.ok)
    return NextResponse.json({ error: started.error, code: started.code, vars: started.vars }, { status: started.status });
  return NextResponse.json({ url: started.url, amount: started.amount });
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
