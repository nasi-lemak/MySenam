import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, setAdminLocale } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

/**
 * `{ locale }`: the signed-in member of staff's own language (`en`, `ms` or
 * `zh`, where the install offers it; null for none chosen), which the
 * dashboard's language switch saves as well as setting the browser's cookie.
 * The dashboard opens in it on any device they sign in on, and what MySenam
 * sends them is written in it (lib/staff-locales.ts `staffReaderLocale`).
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as { locale?: unknown } | null;
  if (!body || !("locale" in body)) return NextResponse.json({ error: "locale is required." }, { status: 400 });
  const set = await setAdminLocale(admin.id, body.locale);
  if (!set.ok) return NextResponse.json(set, { status: 400 });
  return NextResponse.json({ locale: set.locale });
}
