import type { NextRequest } from "next/server";
import type { ApiCaller, ApiScope } from "../api-keys";

/**
 * The MCP server's one tool registry (docs/integrations/mcp.md, ADR 0029).
 *
 * Every tool names the authority it needs, and the server lists and runs a
 * tool only for a caller holding it:
 * - `public`: anybody, no credentials; only what the public pages and routes
 *   already show, through their own code;
 * - an API key's scope (`availability` < `read` < `write`, lib/api-keys.ts):
 *   the venue's own key, sent as `Authorization: Bearer <key>`, its venue only.
 * Signing in through an AI provider's connector (OAuth) and changing settings
 * would be new authorities here, with the same rule; neither is built.
 *
 * A tool is a thin reader over the functions the pages, the public routes and
 * `/api/v1` already run: no second business logic, nothing kept between
 * requests or venues.
 */

export type Authority = "public" | ApiScope;

const RANK: Record<ApiScope, number> = { availability: 0, read: 1, write: 2 };

/** What a tool call runs with: the request (for its host and address, never its cookies) and the key, if one was sent. */
export interface McpContext {
  req: NextRequest;
  caller: ApiCaller | null;
  /** The site's address for links: the storefront's, or the install's. */
  origin: string;
}

export interface ToolText {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolText[];
  isError?: boolean;
}

/** The hints the MCP specification defines; a client may show them, and may ask before a destructive call. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface McpTool {
  name: string;
  title: string;
  /** What it returns, said plainly: the assistant chooses tools by this. */
  description: string;
  authority: Authority;
  /** Only where the public page it mirrors exists: a marketplace (lib/mode.ts). */
  marketplaceOnly?: boolean;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  run(args: Record<string, unknown>, ctx: McpContext): Promise<ToolResult>;
}

/** Whether a caller holds the authority a tool needs. */
export function holds(caller: ApiCaller | null, authority: Authority): boolean {
  if (authority === "public") return true;
  return caller !== null && RANK[caller.scope] >= RANK[authority];
}

/** A short sentence for people, then the data as compact JSON. */
export function answer(sentence: string, data: unknown): ToolResult {
  return { content: [{ type: "text", text: `${sentence}\n\n${JSON.stringify(data)}` }] };
}

/** A refusal: the application's own sentence (and its code, where it has one), nothing changed. */
export function refused(error: string, code?: string | null): ToolResult {
  return { content: [{ type: "text", text: code ? `${error} (${code})` : error }], isError: true };
}

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
