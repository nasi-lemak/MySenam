import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { findAccountByEmail, listMembershipsForVenue, sellMembership } from "@/lib/store";
import { logAction } from "@/lib/activity";

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
  if (!Number.isInteger(input.price) || (input.price as number) < 0)
    return NextResponse.json({ error: "Price must be a whole number of ringgit." }, { status: 400 });


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

  const result = await sellMembership({
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
    detail: `${input.holderName as string}, RM${input.price as number}, ${input.startsOn as string} to ${input.expiresOn as string}`,
  });
  return NextResponse.json({ membership: result.membership }, { status: 201 });
}
