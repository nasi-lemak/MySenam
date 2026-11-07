import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { createPlan, listPlans, retirePlan, setPlanBenefits } from "@/lib/membership-plans";
import { takesPaymentOnline } from "@/lib/payments";
import { logAction } from "@/lib/activity";
import { money } from "@/lib/region";

export const dynamic = "force-dynamic";

function venueParam(req: NextRequest): number | null {
  const id = Number(req.nextUrl.searchParams.get("venueId"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The plans a venue sells online, and whether it can take the money yet. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = venueParam(req);
  if (!venueId) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ plans: await listPlans(venueId), online: await takesPaymentOnline(venueId) });
}

/**
 * `{ venueId, name, months, price, ratePercent?, aheadDays?, scope?, offeredFor?, familyLimit?, coverSwaps?, extendOnSuspension?,
 * confirmAboveMemberRate? }`: offer a new plan (a `ratePercent` above a court's member rate is asked to be confirmed, as for PATCH),
 * a tier with its own benefits where given. `scope`: the member's price for the whole booking (`booking`, the
 * default) or for the members' own places only (`participant`; lib/entitlements.ts). `offeredFor`: whom customers
 * buy it for online (`account`, the default; `participant`, `individual`, or `family` with its `familyLimit`;
 * lib/membership-purchases.ts).
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const venueId = body?.venueId;
  if (!body || !Number.isInteger(venueId) || (venueId as number) <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId as number);
  if (denied) return denied;
  const made = await createPlan(venueId as number, {
    name: body.name,
    months: body.months,
    price: body.price,
    ratePercent: body.ratePercent,
    aheadDays: body.aheadDays,
    scope: body.scope,
    offeredFor: body.offeredFor,
    familyLimit: body.familyLimit,
    coverSwaps: body.coverSwaps,
    extendOnSuspension: body.extendOnSuspension,
    admitsEntry: body.admitsEntry,
    admitsEntrySport: body.admitsEntrySport,
    confirmAboveMemberRate: body.confirmAboveMemberRate,
  });
  if (!made.ok) return NextResponse.json({ error: made.error, ...(made.needsConfirm ? { needsConfirm: made.needsConfirm } : {}) }, { status: made.needsConfirm ? 409 : 400 });
  await logAction(admin, {
    venueId: venueId as number,
    action: "membership.plan_added",
    detail: `${made.plan.name}: ${made.plan.months} months, ${money(made.plan.price)}`,
  });
  return NextResponse.json({ plan: made.plan }, { status: 201 });
}

/** `?venueId=&id=`: stop offering a plan. Memberships bought on it run their course. */
export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = venueParam(req);
  const planId = Number(req.nextUrl.searchParams.get("id"));
  if (!venueId || !Number.isInteger(planId) || planId <= 0)
    return NextResponse.json({ error: "venueId and id are required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  if (!(await retirePlan(venueId, planId))) return NextResponse.json({ error: "Plan not found." }, { status: 404 });
  await logAction(admin, { venueId, action: "membership.plan_retired", detail: `Plan ${planId}` });
  return NextResponse.json({ ok: true });
}

/**
 * `{ venueId, id, ratePercent, aheadDays, scope?, offeredFor?, familyLimit?, coverSwaps?, extendOnSuspension?, admitsEntry?,
 * admitsEntrySport?, confirmAboveMemberRate? }`: a plan's benefits, each
 * null for the venue's; `scope` left out keeps what the price covers, `offeredFor` whom it is sold to online,
 * `extendOnSuspension` whether a suspension moves its memberships' end (off unless set; lib/membership-suspensions.ts).
 * The benefits are those of memberships sold from now on (a renewal included): a term already sold keeps the benefits it was
 * sold with, and the plan's `version` goes up (ADR 0071). A `ratePercent` that comes to more than a court's member rate is
 * answered 409 with `needsConfirm: "above-member-rate"` and nothing saved, until it is sent again with
 * `confirmAboveMemberRate: true`.
 */
export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const venueId = body?.venueId;
  if (!body || !Number.isInteger(venueId) || !Number.isInteger(body.id))
    return NextResponse.json({ error: "venueId and id are required." }, { status: 400 });
  const denied = denyVenue(admin, venueId as number);
  if (denied) return denied;
  const set = await setPlanBenefits(venueId as number, body.id as number, {
    ratePercent: body.ratePercent,
    aheadDays: body.aheadDays,
    scope: body.scope,
    offeredFor: body.offeredFor,
    familyLimit: body.familyLimit,
    coverSwaps: body.coverSwaps,
    extendOnSuspension: body.extendOnSuspension,
    admitsEntry: body.admitsEntry,
    admitsEntrySport: body.admitsEntrySport,
    confirmAboveMemberRate: body.confirmAboveMemberRate,
  });
  if (!set.ok) return NextResponse.json({ error: set.error, ...(set.needsConfirm ? { needsConfirm: set.needsConfirm } : {}) }, { status: set.needsConfirm ? 409 : 400 });
  await logAction(admin, {
    venueId: venueId as number,
    action: "membership.plan_added",
    detail: `${set.plan.name} (version ${set.plan.version}, for terms sold from now on): ${set.plan.ratePercent ?? "member rates"}${set.plan.ratePercent ? "% of the price" : ""}, ${set.plan.aheadDays ?? "the venue's"} days ahead${
      set.plan.scope === "participant" ? ", members' own places only" : ""
    }, sold online for ${
      set.plan.offeredFor === "family"
        ? `a family of up to ${set.plan.familyLimit} besides the holder, ${set.plan.coverSwaps} put on in place of others per term`
        : set.plan.offeredFor
    }${set.plan.extendOnSuspension ? ", its end extended by the time suspended" : ""}${
      set.plan.admitsEntry ? `, members let in with no booking${set.plan.admitsEntrySport ? ` (${set.plan.admitsEntrySport} only)` : ""}` : ""
    }`,
  });
  return NextResponse.json({ plan: set.plan });
}
