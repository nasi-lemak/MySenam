import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { cancelUserBooking } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { bookingId } = (body ?? {}) as Record<string, unknown>;
  if (!Number.isInteger(bookingId))
    return NextResponse.json({ error: "bookingId is required." }, { status: 400 });

  const result = cancelUserBooking(user.id, bookingId as number);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ booking: result.booking });
}
