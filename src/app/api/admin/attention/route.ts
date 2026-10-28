import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { closeNoticeTask, guardianReviews, openNoticeTasks } from "@/lib/contact-guardians";
import { markTold, noticeById, openNotices, recentlyClosed } from "@/lib/urgent";
import { overdueRefunds } from "@/lib/payments";
import { jsonObject } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Urgent news not yet known to have reached the customer, what closed this week, and refunds past the date customers were told.
 * And guardians (lib/contact-guardians.ts): `guardianTasks`, guardians recorded by name and number to be told of a change in
 * person; `guardianReviews` (managers only), relationships waiting for a manager's review and exception review dates come.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json({
    open: await openNotices(admin.venueIds),
    recent: await recentlyClosed(admin.venueIds),
    refundsOverdue: await overdueRefunds(admin.venueIds),
    guardianTasks: await openNoticeTasks(admin.venueIds),
    guardianReviews: admin.role === "desk" ? [] : await guardianReviews(admin.venueIds),
  });
}

/**
 * `{ id, action: "told" }` — staff told the customer another way.
 * `{ taskId, action: "guardianTold", how: "told" | "not_needed" }` — staff told a guardian recorded by name and number of a change.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let b: Record<string, unknown>;
  try {
    b = (await jsonObject(req)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (b.action === "guardianTold") {
    const done = await closeNoticeTask(admin.venueIds, { id: admin.id, name: admin.name }, b.taskId, b.how);
    if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: done.status });
    await logAction(admin, { venueId: done.venueId, action: "participant.guardian_told", detail: `Guardian notice task ${String(b.taskId)}: ${String(b.how)}` });
    return NextResponse.json({ guardianTasks: await openNoticeTasks(admin.venueIds) });
  }
  const notice = Number.isInteger(b.id) ? await noticeById(b.id as number) : null;
  if (!notice) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const denied = denyVenue(admin, notice.venueId);
  if (denied) return denied;
  if (b.action !== "told") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (!(await markTold(notice.id, admin.id))) return NextResponse.json({ error: "That is already closed." }, { status: 409 });
  return NextResponse.json({ open: await openNotices(admin.venueIds), recent: await recentlyClosed(admin.venueIds) });
}
