import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { CALENDAR_LINK_DAYS, makeCalendarLink, revokeCalendarLink } from "@/lib/rosters";
import { venueBaseUrl } from "@/lib/storefront";

export const dynamic = "force-dynamic";

/**
 * A member of staff makes the link to their own shifts as a calendar (lib/rosters.ts): shown this once, since only its hash is
 * kept; a new one stops the old. Only for the account asking, and only its own shifts: a manager makes no link for somebody else.
 * Staff at one venue only (an owner or business manager has no shifts to roster).
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  if (admin.venueId === null) return NextResponse.json({ error: "Only staff of one venue have shifts on its roster." }, { status: 409 });
  const link = await makeCalendarLink(admin.id, await venueBaseUrl(admin.venueId));
  await logAction(admin, { venueId: admin.venueId, action: "roster.calendar_link", detail: `${admin.name} made a link to their own shifts, good for ${CALENDAR_LINK_DAYS} days` });
  return NextResponse.json({ url: link.url, until: link.until }, { headers: { "Cache-Control": "no-store" } });
}

/** The account's own link stops working. */
export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  await revokeCalendarLink(admin.id);
  await logAction(admin, { venueId: admin.venueId, action: "roster.calendar_link", detail: `${admin.name} stopped the link to their own shifts` });
  return NextResponse.json({ ok: true });
}
