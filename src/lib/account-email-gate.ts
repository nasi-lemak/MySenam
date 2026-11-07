import { NextResponse } from "next/server";
import { accountEmailBlocked } from "./email-config";
import { errorText, translator } from "./i18n";

/**
 * The refusal a public account-email request gets when the install's email cannot deliver (ADR 0073): a sign-up request or a
 * forgotten-password request on a production marketplace with no working email set up (lib/email-config.ts).
 *
 * It is the same for every address and says nothing about accounts, so it is no way to find out who has one. It is not a fake
 * "check your email": nothing was written down, and nobody is promised a message that cannot come. A visitor is told to contact
 * the venue they booked with; the owners are told why by the start-up log and an alert (lib/email-health.ts). Null: go on.
 */
export function accountEmailRefusal(): NextResponse | null {
  if (!accountEmailBlocked()) return null;
  return NextResponse.json(
    { error: errorText(translator("en"), "EMAIL_UNAVAILABLE"), code: "EMAIL_UNAVAILABLE" },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "3600" } }
  );
}
