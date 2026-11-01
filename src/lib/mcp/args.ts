import { isValidDateString } from "../time";

/**
 * Reading a tool's arguments (lib/mcp/registry.ts): each reader answers the
 * value or throws an `ArgError` whose message is the sentence the caller is
 * shown, as a tool result marked `isError` so the assistant can correct its
 * call (the MCP specification's advice for input that does not validate).
 */

export class ArgError extends Error {}

export type Args = Record<string, unknown>;

export function optString(args: Args, key: string, max = 200): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new ArgError(`${key} must be text.`);
  if (v.length > max) throw new ArgError(`${key} is too long (${max} characters at most).`);
  return v.trim();
}

export function reqString(args: Args, key: string, max = 200): string {
  const v = optString(args, key, max);
  if (v === undefined) throw new ArgError(`${key} is required.`);
  return v;
}

export function optInt(args: Args, key: string, min = 1, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new ArgError(`${key} must be a whole number from ${min} to ${max}.`);
  return v;
}

export function reqInt(args: Args, key: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const v = optInt(args, key, min, max);
  if (v === undefined) throw new ArgError(`${key} is required.`);
  return v;
}

export function optDate(args: Args, key: string): string | undefined {
  const v = optString(args, key, 10);
  if (v === undefined) return undefined;
  if (!isValidDateString(v)) throw new ArgError(`${key} must be a date, YYYY-MM-DD.`);
  return v;
}

export function optList(args: Args, key: string, max = 64): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new ArgError(`${key} must be a list of text values.`);
  if (v.length > max) throw new ArgError(`${key} takes ${max} values at most.`);
  return v.map((x) => (x as string).trim()).filter(Boolean);
}

export function optEnum<T extends string>(args: Args, key: string, allowed: readonly T[]): T | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new ArgError(`${key} must be one of: ${allowed.join(", ")}.`);
  return v as T;
}

export function optNumber(args: Args, key: string, min: number, max: number): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new ArgError(`${key} must be a number from ${min} to ${max}.`);
  return v;
}
