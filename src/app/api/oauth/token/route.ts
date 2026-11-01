import { NextRequest, NextResponse } from "next/server";
import { exchangeCode, refreshTokens } from "@/lib/mcp/oauth";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store", Pragma: "no-cache" };

/** The form a client sends (application/x-www-form-urlencoded, as OAuth asks; a JSON object is read the same way). */
async function formOf(req: NextRequest): Promise<URLSearchParams> {
  const text = await req.text();
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      return new URLSearchParams(Object.entries(body ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"));
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(text);
}

/**
 * The token endpoint (docs/integrations/mcp.md#signing-in-from-an-ai-assistant):
 * `grant_type=authorization_code` with `code`, `redirect_uri`, `client_id`,
 * `code_verifier` and optionally `resource`; or `grant_type=refresh_token`
 * with `refresh_token` and `client_id`. Answers an access token for an hour
 * and a new refresh token (the old one used up; one used twice ends the
 * connection), or an OAuth error. Public clients: no secret. 600 in ten
 * minutes per address.
 */
export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, "oauthToken");
  if (limited) return limited;
  const form = await formOf(req);
  const grantType = form.get("grant_type");
  const done =
    grantType === "authorization_code"
      ? await exchangeCode(form)
      : grantType === "refresh_token"
        ? await refreshTokens(form)
        : ({ ok: false, status: 400, error: "unsupported_grant_type", description: "grant_type is authorization_code or refresh_token." } as const);
  if (!done.ok) return NextResponse.json({ error: done.error, error_description: done.description }, { status: done.status, headers: noStore });
  return NextResponse.json(done.body, { headers: noStore });
}
