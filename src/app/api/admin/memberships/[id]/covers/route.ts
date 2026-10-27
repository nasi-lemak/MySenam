import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { membershipById } from "@/lib/store";
import { correctCover, coverHistory } from "@/lib/membership-purchases";
import { logAction } from "@/lib/activity";

export const dynamic = "force-dynamic";

async function membershipFor(req: NextRequest, params: Promise<{ id: string }>) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const membershipId = Number((await params).id);
  if (!Number.isInteger(membershipId) || membershipId <= 0) return NextResponse.json({ error: "Invalid membership id." }, { status: 400 });
  const existing = await membershipById(membershipId);
  if (!existing) return NextResponse.json({ error: "Membership not found." }, { status: 404 });
  const denied = denyVenue(admin, existing.venueId);
  if (denied) return denied;
  return { admin, existing };
}

/** Who the membership covered when (every change, with who made it and why), and its places this term where it is a family plan's. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await membershipFor(req, params);
  if (found instanceof NextResponse) return found;
  return NextResponse.json(await coverHistory(found.existing.id));
}

/**
 * `{ remove, add?, reason }` (managers): a person entered wrongly on the
 * membership comes off, and the right one goes on in their place, with the
 * reason; it uses none of the term's places (lib/membership-purchases.ts
 * `correctCover`). In the activity log and each person's history.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await membershipFor(req, params);
  if (found instanceof NextResponse) return found;
  const { admin, existing } = found;
  const body = (await req.json().catch(() => null)) as { remove?: unknown; add?: unknown; reason?: unknown } | null;
  const done = await correctCover({ id: admin.id, name: admin.name }, existing.id, body ?? {});
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code, vars: done.vars }, { status: done.status });
  await logAction(admin, {
    venueId: existing.venueId,
    action: "membership.cover_corrected",
    detail: `${existing.code}: ${done.removed.name} off${done.added ? `, ${done.added.name} on` : ""}. Reason: ${typeof body?.reason === "string" ? body.reason.trim().slice(0, 300) : ""}`,
  });
  return NextResponse.json({ membership: done.membership });
}
