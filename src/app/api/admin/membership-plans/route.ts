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

/** `{ venueId, name, months, price, ratePercent?, aheadDays? }`: offer a new plan, a tier with its own benefits where given. */
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
  });
  if (!made.ok) return NextResponse.json({ error: made.error }, { status: 400 });
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

/** `{ venueId, id, ratePercent, aheadDays }`: a plan's benefits, each null for the venue's. Memberships on it get them from now. */
export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const venueId = body?.venueId;
  if (!body || !Number.isInteger(venueId) || !Number.isInteger(body.id))
    return NextResponse.json({ error: "venueId and id are required." }, { status: 400 });
  const denied = denyVenue(admin, venueId as number);
  if (denied) return denied;
  const set = await setPlanBenefits(venueId as number, body.id as number, { ratePercent: body.ratePercent, aheadDays: body.aheadDays });
  if (!set.ok) return NextResponse.json({ error: set.error }, { status: 400 });
  await logAction(admin, {
    venueId: venueId as number,
    action: "membership.plan_added",
    detail: `${set.plan.name}: ${set.plan.ratePercent ?? "member rates"}${set.plan.ratePercent ? "% of the price" : ""}, ${set.plan.aheadDays ?? "the venue's"} days ahead`,
  });
  return NextResponse.json({ plan: set.plan });
}
