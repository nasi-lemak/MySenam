import { NextRequest, NextResponse } from "next/server";
import { isLocale, LOCALE_COOKIE, offeredLocales, type Locale } from "@/lib/i18n";
import { accountEmailRefusal } from "@/lib/account-email-gate";
import { rateLimit } from "@/lib/rate-limit";
import { EMAIL_SHAPE, requestRegistration } from "@/lib/registration";

export const dynamic = "force-dynamic";

/**
 * `{ email }` → always `202 { ok: true }`, whatever the address: a link to
 * finish signing up is emailed to an address no account holds, a notice with
 * how to sign in to one that has an account (lib/registration.ts). Nothing
 * else is taken before the address is proved; a name, phone or password sent
 * here (an older form) is ignored, not kept.
 */
const accepted = () => NextResponse.json({ ok: true }, { status: 202 });

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { email, website, locale } = (body ?? {}) as Record<string, unknown>;
  if (typeof email !== "string" || email.trim().length > 320 || !EMAIL_SHAPE.test(email.trim()))
    return NextResponse.json({ error: "Please provide a valid email address." }, { status: 400 });

  // A production marketplace whose email cannot deliver takes no request it could not answer by email (lib/account-email-gate.ts).
  const unavailable = accountEmailRefusal();
  if (unavailable) return unavailable;
  const limited = await rateLimit(req, "register");
  if (limited) return limited;
  // A field no person sees: a form that fills it in is a script. It is told what everybody is, and nothing is sent.
  if (typeof website === "string" && website !== "") return accepted();

  await requestRegistration(email, languageOf(req, locale));
  return accepted();
}

/** The language the page was in (it says), else the one chosen on the site, else the install's first. */
function languageOf(req: NextRequest, said: unknown): Locale {
  const offered = offeredLocales();
  const chosen = req.cookies.get(LOCALE_COOKIE)?.value;
  for (const candidate of [said, chosen]) if (typeof candidate === "string" && isLocale(candidate) && offered.includes(candidate)) return candidate;
  return offered[0] ?? "en";
}
