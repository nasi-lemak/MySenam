import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { resetTwoFactorFor } from "@/lib/two-factor-reset";
import { jsonObject } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * `{ reason, code }`: reset this member of staff's two-factor sign-in, when
 * they have lost both their authenticator and their recovery codes. `code` is
 * the caller's own current code; `reason` says how they knew it was really
 * that person (lib/two-factor-reset.ts).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const targetId = Number((await params).id);
  if (!Number.isInteger(targetId) || targetId <= 0) return NextResponse.json({ error: "Invalid admin id." }, { status: 400 });
  let body: Record<string, unknown>;
  try {
    body = (await jsonObject(req)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const done = await resetTwoFactorFor(admin, targetId, { reason: body.reason, code: body.code });
  if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
  return NextResponse.json({ ok: true });
}
