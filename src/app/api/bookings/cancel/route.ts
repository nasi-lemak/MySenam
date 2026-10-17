import { NextRequest, NextResponse } from "next/server";
import { refusal } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { cancelBooking } from "@/lib/store";
import { currentLocale } from "@/lib/locale";
import { notifyBookingCancelled, tickOutbox } from "@/lib/notify";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { code, phone } = (body ?? {}) as Record<string, unknown>;
  if (typeof code !== "string" || typeof phone !== "string")
    return NextResponse.json({ error: "code and phone are required." }, { status: 400 });

  const limited = rateLimit(req, "bookingLookup");
  if (limited) return limited;

  const result = await cancelBooking(code, phone);
  if (!result.ok) return refusal(result);

  await notifyBookingCancelled(result.booking, await currentLocale());
  // A cancellation is what frees a place, so it is also what makes an
  // offer worth telling somebody about.
  await tickOutbox();
  return NextResponse.json({ booking: result.booking });
}
