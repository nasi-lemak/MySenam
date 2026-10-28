import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logFromRequest } from "@/lib/activity";
import { feedLocale, feedStatus, feedUrl, setFeed } from "@/lib/staff-calendar";
import { LOCALE_COOKIE } from "@/lib/i18n";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

/** The staff language this request is read in (the language switch's cookie), for the feed's address to name. */
const staffLanguageOf = (req: NextRequest) => feedLocale(req.cookies.get(LOCALE_COOKIE)?.value);

/**
 * `?venueId` → whether the feed is on, since and until when (`on`, `madeAt`,
 * `expiresAt`, `lapsed`). The address is kept only as a hash, so it is never
 * shown again: `url` is always null here.
 */
export async function GET(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  return NextResponse.json({ url: null, ...(await feedStatus(venueId)) });
}

/**
 * `{ venueId, on }`: on makes a fresh address, shown this once in `url`, that
 * works for `FEED_DAYS` (the old one stops working); off withdraws it. Logged
 * either way.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { venueId?: unknown; on?: unknown } | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = await venueOf(req, body.venueId);
  if (venueId instanceof NextResponse) return venueId;
  const made = await setFeed(venueId, body.on === true);
  await logFromRequest(req, { venueId, action: "settings.changed", detail: made ? "Calendar feed: new address" : "Calendar feed: off" });
  if (!made) return NextResponse.json({ url: null, ...(await feedStatus(venueId)) });
  return NextResponse.json({ url: await feedUrl(venueId, made.token, staffLanguageOf(req)), ...made.status });
}
