import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireOwner } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { listPlayerReports, reviewPlayerReport } from "@/lib/player-safety";

export const dynamic = "force-dynamic";

/** The platform owner: reports about players, `?status=open|reviewed&before=<id>`. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;
  const q = req.nextUrl.searchParams;
  const status = q.get("status");
  const reports = await listPlayerReports({
    status: status === "open" || status === "reviewed" ? status : undefined,
    before: Number(q.get("before")) || undefined,
  });
  return NextResponse.json({ reports });
}

/** `{ id }`: a report looked at. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
  if (!body || !Number.isInteger(body.id)) return NextResponse.json({ error: "Which report?" }, { status: 400 });
  if (!(await reviewPlayerReport(body.id as number))) return NextResponse.json({ error: "Not found, or already reviewed." }, { status: 404 });
  await logAction(admin, { venueId: null, action: "player-report.reviewed", detail: `Report ${body.id}` });
  return NextResponse.json({ ok: true });
}
