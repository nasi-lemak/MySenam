import { isMarketplace } from "../mode";
import { siteName } from "../site";
import { ArgError } from "./args";
import { PUBLIC_TOOLS } from "./public-tools";
import { mayUse, refused, type McpContext, type McpTool, type ToolResult } from "./registry";
import { CONFIG_TOOLS } from "./config-tools";
import { logCall, SELF_LOGGING, VENUE_TOOLS } from "./venue-tools";

/**
 * The Model Context Protocol, as much of it as a tools-only, stateless server
 * needs (docs/integrations/mcp.md): JSON-RPC 2.0 messages for `initialize`,
 * `ping`, `tools/list` and `tools/call`, and the notifications a client sends
 * (`notifications/initialized`, a cancellation), which need no answer.
 *
 * Nothing is kept between requests: no session, no cache. Every request is
 * answered from what it carries (its key, if any) and the database as it is.
 */

/** The protocol versions understood, newest first. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0];

export const isProtocolVersion = (v: string): boolean => (PROTOCOL_VERSIONS as readonly string[]).includes(v);

/** JSON-RPC 2.0's error codes. */
export const RPC = { parseError: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internalError: -32603 } as const;

export const SERVER_VERSION = "1.0.0";

type Id = string | number | null;

export interface RpcError {
  jsonrpc: "2.0";
  id: Id;
  error: { code: number; message: string };
}
export interface RpcResult {
  jsonrpc: "2.0";
  id: Id;
  result: unknown;
}
export type RpcResponse = RpcError | RpcResult;

export const rpcError = (id: Id, code: number, message: string): RpcError => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpcResult = (id: Id, result: unknown): RpcResult => ({ jsonrpc: "2.0", id, result });

/** Every tool, in the order they are listed. */
export const ALL_TOOLS: McpTool[] = [...PUBLIC_TOOLS, ...VENUE_TOOLS, ...CONFIG_TOOLS];

/** Whether the tool exists on this install at all (a guide tool only where the guide is: a marketplace). */
const onThisInstall = (tool: McpTool): boolean => !tool.marketplaceOnly || isMarketplace();

/** The tools this caller may use: the public ones; with a key those its scope reaches; signed in, those its grant's scopes and the person's role reach. */
export function toolsFor(ctx: McpContext): McpTool[] {
  return ALL_TOOLS.filter((t) => onThisInstall(t) && mayUse(ctx, t));
}

const INSTRUCTIONS = [
  "MySenam books sports courts and other facilities.",
  "Without a key: the public guide to how MySenam fits a business (on a marketplace), search for free courts, and a live venue's public facts and day.",
  "With a venue's API key (Authorization: Bearer <key>): that venue only, its availability, bookings, setup status and playbook; with a write key, booking and cancelling, each answering a preview until called with confirm: true.",
  "Signed in as a member of staff through the assistant's connector (OAuth, at /api/mcp/staff): the one venue they allowed, what their role and the scopes they allowed reach, and for a manager who allowed it, changing the venue's settings through the dashboard's own checks: every change answers a preview and a previewToken first, and applies only when called again with confirm: true and that token.",
  "Customers' names, phone numbers and emails are hidden unless the venue's manager turned them on for AI assistants.",
].join(" ");

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const validId = (v: unknown): v is string | number => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

/**
 * One message. A request (a `method` and an `id`) is answered; a notification
 * (no `id`) and a client's response to the server (which never asks anything)
 * are not: null.
 */
export async function handleMessage(message: unknown, ctx: McpContext): Promise<RpcResponse | null> {
  if (!isObject(message) || message.jsonrpc !== "2.0") return rpcError(isObject(message) && validId(message.id) ? message.id : null, RPC.invalidRequest, "Not a JSON-RPC 2.0 message.");
  if (message.method === undefined && ("result" in message || "error" in message)) return null;
  if (typeof message.method !== "string") return rpcError(validId(message.id) ? message.id : null, RPC.invalidRequest, "A request names its method.");
  if (!("id" in message)) return null; // A notification: notifications/initialized, notifications/cancelled… nothing to answer.
  if (!validId(message.id)) return rpcError(null, RPC.invalidRequest, "A request's id is a string or a number.");
  const id = message.id;
  const params = message.params === undefined ? {} : message.params;
  if (!isObject(params)) return rpcError(id, RPC.invalidParams, "params must be an object.");

  switch (message.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return rpcResult(id, {
        // The client's version where it is one this server speaks; otherwise the newest it does, for the client to decide.
        protocolVersion: isProtocolVersion(asked) ? asked : LATEST_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "mysenam", title: siteName(), version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: toolsFor(ctx).map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
      });
    case "tools/call":
      return callTool(id, params, ctx);
    default:
      return rpcError(id, RPC.methodNotFound, `Method not found: ${message.method}`);
  }
}

async function callTool(id: string | number, params: Record<string, unknown>, ctx: McpContext): Promise<RpcResponse> {
  if (typeof params.name !== "string") return rpcError(id, RPC.invalidParams, "Name the tool (params.name).");
  const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
  if (!isObject(args)) return rpcError(id, RPC.invalidParams, "arguments must be an object.");
  const tool = ALL_TOOLS.find((t) => t.name === params.name && onThisInstall(t));
  if (!tool) return rpcError(id, RPC.invalidParams, `Unknown tool: ${params.name}`);
  // Known, but beyond what this caller holds: said in the API's own words, nothing done.
  if (!mayUse(ctx, tool)) return rpcResult(id, beyondAuthority(tool, ctx));
  let result: ToolResult;
  try {
    result = await tool.run(args, ctx);
  } catch (err) {
    if (err instanceof ArgError) result = refused(err.message);
    else throw err;
  }
  // Every call through a key or a sign-in is in the venue's staff activity log, as the key or the person; the writes log what they did themselves.
  if ((ctx.caller || ctx.person) && !SELF_LOGGING.has(tool.name) && !CONFIG_TOOLS.includes(tool)) await logCall(ctx, tool.name, result.isError ? "refused" : undefined);
  return rpcResult(id, result);
}

function beyondAuthority(tool: McpTool, ctx: McpContext): ToolResult {
  if (ctx.person) {
    if (tool.scope === undefined || !ctx.person.scopes.includes(tool.scope))
      return refused(`This connection was not allowed ${tool.scope ?? "that"}. Sign in again from the assistant and allow it, if your role may.`);
    // The scope is held, but the role as it is now may not do it on the dashboard either (lib/roles.ts).
    return refused("Front-desk accounts cannot change this. Ask a manager.", "MANAGER_ONLY");
  }
  if (tool.authority === "signedIn") return refused(`${tool.name} needs a member of staff signed in through the assistant's connector at /api/mcp/staff, not an API key.`);
  if (!ctx.caller) return refused(`${tool.name} needs the venue's API key: send Authorization: Bearer <key>.`);
  return refused(ctx.caller.scope === "availability" ? "This key can only see availability and the venue." : "This key can only read.");
}
