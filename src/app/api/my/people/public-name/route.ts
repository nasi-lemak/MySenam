import { NextRequest, NextResponse } from "next/server";
import { readJsonObject } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { authorise, publicNamesFor, withdrawConsent, type ConsentRefusal } from "@/lib/public-name-consents";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const refused = (r: ConsentRefusal) => NextResponse.json({ error: r.error, code: r.code, ...(r.vars ? { vars: r.vars } : {}) }, { status: r.status });

/**
 * A guardian's authorisation to show a child's full name on public pages (lib/public-name-consents.ts;
 * docs/architecture/privacy.md#minors-names-on-public-pages). `?id=` the participant: the places the child holds now, each of
 * which an authorisation could be given for, the venues, and the authorisations in force. Only for an account that manages the
 * child now; never a manager's or a venue's.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const found = await publicNamesFor(user.id, req.nextUrl.searchParams.get("id"));
  if ("ok" in found) return refused(found);
  return NextResponse.json(found, { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ action: "authorise", id, scope: "event", kind: "tournament" | "league" | "ladder", eventId, confirm: true, locale? }` or
 * `{ action: "authorise", id, scope: "venue", venueId, confirm: true, locale? }`: `confirm` must be `true` (nothing implies it);
 * `locale` is the language the guardian was shown the wording in, recorded with it. `{ action: "withdraw", consentId }` takes
 * effect on the next request to any public page. Each is recorded in the child's history and the venue's activity log.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "booking", "public-name");
  if (limited) return limited;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  if (body.action === "withdraw") {
    const done = await withdrawConsent(user, body.consentId);
    if (!done.ok) return refused(done);
    return NextResponse.json({ ok: true });
  }
  if (body.action === "authorise") {
    const done = await authorise(user, { ...body, participantId: body.id });
    if (!done.ok) return refused(done);
    return NextResponse.json({ consent: done.value, already: done.already }, { status: done.already ? 200 : 201 });
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
