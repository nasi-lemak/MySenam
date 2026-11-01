import { NextResponse } from "next/server";
import { protectedResourceMetadata } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";

/**
 * RFC 9728 protected-resource metadata for the MCP server's signed-in address
 * (`/api/mcp/staff`; docs/integrations/mcp.md#signing-in-from-an-ai-assistant):
 * which authorization server signs people in to it, and its scopes. The same
 * document as at `/.well-known/oauth-protected-resource/api/mcp/staff`, for a
 * client that looks here first. Public, and readable from any site.
 */
export async function GET() {
  return NextResponse.json(protectedResourceMetadata(), { headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" } });
}
