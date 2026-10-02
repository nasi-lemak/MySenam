import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { findAccountByEmail, issuePass, listPassesForVenue } from "@/lib/store";
import { MAX_PASS_ENTRIES, Sport, SPORTS } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Passes issued by one venue. */
export function GET(req: NextRequest) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  return NextResponse.json({ passes: listPassesForVenue(venueId) });
}

export async function POST(req: NextRequest) {
  const admin = requireAdmin(req);
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

  for (const field of ["name", "holderName", "holderPhone", "expiresOn"] as const) {
    if (typeof input[field] !== "string" || (input[field] as string).trim() === "")
      return NextResponse.json({ error: `A valid ${field} is required.` }, { status: 400 });
  }
  if (!Number.isInteger(input.entries) || (input.entries as number) < 1 || (input.entries as number) > MAX_PASS_ENTRIES)
    return NextResponse.json({ error: `Entries must be 1–${MAX_PASS_ENTRIES}.` }, { status: 400 });
  if (!Number.isInteger(input.price) || (input.price as number) < 0)
    return NextResponse.json({ error: "Price must be a whole number of ringgit." }, { status: 400 });

  let sport: Sport | null = null;
  if (input.sport !== undefined && input.sport !== null && input.sport !== "") {
    if (!SPORTS.includes(input.sport as Sport))
      return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
    sport = input.sport as Sport;
  }


  // Optionally tie the sale to an account, so it shows on that customer's own
  // page. Staff key it on an email the person just gave them, standing there —
  // a phone number would let whoever registered it first claim the pass.
  let userId: number | undefined;
  if (typeof input.accountEmail === "string" && input.accountEmail.trim() !== "") {
    const account = findAccountByEmail(input.accountEmail);
    if (!account)
      return NextResponse.json(
        { error: "No account has that email address. Leave it blank to sell without one." },
        { status: 400 }
      );
    userId = account.id;
  }

  const result = issuePass({
    venueId: venueId as number,
    sport,
    name: input.name as string,
    entries: input.entries as number,
    price: input.price as number,
    holderName: input.holderName as string,
    holderPhone: input.holderPhone as string,
    expiresOn: input.expiresOn as string,
    adminId: admin.id,
    userId,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ pass: result.pass }, { status: 201 });
}
