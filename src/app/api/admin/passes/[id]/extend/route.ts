import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { refusal } from "@/lib/api";
import { extendPass } from "@/lib/pass-validity";
import { getPassById, listPassEntries } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * `{ expiresOn | days, reason }` → the pass runs until that day, or that many days longer (managers; lib/roles.ts). The reason is
 * required and kept in the pass's history and the activity log. A cancelled pass is never extended (ADR 0062).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const passId = Number((await params).id);
  if (!Number.isInteger(passId) || passId <= 0) return NextResponse.json({ error: "Invalid pass id." }, { status: 400 });
  const existing = await getPassById(passId);
  if (!existing) return NextResponse.json({ error: "Pass not found." }, { status: 404 });
  const denied = denyVenue(admin, existing.venueId);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { expiresOn?: unknown; days?: unknown; reason?: unknown } | null;
  const done = await extendPass(admin, passId, body ?? {});
  if (!done.ok) return refusal(done);
  await logAction(admin, {
    venueId: existing.venueId,
    action: "pass.extended",
    detail: `Pass ${existing.code}, valid until ${done.from} → ${done.to}. Reason: ${String(body?.reason ?? "").trim().slice(0, 200)}`,
  });
  return NextResponse.json({ pass: done.pass, entries: await listPassEntries(passId, 20) });
}
