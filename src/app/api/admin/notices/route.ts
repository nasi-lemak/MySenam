import { NextRequest, NextResponse } from "next/server";
import { denyVenue, isOwner, requireAdmin } from "@/lib/admin-auth";
import { createNotice, listNotices } from "@/lib/notices";
import { jsonObject } from "@/lib/api";

export const dynamic = "force-dynamic";

/** `?venueId=` — a venue's notices; `?venueId=site` — the site-wide one, for the platform owner. */
async function whose(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  if (raw === "site" || raw === null) {
    if (!isOwner(admin)) return NextResponse.json({ error: "Only the platform owner puts up a site-wide notice." }, { status: 403 });
    return { admin, venueId: null };
  }
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return { admin, venueId };
}

export async function GET(req: NextRequest) {
  const found = await whose(req, req.nextUrl.searchParams.get("venueId") ?? "site");
  if (found instanceof NextResponse) return found;
  return NextResponse.json({ notices: await listNotices(found.venueId) });
}

/** `{ venueId | "site", text, link?, startsOn, endsOn }` */
export async function POST(req: NextRequest) {
  let b: Record<string, unknown>;
  try {
    b = (await jsonObject(req)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const found = await whose(req, b.venueId ?? "site");
  if (found instanceof NextResponse) return found;
  const made = await createNotice(
    {
      venueId: found.venueId,
      text: String(b.text ?? ""),
      link: typeof b.link === "string" ? b.link : null,
      startsOn: String(b.startsOn ?? ""),
      endsOn: String(b.endsOn ?? ""),
    },
    found.admin.id
  );
  if (!made.ok) return NextResponse.json({ error: made.error }, { status: 400 });
  return NextResponse.json({ notice: made.value, notices: await listNotices(found.venueId) }, { status: 201 });
}
