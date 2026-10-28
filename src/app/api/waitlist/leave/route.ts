import { NextRequest, NextResponse } from "next/server";
import { refusal } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { declineWaitlistOffer, leaveWaitlistByToken, waitlistEntryByLeaveToken } from "@/lib/store";
import { tickOutbox } from "@/lib/notify";

export const dynamic = "force-dynamic";

/**
 * Leaving a waiting list without an account (audit R8 X2-9;
 * docs/features/booking.md#leaving-and-turning-an-offer-down).
 *
 * GET ?token=: what the entry behind a leave link waits for (the resource or
 * class, the venue, the day and time) and whether it is still on the list,
 * for the page that asks whether to leave. Nothing about who joined.
 *
 * POST { token }: leave by the entry's private link (given once, on the
 * joined screen and in the email saying so). POST { offerToken }: turn an
 * offer down by the offer's own link. Either way the entry leaves the list
 * and the place goes at once to the next person waiting, whose offer is
 * written to the outbox here.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (token.trim() === "") return NextResponse.json({ error: "token is required." }, { status: 400 });
  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;
  const entry = await waitlistEntryByLeaveToken(token);
  if (!entry) return NextResponse.json({ error: "Waitlist entry not found.", code: "WAITLIST_NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ entry: { ...entry, waiting: entry.status === "waiting" || entry.status === "offered" } });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { token, offerToken } = (body ?? {}) as Record<string, unknown>;
  const byLink = typeof token === "string" && token.trim() !== "";
  const byOffer = typeof offerToken === "string" && offerToken.trim() !== "";
  if (byLink === byOffer) return NextResponse.json({ error: "Give token or offerToken." }, { status: 400 });

  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;

  const result = byLink ? await leaveWaitlistByToken(token as string) : await declineWaitlistOffer(offerToken as string);
  if (!result.ok) return refusal(result);
  // The place may have gone to the next person waiting: their offer is told now, not at the next request.
  await tickOutbox();
  return NextResponse.json({ ok: true });
}
