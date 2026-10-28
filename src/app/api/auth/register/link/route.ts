import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { registrationLink } from "@/lib/registration";

export const dynamic = "force-dynamic";

/**
 * `{ token }` → `{ email }`, the address an emailed sign-up link is for, while
 * it can still be used; otherwise `400 REGISTRATION_INVALID`, the one answer
 * for every link that cannot be. In the body, not the address, so the token
 * stays out of request logs. Counts against the sign-in limit, as a reset does.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { token } = (body ?? {}) as Record<string, unknown>;
  if (typeof token !== "string") return NextResponse.json({ error: "token is required." }, { status: 400 });
  const limited = await rateLimit(req, "login");
  if (limited) return limited;
  const found = await registrationLink(token);
  if (!found.ok) return NextResponse.json(found, { status: 400 });
  return NextResponse.json({ email: found.email });
}
