import { NextRequest, NextResponse } from "next/server";
import { recordError } from "@/lib/error-log";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Noise every site gets from browsers it does not control: extensions,
 * cross-origin scripts that only say "Script error.", and a layout warning
 * Chrome reports as an error.
 */
const NOISE = [/extension:\/\//, /^Script error\.?$/, /ResizeObserver loop/];

/**
 * `{ name?, message, stack?, path? }`: an error in a customer's browser
 * (components/ErrorReporter.tsx), filed with the server's (lib/error-log.ts).
 * Anybody can send one, so it is limited per address, cut to size and never
 * echoed back.
 */
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "clientError");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const text = (k: string, max: number) => (typeof body?.[k] === "string" ? (body[k] as string).slice(0, max) : null);
  const message = text("message", 500);
  if (!message) return NextResponse.json({ error: "message is required." }, { status: 400 });
  const stack = text("stack", 4000);
  if (NOISE.some((n) => n.test(message) || (stack !== null && n.test(stack)))) return new NextResponse(null, { status: 204 });
  await recordError({ source: "browser", name: text("name", 100) ?? "Error", message, stack, path: text("path", 300) });
  return new NextResponse(null, { status: 204 });
}
