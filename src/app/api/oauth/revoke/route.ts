import { NextRequest, NextResponse } from "next/server";
import { revokeToken } from "@/lib/mcp/oauth";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * RFC 7009 token revocation (docs/integrations/mcp.md#signing-in-from-an-ai-assistant):
 * `token` (an access or a refresh token) and `client_id`, form-encoded. The
 * connection it belongs to ends, every token of it with it. Always 200, as
 * the specification asks, whether or not the token was known.
 */
export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, "oauthToken");
  if (limited) return limited;
  await revokeToken(new URLSearchParams(await req.text()));
  return new NextResponse(null, { status: 200, headers: { "Cache-Control": "no-store" } });
}
