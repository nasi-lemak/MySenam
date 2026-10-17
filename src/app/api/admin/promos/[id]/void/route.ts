import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { promoById, voidPromoCode } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  const promoId = Number(id);
  if (!Number.isInteger(promoId) || promoId <= 0)
    return NextResponse.json({ error: "Invalid code id." }, { status: 400 });

  const existing = await promoById(promoId);
  if (!existing) return NextResponse.json({ error: "Code not found." }, { status: 404 });
  const denied = denyVenue(admin, existing.venueId);
  if (denied) return denied;

  const result = await voidPromoCode(promoId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ promo: result.promo });
}
