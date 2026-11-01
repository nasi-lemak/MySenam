import { NextRequest, NextResponse } from "next/server";
import { apiCaller, type ApiCaller } from "@/lib/api-keys";
import { handleMessage, isProtocolVersion, PROTOCOL_VERSIONS, RPC, rpcError, type RpcResponse } from "@/lib/mcp/protocol";
import { baseUrl } from "@/lib/outbox";
import { rateLimit } from "@/lib/rate-limit";
import { foreignOrigin } from "@/lib/same-origin";
import { storefrontForRequest } from "@/lib/storefront";

export const dynamic = "force-dynamic";

/**
 * The MCP server (docs/integrations/mcp.md; ADR 0029): the Model Context
 * Protocol's Streamable HTTP transport, stateless, answering each POST with
 * JSON. No session (`Mcp-Session-Id` is never set), no server-sent events
 * (GET answers 405, as the specification allows), nothing cached.
 *
 * Who is calling is the `Authorization: Bearer <key>` header and nothing else:
 * a venue's API key, checked as `/api/v1` checks it (lib/api-keys.ts: the
 * hash, revocation, last used, 120 calls a minute per key). A header that is
 * not a good key is refused (401 with `WWW-Authenticate`), never taken as
 * nobody. No header: the public tools only, 60 calls a minute per address. A
 * cookie never signs anybody in here, and an `Origin` from another site is
 * refused.
 */

const MAX_BODY = 256 * 1024;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

/** The hosts a browser page may call from: the install's own address and, on a storefront, its own name. */
async function allowedHosts(req: NextRequest): Promise<{ hosts: string[]; origin: string }> {
  const site = new URL(baseUrl());
  const storefront = await storefrontForRequest(req);
  if (!storefront) return { hosts: [site.host], origin: site.origin };
  return { hosts: [site.host, storefront.hostname, `www.${storefront.hostname}`], origin: `https://${storefront.hostname}` };
}

export async function POST(req: NextRequest) {
  const { hosts, origin } = await allowedHosts(req);
  if (foreignOrigin({ header: (n) => req.headers.get(n) }, hosts))
    return json(rpcError(null, RPC.invalidRequest, "That request came from another site, so it was refused."), 403);

  // After initialising, a client says the version it speaks on every request; one this server does not is refused.
  const version = req.headers.get("mcp-protocol-version");
  if (version !== null && !isProtocolVersion(version))
    return json(rpcError(null, RPC.invalidRequest, `Unsupported MCP-Protocol-Version: ${version}. Supported: ${PROTOCOL_VERSIONS.join(", ")}.`), 400);

  let caller: ApiCaller | null = null;
  if (req.headers.has("authorization")) {
    // Any key's scope may connect; each tool asks for its own (lib/mcp/registry.ts).
    const found = await apiCaller(req, "availability");
    if (found instanceof NextResponse) {
      if (found.status !== 401) return found;
      const { error } = (await found.json()) as { error: string };
      return json(rpcError(null, RPC.invalidRequest, error), 401, {
        "WWW-Authenticate": `Bearer realm="mysenam", error="invalid_token", error_description="${error.replace(/"/g, "'")}"`,
      });
    }
    caller = found;
  } else {
    const limited = await rateLimit(req, "mcp");
    if (limited) return limited;
  }

  const text = await req.text();
  if (text.length > MAX_BODY) return json(rpcError(null, RPC.invalidRequest, "The request is too large."), 413);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return json(rpcError(null, RPC.parseError, "Parse error: the body is not JSON."), 400);
  }

  const ctx = { req, caller, origin };
  // A batch (allowed by the 2025-03-26 version of the protocol) is answered as one; later versions send one message at a time.
  if (Array.isArray(payload)) {
    if (payload.length === 0) return json(rpcError(null, RPC.invalidRequest, "An empty batch."), 400);
    const answers: RpcResponse[] = [];
    for (const m of payload.slice(0, 32)) {
      const a = await handleMessage(m, ctx);
      if (a) answers.push(a);
    }
    return answers.length ? json(answers) : new NextResponse(null, { status: 202 });
  }
  const answered = await handleMessage(payload, ctx);
  // A notification or a response: accepted, nothing to say.
  if (!answered) return new NextResponse(null, { status: 202 });
  return json(answered);
}

/** No server-sent event stream, and no session to end: only POST. */
function notAllowed() {
  return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}
export const GET = notAllowed;
export const DELETE = notAllowed;
