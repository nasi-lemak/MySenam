import { NextResponse } from "next/server";
import type { Refusal } from "./types";

/**
 * A refusal, on its way to the browser.
 *
 * `error` is the English sentence and goes out whatever happens, so anything
 * reading it keeps working. `code` and `vars` ride alongside when the store
 * named the refusal, which is what lets the page say it in the reader's
 * language instead of this one.
 */
export function refusal(r: Refusal, status = 409): NextResponse {
  return NextResponse.json({ error: r.error, code: r.code, vars: r.vars }, { status });
}
