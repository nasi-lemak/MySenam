import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isLocale, LOCALE_COOKIE, type Locale } from "@/lib/i18n";
import { confirmPhoneCode, phoneStatus, savePhone, sendPhoneCode, startWhatsappCheck } from "@/lib/phone-check";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** The account's number, and whether it is checked. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  return NextResponse.json(await phoneStatus(user.id));
}

/**
 * `{ action: "whatsapp", phone }` starts a check by a message the customer
 * sends us from that number on WhatsApp, and returns the link that opens it;
 * `{ action: "send", phone }` sends a code to it by SMS (or WhatsApp);
 * `{ action: "confirm", code }` checks it; `{ action: "save", phone }` keeps
 * it as given, where this install does not check numbers.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const phone = typeof body.phone === "string" ? body.phone : "";
  if (body.action === "send") {
    const limited = await rateLimit(req, "phoneCode");
    if (limited) return limited;
    const sent = await sendPhoneCode(user.id, phone, isLocale(req.cookies.get(LOCALE_COOKIE)?.value) ? (req.cookies.get(LOCALE_COOKIE)!.value as Locale) : "en");
    if (!sent.ok) return NextResponse.json(sent, { status: 400 });
    return NextResponse.json({ ...sent, status: await phoneStatus(user.id) });
  }
  if (body.action === "whatsapp") {
    const limited = await rateLimit(req, "phoneCode");
    if (limited) return limited;
    const locale = req.cookies.get(LOCALE_COOKIE)?.value;
    const started = await startWhatsappCheck(user.id, phone, isLocale(locale) ? locale : "en");
    if (!started.ok) return NextResponse.json(started, { status: 400 });
    return NextResponse.json({ ...started, status: await phoneStatus(user.id) });
  }
  if (body.action === "confirm") {
    const limited = await rateLimit(req, "phoneCode");
    if (limited) return limited;
    const checked = await confirmPhoneCode(user.id, typeof body.code === "string" ? body.code : "");
    if (!checked.ok) return NextResponse.json(checked, { status: 400 });
    return NextResponse.json({ ok: true, status: await phoneStatus(user.id) });
  }
  if (body.action === "save") {
    const saved = await savePhone(user.id, phone);
    if (!saved.ok) return NextResponse.json(saved, { status: 400 });
    return NextResponse.json({ ok: true, status: await phoneStatus(user.id) });
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
