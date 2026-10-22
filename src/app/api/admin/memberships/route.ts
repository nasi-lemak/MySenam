import { NextRequest, NextResponse } from "next/server";
import { planById } from "@/lib/membership-plans";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { findAccountByEmail, listMembershipsForVenue, sellMembership } from "@/lib/store";
import { logAction } from "@/lib/activity";
import { money, region, isAmount } from "@/lib/region";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  return NextResponse.json({ memberships: await listMembershipsForVenue(venueId) });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;

  const venueId = input.venueId;
  if (!Number.isInteger(venueId) || (venueId as number) <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId as number);
  if (denied) return denied;

  for (const field of ["holderName", "holderPhone", "startsOn", "expiresOn"] as const) {
    if (typeof input[field] !== "string" || (input[field] as string).trim() === "")
      return NextResponse.json({ error: `A valid ${field} is required.` }, { status: 400 });
  }
  if (!isAmount(input.price))
    return NextResponse.json({ error: `Price must be ${money(0)} or more, to the ${region().currency.minor}.` }, { status: 400 });


  // Optionally tie the sale to an account, so it shows on that customer's own
  // page. Staff key it on an email the person just gave them, standing there —
  // a phone number would let whoever registered it first claim the pass.
  let userId: number | undefined;
  if (typeof input.accountEmail === "string" && input.accountEmail.trim() !== "") {
    const account = await findAccountByEmail(input.accountEmail);
    if (!account)
      return NextResponse.json(
        { error: "No account has that email address. Leave it blank to sell without one." },
        { status: 400 }
      );
    userId = account.id;
  }

  // On one of the venue's plans, for its benefits (a tier): any plan offered here.
  let tierId: number | undefined;
  if (input.tierId !== undefined && input.tierId !== null) {
    const plan = Number.isInteger(input.tierId) ? await planById(input.tierId as number) : null;
    if (!plan || plan.venueId !== venueId) return NextResponse.json({ error: "That plan is not offered here." }, { status: 400 });
    tierId = plan.id;
  }

  const result = await sellMembership({
    tierId,
    venueId: venueId as number,
    holderName: input.holderName as string,
    holderPhone: input.holderPhone as string,
    startsOn: input.startsOn as string,
    expiresOn: input.expiresOn as string,
    price: input.price as number,
    adminId: admin.id,
    userId,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  await logAction(admin, {
    venueId: venueId as number,
    action: "membership.sold",
    detail: `${input.holderName as string}, ${money(input.price as number)}, ${input.startsOn as string} to ${input.expiresOn as string}`,
  });
  return NextResponse.json({ membership: result.membership }, { status: 201 });
}
