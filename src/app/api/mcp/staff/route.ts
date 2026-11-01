import { NextRequest } from "next/server";
import { notAllowed, serveMcp } from "@/lib/mcp/http";

export const dynamic = "force-dynamic";

/**
 * The MCP server for a member of staff signed in from an AI assistant's
 * connector (claude.ai, ChatGPT, any OAuth-capable MCP client;
 * docs/integrations/mcp.md#signing-in-from-an-ai-assistant, ADR 0030): the
 * same protocol and tools as `/api/mcp`, reached by an OAuth access token for
 * this address alone. Without one the answer is 401 with
 * `WWW-Authenticate: Bearer resource_metadata="…"`, which is how a connector
 * finds where to sign in. No cookie is read; an `Origin` from another site is
 * refused.
 */
export async function POST(req: NextRequest) {
  return serveMcp(req, "staff");
}

export const GET = notAllowed;
export const DELETE = notAllowed;
