import { NextRequest, NextResponse } from "next/server";
import { getActingStaff, getSessionAdmin } from "@/lib/admin-auth";
import { jsonObject } from "@/lib/api";
import { decide, grantableScopes, readAuthorizationRequest, venuesToChoose } from "@/lib/mcp/oauth";
import { crossSiteRefusal } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/** Where the consent page sends somebody not signed in: the staff sign-in, coming back to the same request. */
const signInPath = (search: string) => `/admin?next=${encodeURIComponent(`/oauth/authorize${search}`)}`;

/**
 * What the consent page (`/oauth/authorize`, docs/integrations/mcp.md#signing-in-from-an-ai-assistant)
 * shows for an authorization request, its query passed on as it came:
 * - `400 { problem, error }`: the client or the address to return to is not
 *   registered; shown on the page, the browser sent nowhere;
 * - `{ redirect }`: anything else wrong, sent back to the client's own
 *   registered address as an OAuth error with the state;
 * - `{ signIn }`: nobody signed in as staff (or two-factor sign-in still to set
 *   up): the staff sign-in, which comes back here;
 * - `{ request, person, venues }`: the client by the name it gave (not
 *   verified), the host it returns to, the scopes asked, and each venue the
 *   person may choose with their role there and what that role may allow.
 */
export async function GET(req: NextRequest) {
  const read = await readAuthorizationRequest((n) => req.nextUrl.searchParams.get(n));
  if (!read.ok) {
    if (read.kind === "page") return NextResponse.json({ problem: read.problem, error: read.description }, { status: 400, headers: noStore });
    return NextResponse.json({ redirect: read.redirect }, { headers: noStore });
  }
  const signedIn = await getSessionAdmin(req);
  const admin = await getActingStaff(req);
  if (!admin) return NextResponse.json({ signIn: signInPath(req.nextUrl.search), twoFactor: signedIn !== null }, { headers: noStore });
  const { request } = read;
  const venues = await venuesToChoose(admin);
  return NextResponse.json(
    {
      request: { clientName: request.client.name, nameVerified: false, redirectHost: new URL(request.redirectUri).host, scopes: request.scopes },
      person: { name: admin.name, email: admin.email },
      venues: venues.map((v) => ({ ...v, grantable: grantableScopes(v.role) })),
    },
    { headers: noStore }
  );
}

/**
 * `{ query, decision: "allow" | "deny", venueId, scopes }` from the consent
 * page, `query` being the authorization request's own: read and checked
 * again, for a member of staff signed in (two-factor sign-in honoured), as a
 * JSON request from this site only (lib/same-origin.ts, and the middleware's
 * own check). Answers `{ redirect }`: the client's registered address with
 * the code and state, or with `access_denied`.
 */
export async function POST(req: NextRequest) {
  const crossSite = crossSiteRefusal({
    method: req.method,
    pathname: req.nextUrl.pathname,
    header: (n) => req.headers.get(n),
    cookieNames: req.cookies.getAll().map((c) => c.name),
  });
  if (crossSite || !(req.headers.get("content-type") ?? "").startsWith("application/json"))
    return NextResponse.json({ error: "That request came from another site, so it was refused." }, { status: 403, headers: noStore });
  const admin = await getActingStaff(req);
  if (!admin) return NextResponse.json({ error: "Please sign in." }, { status: 401, headers: noStore });
  let body: Record<string, unknown>;
  try {
    body = await jsonObject(req);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: noStore });
  }
  if (typeof body.query !== "string" || body.query.length > 4000) return NextResponse.json({ error: "Send the request's query." }, { status: 400, headers: noStore });
  const query = new URLSearchParams(body.query.startsWith("?") ? body.query.slice(1) : body.query);
  const read = await readAuthorizationRequest((n) => query.get(n));
  if (!read.ok) {
    if (read.kind === "page") return NextResponse.json({ problem: read.problem, error: read.description }, { status: 400, headers: noStore });
    return NextResponse.json({ redirect: read.redirect }, { headers: noStore });
  }
  if (body.decision !== "allow" && body.decision !== "deny") return NextResponse.json({ error: "decision is allow or deny." }, { status: 400, headers: noStore });
  const decided = await decide(admin, read.request, { allow: body.decision === "allow", venueId: body.venueId, scopes: body.scopes });
  if (!decided.ok) return NextResponse.json({ error: decided.error }, { status: decided.status, headers: noStore });
  return NextResponse.json({ redirect: decided.redirect }, { headers: noStore });
}
