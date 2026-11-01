import { NextRequest } from "next/server";
import { notAllowed, serveMcp } from "@/lib/mcp/http";

export const dynamic = "force-dynamic";

/**
 * The MCP server (docs/integrations/mcp.md; ADR 0029): the Model Context
 * Protocol's Streamable HTTP transport, stateless, answering each POST with
 * JSON (lib/mcp/http.ts). No session, no server-sent events (GET answers 405,
 * as the specification allows), nothing cached.
 *
 * Who is calling is the `Authorization: Bearer <key>` header and nothing else:
 * a venue's API key, checked as `/api/v1` checks it (lib/api-keys.ts: the
 * hash, revocation, last used, 120 calls a minute per key). A header that is
 * not a good key is refused (401 with `WWW-Authenticate`), never taken as
 * nobody. No header: the public tools only, 60 calls a minute per address. A
 * cookie never signs anybody in here, and an `Origin` from another site is
 * refused. A member of staff signed in from an assistant's connector uses
 * `/api/mcp/staff` instead (ADR 0030).
 */
export async function POST(req: NextRequest) {
  return serveMcp(req, "key");
}

export const GET = notAllowed;
export const DELETE = notAllowed;
