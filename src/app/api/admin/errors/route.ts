import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireOwner } from "@/lib/admin-auth";
import { listErrors, resolveError } from "@/lib/error-log";
import { jsonObject } from "@/lib/api";

export const dynamic = "force-dynamic";

/** `?resolved=1` for those marked fixed: errors by kind, latest first, for the platform owner. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;
  const resolved = req.nextUrl.searchParams.get("resolved") === "1";
  return NextResponse.json({ errors: await listErrors({ resolved }), sentry: !!process.env.SENTRY_DSN });
}

/** `{ id }`: fixed. It comes back on the list if it happens again. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;
  const body = (await jsonObject(req).catch(() => ({}))) as { id?: unknown };
  if (!Number.isInteger(body.id)) return NextResponse.json({ error: "id is required." }, { status: 400 });
  await resolveError(body.id as number);
  return NextResponse.json({ errors: await listErrors() });
}
