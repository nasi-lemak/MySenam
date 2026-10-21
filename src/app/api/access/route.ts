import { NextRequest, NextResponse } from "next/server";
import { accessCodeFor } from "@/lib/store";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Let a customer into an unmanned resource.
 *
 * POST rather than GET: this is not a read. It writes a reveal to the log and
 * checks the customer in, and it should never land in a browser history, a
 * proxy log or a shared link.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { code, phone } = (body ?? {}) as Record<string, unknown>;
  if (typeof code !== "string" || code.trim() === "" || typeof phone !== "string" || phone.trim() === "")
    return NextResponse.json({ error: "code and phone are required." }, { status: 400 });

  const limited = await rateLimit(req, "accessCode");
  if (limited) return limited;

  const result = await accessCodeFor(code, phone);
  if (result === null)
    return NextResponse.json(
      { error: "Booking not found. Check the code and phone number." },
      { status: 404 }
    );
  if (!result.ok)
    return NextResponse.json({ error: result.message, reason: result.reason }, { status: 409 });

  return NextResponse.json(result, {
    // A door code has no business in any cache between here and the customer.
    headers: { "Cache-Control": "no-store" },
  });
}
