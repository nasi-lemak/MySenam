import { NextRequest, NextResponse } from "next/server";
import { denyVenue, isOwner, requireAdmin } from "@/lib/admin-auth";
import { deleteNotice, listNotices, noticeById } from "@/lib/notices";

export const dynamic = "force-dynamic";

/** Taken down: by the venue's staff, or the platform owner. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const notice = await noticeById(Number((await params).id));
  if (!notice) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (notice.venueId === null) {
    if (!isOwner(admin)) return NextResponse.json({ error: "Only the platform owner can do that." }, { status: 403 });
  } else {
    const denied = denyVenue(admin, notice.venueId);
    if (denied) return denied;
  }
  await deleteNotice(notice.id);
  return NextResponse.json({ notices: await listNotices(notice.venueId) });
}
