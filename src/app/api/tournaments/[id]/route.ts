import { NextRequest, NextResponse } from "next/server";
import { phoneRefusal } from "@/lib/phone-check";
import { refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { mayShowVenue } from "@/lib/listing";
import { startEntryPayment } from "@/lib/payments";
import { rateLimit } from "@/lib/rate-limit";
import { enter, myEntry, tournamentById, tournamentDetail, withdraw } from "@/lib/tournaments";

export const dynamic = "force-dynamic";

async function visible(req: NextRequest, id: number) {
  const t = await tournamentById(id);
  if (!t || t.status === "cancelled") return null;
  return (await mayShowVenue(t.venueId, req)).show ? t : null;
}

/** The draw, the groups, the bracket and the times; and, signed in, your entry. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const t = await visible(req, Number((await params).id));
  if (!t) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const user = await getSessionUser(req);
  return NextResponse.json({
    tournament: await tournamentDetail(t.id),
    mine: user ? await myEntry(user.id, t.id) : null,
    signedIn: user !== null,
  });
}

/** `{ action: "enter", partnerName? }`, `{ action: "withdraw" }` (before the draw), or `{ action: "pay" }`. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in to enter." }, { status: 401 });
  const t = await visible(req, Number((await params).id));
  if (!t) return NextResponse.json({ error: "Not found." }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (body.action === "pay") {
    const limited = rateLimit(req, "payment");
    if (limited) return limited;
    const paying = await startEntryPayment(user, t.id);
    if (!paying.ok) return NextResponse.json({ error: paying.error }, { status: paying.status });
    return NextResponse.json({ url: paying.url });
  }
  if (body.action === "enter") {
    const limited = rateLimit(req, "booking");
    if (limited) return limited;
    const noPhone = await phoneRefusal(user.id);
    if (noPhone) return refusal(noPhone, 403);
    const result = await enter(user, t.id, { partnerName: typeof body.partnerName === "string" ? body.partnerName : undefined });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
    return NextResponse.json({ mine: result.value }, { status: 201 });
  }
  if (body.action === "withdraw") {
    const mine = await myEntry(user.id, t.id);
    if (!mine) return NextResponse.json({ error: "You have not entered." }, { status: 404 });
    if (t.status === "drawn") return NextResponse.json({ error: "The draw is made: ask the venue to withdraw you." }, { status: 409 });
    const result = await withdraw(mine.id);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
    return NextResponse.json({ mine: null });
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
