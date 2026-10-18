import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { markTold, noticeById, openNotices, recentlyClosed } from "@/lib/urgent";

export const dynamic = "force-dynamic";

/** Urgent news not yet known to have reached the customer, and what closed this week. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json({ open: await openNotices(admin.venueIds), recent: await recentlyClosed(admin.venueIds) });
}

/** `{ id, action: "told" }` — staff told the customer another way. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let b: Record<string, unknown>;
  try {
    b = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const notice = Number.isInteger(b.id) ? await noticeById(b.id as number) : null;
  if (!notice) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const denied = denyVenue(admin, notice.venueId);
  if (denied) return denied;
  if (b.action !== "told") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (!(await markTold(notice.id, admin.id))) return NextResponse.json({ error: "That is already closed." }, { status: 409 });
  return NextResponse.json({ open: await openNotices(admin.venueIds), recent: await recentlyClosed(admin.venueIds) });
}
