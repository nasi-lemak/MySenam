import { NextRequest, NextResponse } from "next/server";
import { isOwner, requireAdmin } from "@/lib/admin-auth";
import { checkIntegrity } from "@/lib/integrity";

export const dynamic = "force-dynamic";

/**
 * Do the bookings and the court time they hold agree, now (lib/integrity.ts)?
 * The scheduler asks once a day and raises an alert; this is for asking again
 * after putting something right: the platform owner for every venue, a
 * manager for their own venues only (another venue's problems are never
 * looked for, let alone shown; nor a payment with no venue). Front desk is
 * refused (lib/roles.ts).
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  if (isOwner(admin)) {
    const problems = await checkIntegrity();
    return NextResponse.json({ ok: problems.length === 0, problems }, { headers: { "Cache-Control": "no-store" } });
  }
  const venues = admin.venueIds ?? [];
  const problems = (await checkIntegrity(venues)).filter((p) => venues.includes(p.venueId));
  return NextResponse.json({ ok: problems.length === 0, problems }, { headers: { "Cache-Control": "no-store" } });
}
