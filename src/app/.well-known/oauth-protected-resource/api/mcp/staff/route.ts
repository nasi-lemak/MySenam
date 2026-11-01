import { NextResponse } from "next/server";
import { protectedResourceMetadata } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";

/**
 * RFC 9728 protected-resource metadata at the address the specification
 * derives from `/api/mcp/staff`, which its 401's `resource_metadata` names
 * (docs/integrations/mcp.md#signing-in-from-an-ai-assistant). Public, and
 * readable from any site.
 */
export async function GET() {
  return NextResponse.json(protectedResourceMetadata(), { headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" } });
}
