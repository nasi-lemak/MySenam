import { NextRequest, NextResponse } from "next/server";
import { currentLocale } from "@/lib/locale";
import { rateLimit } from "@/lib/rate-limit";
import { writeReview } from "@/lib/reviews";

export const dynamic = "force-dynamic";

/** `{ code, t, rating, body? }` → this number's review of the venue, written or written again (lib/reviews.ts). */
export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.code !== "string" || typeof body.t !== "string")
    return NextResponse.json({ error: "code and t are required." }, { status: 400 });
  const written = await writeReview(body.code, body.t, { rating: body.rating, body: body.body, locale: await currentLocale() });
  if (!written.ok) return NextResponse.json({ error: written.error, code: written.code, vars: written.vars }, { status: written.code === "REVIEW_NOT_FOUND" ? 404 : 409 });
  return NextResponse.json({ review: written.review });
}
