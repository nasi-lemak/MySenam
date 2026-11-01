import { NextResponse } from "next/server";
import { authorizationServerMetadata } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";

/**
 * RFC 8414 authorization-server metadata (docs/integrations/mcp.md#signing-in-from-an-ai-assistant,
 * ADR 0030): where an AI assistant's connector registers, sends a member of
 * staff to sign in, exchanges and revokes tokens; the `code` grant with PKCE
 * S256 and refresh tokens, public clients only. Public, and readable from any
 * site.
 */
export async function GET() {
  return NextResponse.json(authorizationServerMetadata(), { headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" } });
}
