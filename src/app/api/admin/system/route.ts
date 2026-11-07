import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireOwner } from "@/lib/admin-auth";
import { clearAlert, recentAlerts, schedulerAlive } from "@/lib/alerts";
import { schedulerEnabled } from "@/lib/scheduler";
import { jsonObject } from "@/lib/api";
import { claimsArchiveStatus } from "@/lib/claims-archive";
import { checkProviderReachable } from "@/lib/email-config";
import { emailHealth } from "@/lib/email-health";

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
    // Moving past court time out of the live table: off (days 0), how far it has got, and whether it is keeping up.
    claimsArchive: await claimsArchiveStatus(),
    // Whether email is configured and verified, how the provider is doing, what waits, what was given up (security mail apart): lib/email-health.ts.
    email: await emailHealth(),
  });
}

/**
 * `{ key }`: dealt with; the next one is news again.
 * `{ check: "email" }`: ask the email provider whether it answers and accepts the credentials, without sending a message (the opt-in
 * "provider reachable" check, lib/email-config.ts). Reachable is not delivered: a person confirms the inbox.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;
  const body = (await jsonObject(req).catch(() => ({}))) as { key?: unknown; check?: unknown };
  if (body.check === "email") return NextResponse.json({ email: { ...(await emailHealth()), ...(await checkProviderReachable()) } });
  if (typeof body.key !== "string") return NextResponse.json({ error: "key is required." }, { status: 400 });
  await clearAlert(body.key);
  return NextResponse.json({ alerts: await recentAlerts() });
}
