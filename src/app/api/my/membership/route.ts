import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listMembershipsFor } from "@/lib/store";
import { startMembershipPayment } from "@/lib/payments";
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

/** `{ planId }` → the page to pay the venue on; the membership is made once it is paid. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = rateLimit(req, "payment");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as { planId?: unknown } | null;
  if (!body || !Number.isInteger(body.planId)) return NextResponse.json({ error: "planId is required." }, { status: 400 });
  const started = await startMembershipPayment(user, body.planId as number);
  if (!started.ok)
    return NextResponse.json({ error: started.error, code: started.code, vars: started.vars }, { status: started.status });
  return NextResponse.json({ url: started.url, amount: started.amount });
}
