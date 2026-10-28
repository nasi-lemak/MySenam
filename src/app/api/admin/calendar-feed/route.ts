import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin, type Admin } from "@/lib/admin-auth";
import { logFromRequest } from "@/lib/activity";
import { feedLocale, feedToken, feedUrl, setFeed } from "@/lib/staff-calendar";
import { LOCALE_COOKIE } from "@/lib/i18n";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? { admin, venueId };
}

/**
 * The language the feed's address names: the staff member's own, where they
 * chose one (lib/admin-auth.ts `locale`), else the one this request is read in
 * (the language switch's cookie).
 */
const staffLanguageOf = (req: NextRequest, admin: Admin) => admin.locale ?? feedLocale(req.cookies.get(LOCALE_COOKIE)?.value);

/** `?venueId` → the address staff subscribe to, or null when the feed is off. */
export async function GET(req: NextRequest) {
  const v = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (v instanceof NextResponse) return v;
  const token = await feedToken(v.venueId);
  return NextResponse.json({ url: token ? await feedUrl(v.venueId, token, staffLanguageOf(req, v.admin)) : null });
}

/** `{ venueId, on }`: on gives a fresh address (the old one stops working); off withdraws it. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { venueId?: unknown; on?: unknown } | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const v = await venueOf(req, body.venueId);
  if (v instanceof NextResponse) return v;
  const token = await setFeed(v.venueId, body.on === true);
  await logFromRequest(req, { venueId: v.venueId, action: "settings.changed", detail: token ? "Calendar feed: new address" : "Calendar feed: off" });
  return NextResponse.json({ url: token ? await feedUrl(v.venueId, token, staffLanguageOf(req, v.admin)) : null });
}
