import { NextRequest, NextResponse } from "next/server";
import { cancelBooking } from "@/lib/store";

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

  const result = cancelBooking(code, phone);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ booking: result.booking });
}
