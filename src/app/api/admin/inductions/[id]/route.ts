import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { inductionById, revokeInduction } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Withdraw someone's out-of-hours access, keeping the record that it existed. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  const inductionId = Number(id);
  if (!Number.isInteger(inductionId) || inductionId <= 0)
    return NextResponse.json({ error: "Invalid induction id." }, { status: 400 });

  const induction = inductionById(inductionId);
  if (!induction) return NextResponse.json({ error: "Induction not found." }, { status: 404 });
  const denied = denyVenue(admin, induction.venueId);
  if (denied) return denied;

  const result = revokeInduction(inductionId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ induction: result.induction });
}
