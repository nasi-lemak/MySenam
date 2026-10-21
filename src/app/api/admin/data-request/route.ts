import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { phoneKey } from "@/lib/phone";
import { exportPhoneData } from "@/lib/privacy";

export const dynamic = "force-dynamic";

/**
 * `?venueId&phone` → a file of everything the venue holds against that phone
 * number, for a person who asked for it in person (lib/privacy.ts). Managers
 * only, and written to the activity log, since it is a person's whole
 * history with the venue.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const params = req.nextUrl.searchParams;
  const venueId = Number(params.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const phone = (params.get("phone") ?? "").trim();
  const digits = phoneKey(phone);
  if (digits.length < 7) return NextResponse.json({ error: "Enter the phone number they gave." }, { status: 400 });

  const data = await exportPhoneData([venueId], phone);
  await logAction(admin, { venueId, action: "privacy.export", detail: `Data request for a number ending ${digits.slice(-4)}` });
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="data-request-${digits.slice(-4)}-${data.takenAt.slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
