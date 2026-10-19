import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { createPromoCode, listPromoCodes } from "@/lib/store";
import { MAX_HOURS_PER_BOOKING, PromoKind, Sport, SPORTS } from "@/lib/types";
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

  return NextResponse.json({ promos: await listPromoCodes(venueId) });
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

  for (const field of ["code", "description", "validFrom", "validTo"] as const) {
    if (typeof input[field] !== "string" || (input[field] as string).trim() === "")
      return NextResponse.json({ error: `A valid ${field} is required.` }, { status: 400 });
  }
  if (input.kind !== "percent" && input.kind !== "amount")
    return NextResponse.json({ error: "kind must be percent or amount." }, { status: 400 });
  if (!Number.isInteger(input.value) || (input.value as number) < 1)
    return NextResponse.json({ error: "A discount above zero is required." }, { status: 400 });
  if (input.minHours !== undefined && input.minHours !== null &&
      (!Number.isInteger(input.minHours) || (input.minHours as number) < 1 ||
       (input.minHours as number) > MAX_HOURS_PER_BOOKING))
    return NextResponse.json(
      { error: `minHours must be 1–${MAX_HOURS_PER_BOOKING}.` },
      { status: 400 }
    );

  let sport: Sport | null = null;
  if (input.sport !== undefined && input.sport !== null && input.sport !== "") {
    if (!SPORTS.includes(input.sport as Sport))
      return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
    sport = input.sport as Sport;
  }

  const result = await createPromoCode({
    venueId: venueId as number,
    code: input.code as string,
    description: input.description as string,
    kind: input.kind as PromoKind,
    value: input.value as number,
    sport,
    minHours: (input.minHours as number) ?? 1,
    validFrom: input.validFrom as string,
    validTo: input.validTo as string,
    maxUses: Number.isInteger(input.maxUses) ? (input.maxUses as number) : null,
    adminId: admin.id,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  await logAction(admin, { venueId: result.promo.venueId, action: "promo.created", detail: result.promo.code });
  return NextResponse.json({ promo: result.promo }, { status: 201 });
}
