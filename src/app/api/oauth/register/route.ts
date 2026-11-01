import { NextRequest, NextResponse } from "next/server";
import { registerClient } from "@/lib/mcp/oauth";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/**
 * RFC 7591 dynamic client registration for AI assistants' connectors
 * (docs/integrations/mcp.md#signing-in-from-an-ai-assistant): `{ redirect_uris,
 * client_name?, client_uri?, grant_types?, response_types?,
 * token_endpoint_auth_method? }` → 201 with the `client_id`. Public clients
 * only: no secret is issued, whatever method is asked for. Redirect URIs are
 * https, or http on the same computer. 30 an hour per address (a provider registers for all its users from few addresses).
 */
export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, "oauthRegister");
  if (limited) return limited;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_client_metadata", error_description: "The body is a JSON object." }, { status: 400, headers: noStore });
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return NextResponse.json({ error: "invalid_client_metadata", error_description: "The body is a JSON object." }, { status: 400, headers: noStore });
  const done = await registerClient(body as Record<string, unknown>);
  if (!done.ok) return NextResponse.json({ error: done.error, error_description: done.description }, { status: 400, headers: noStore });
  return NextResponse.json(done.response, { status: 201, headers: noStore });
}
