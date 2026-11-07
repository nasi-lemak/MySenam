import type { NextRequest } from "next/server";
import type { ApiCaller, ApiScope } from "../api-keys";
import { staffMay, type StaffActionName } from "../roles";
import type { OAuthScope, PersonCaller } from "./oauth";

/**
 * The MCP server's one tool registry (docs/integrations/mcp.md, ADR 0029,
 * ADR 0030).
 *
 * Every tool names the authority it needs, and the server lists and runs a
 * tool only for a caller holding it:
 * - `public`: anybody, no credentials; only what the public pages and routes
 *   already show, through their own code;
 * - an API key's scope (`availability` < `read` < `write`, lib/api-keys.ts):
 *   the venue's own key, sent as `Authorization: Bearer <key>`, its venue only;
 * - for a member of staff signed in through an assistant (lib/mcp/oauth.ts),
 *   the OAuth `scope` the tool needs, held by their grant, and, where the
 *   tool names a `staffAction`, their role as it is now may do it on the
 *   dashboard (lib/roles.ts `staffMay`). `signedIn` tools (changing the
 *   venue's settings) are for them alone: no key reaches them.
 *
 * A tool is a thin reader over the functions the pages, the public routes,
 * `/api/v1` and the dashboard's routes already run: no second business logic,
 * nothing kept between requests or venues.
 */

export type Authority = "public" | ApiScope | "signedIn";

const RANK: Record<ApiScope, number> = { availability: 0, read: 1, write: 2 };

/**
 * What a tool call runs with: the request (for its host and address, never
 * its cookies), and who is calling: a key, a member of staff signed in through
 * an assistant, or nobody.
 */
export interface McpContext {
  req: NextRequest;
  caller: ApiCaller | null;
  person?: PersonCaller | null;
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
  /** For a member of staff signed in through an assistant: the scope their grant needs for it. */
  scope?: OAuthScope;
  /** And what their role must be allowed to do on the dashboard (lib/roles.ts `STAFF_ACTIONS`). */
  staffAction?: StaffActionName;
  /** Only where the public page it mirrors exists: a marketplace (lib/mode.ts). */
  marketplaceOnly?: boolean;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  run(args: Record<string, unknown>, ctx: McpContext): Promise<ToolResult>;
}

/** Whether this caller may list and run this tool. */
export function mayUse(ctx: Pick<McpContext, "caller" | "person">, tool: Pick<McpTool, "authority" | "scope" | "staffAction">): boolean {
  if (tool.authority === "public") return true;
  if (ctx.person)
    return tool.scope !== undefined && ctx.person.scopes.includes(tool.scope) && (tool.staffAction === undefined || staffMay(ctx.person.role)[tool.staffAction]);
  // A key of a suspended venue or business reads but does not write (lib/api-keys.ts `apiCaller`, ADR 0064).
  if (ctx.caller && tool.authority !== "signedIn") return RANK[ctx.caller.scope] >= RANK[tool.authority] && !(ctx.caller.suspended && tool.authority === "write");
  return false;
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
