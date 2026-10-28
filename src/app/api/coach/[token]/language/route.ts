import { NextRequest, NextResponse } from "next/server";
import { coachForToken, logCoachChange, setCoachLocale } from "@/lib/coach-schedule";
import { rateLimit } from "@/lib/rate-limit";
import { jsonObject } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * `{ locale }`: a coach chooses their own language at the private link the
 * venue gave them (lib/coach-schedule.ts `setCoachLocale`): any language the
 * install offers, or null for none chosen. Their page, its calendar and their
 * lesson emails are then written in it.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const limited = await rateLimit(req, "login", "coach-self");
  if (limited) return limited;
  const found = await coachForToken((await params).token);
  if (!found || !found.coach.active) return NextResponse.json({ error: "This link is no longer in use." }, { status: 404 });
  const body = await jsonObject(req).catch(() => null);
  if (!body || !("locale" in body)) return NextResponse.json({ error: "locale is required." }, { status: 400 });
  const set = await setCoachLocale(found.coach.id, null, body.locale);
  if (!set.ok) return NextResponse.json(set, { status: 400 });
  await logCoachChange(found, `language ${set.locale ?? "none chosen"}`);
  return NextResponse.json({ locale: set.locale });
}
