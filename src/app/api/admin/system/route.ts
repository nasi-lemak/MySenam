import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireOwner } from "@/lib/admin-auth";
import { clearAlert, recentAlerts, schedulerAlive } from "@/lib/alerts";
import { schedulerEnabled } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

/** What has gone wrong lately, for the platform owner. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;
  return NextResponse.json({
    alerts: await recentAlerts(),
    scheduler: { enabled: schedulerEnabled(), alive: await schedulerAlive() },
    webhook: !!process.env.MYSENAM_ALERT_WEBHOOK,
  });
}

/** `{ key }`: dealt with; the next one is news again. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as { key?: unknown };
  if (typeof body.key !== "string") return NextResponse.json({ error: "key is required." }, { status: 400 });
  await clearAlert(body.key);
  return NextResponse.json({ alerts: await recentAlerts() });
}
