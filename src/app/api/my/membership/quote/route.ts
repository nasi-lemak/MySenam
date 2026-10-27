import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { purchaseTerms, readPurchaseRequest } from "@/lib/membership-purchases";

export const dynamic = "force-dynamic";

/**
 * `{ planId, participantId?, covers? }` → what paying now would buy, before
 * any page is opened: the price, whom it is for, and the dates it would run
 * (from today, or on from a membership already held). Or why it cannot be
 * bought (lib/membership-purchases.ts). The dates are worked out again when
 * the money comes in.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const request = readPurchaseRequest((await req.json().catch(() => null)) as Record<string, unknown> | null);
  if ("ok" in request) return NextResponse.json({ error: request.error, code: request.code, vars: request.vars }, { status: request.status });
  const quoted = await purchaseTerms(user.id, request);
  if (!quoted.ok) return NextResponse.json({ error: quoted.error, code: quoted.code, vars: quoted.vars }, { status: quoted.status });
  const { plan, startsOn, expiresOn, renewing, holder, covers, price } = quoted.terms;
  return NextResponse.json({
    planId: plan.id,
    planName: plan.name,
    price,
    startsOn,
    expiresOn,
    renewing,
    holder,
    covers,
  });
}
