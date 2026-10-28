import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin, type Admin } from "@/lib/admin-auth";
import { logFromRequest } from "@/lib/activity";
import { feedLocale, feedStatus, feedToken, feedUrl, setFeed } from "@/lib/staff-calendar";
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

/**
 * `?venueId` → whether the feed is on, since and until when (`on`, `madeAt`,
 * `expiresAt`, `lapsed`), and the address to subscribe to (`url`): null when
 * off or lapsed, or when no copy of it can be unsealed (lib/staff-calendar.ts
 * `feedToken`), when a manager makes a new one.
 */
export async function GET(req: NextRequest) {
  const v = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (v instanceof NextResponse) return v;
  const token = await feedToken(v.venueId);
  return NextResponse.json({ url: token ? await feedUrl(v.venueId, token, staffLanguageOf(req, v.admin)) : null, ...(await feedStatus(v.venueId)) });
}

/**
 * `{ venueId, on }`: on makes a fresh address that works for `FEED_DAYS`
 * (the old one stops working); off withdraws it. Logged either way.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { venueId?: unknown; on?: unknown } | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const v = await venueOf(req, body.venueId);
  if (v instanceof NextResponse) return v;
  const made = await setFeed(v.venueId, body.on === true);
  await logFromRequest(req, { venueId: v.venueId, action: "settings.changed", detail: made ? "Calendar feed: new address" : "Calendar feed: off" });
  if (!made) return NextResponse.json({ url: null, ...(await feedStatus(v.venueId)) });
  return NextResponse.json({ url: await feedUrl(v.venueId, made.token, staffLanguageOf(req, v.admin)), ...made.status });
}
