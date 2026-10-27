import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { cancelGuest, inviteGuest, myInviteVenues } from "@/lib/guest-invites";
import { phoneChecksOn } from "@/lib/phone-check";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * The venues this resident can invite guests to, and their guests there now;
 * `phoneChecks`: whether a guest can prove their number here, or needs their
 * entry linked to their account (by accepting an emailed invitation) to book online.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  return NextResponse.json({ venues: await myInviteVenues(user.id), phoneChecks: phoneChecksOn() });
}

/**
 * `{ venueId, phone, name, days, email? }`: put a guest on the venue's list;
 * `email` is sent an invitation to accept with the account that signs in with
 * it. The answer is the same whether or not any account holds the address.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "guestInvite");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Number.isInteger(body.venueId) || typeof body.phone !== "string")
    return NextResponse.json({ error: "venueId and phone are required." }, { status: 400 });
  const result = await inviteGuest(user.id, {
    venueId: body.venueId as number,
    phone: body.phone,
    name: typeof body.name === "string" ? body.name : null,
    days: Number(body.days),
    email: typeof body.email === "string" ? body.email : null,
  });
  if (!result.ok) return NextResponse.json(result, { status: 409 });
  return NextResponse.json({ guest: result.guest, venues: await myInviteVenues(user.id), phoneChecks: phoneChecksOn() }, { status: 201 });
}

/** `?id=`: take one's own guest off the list. */
export async function DELETE(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "id is required." }, { status: 400 });
  if (!(await cancelGuest(user.id, id))) return NextResponse.json({ error: "Guest not found." }, { status: 404 });
  return NextResponse.json({ venues: await myInviteVenues(user.id) });
}
