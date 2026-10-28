import { isLocale, translator } from "./i18n";

/**
 * Reading a response from the app's own routes, the one way every page and
 * staff screen does it (audit R8 X2-7).
 *
 * The routes answer JSON, but what reaches the browser is not always theirs:
 * while the app restarts during a deploy the proxy answers 502 with an HTML
 * page, an overloaded server may answer 504, and an unhandled error is Next's
 * own HTML. Parsed blindly, that becomes "Unexpected token '<' … is not valid
 * JSON", in English, under a booking form. Read here instead, an answer that
 * is not the app's (not JSON, or a 5xx with nothing of its own to say) becomes
 * a refusal with the code `SITE_BUSY`, which `translateError` and the staff
 * screens' `t.err` say in the reader's language: the site did not answer
 * properly, try again in a moment, and check whether it went through before
 * doing it twice.
 *
 * A drop-in for `res.json()`: the same body wherever the app answered, so a
 * caller's `if (!res.ok)` and its refusal handling stay as they are. A success
 * status with a body that is not the app's throws instead, as `res.json()`
 * did, so no caller goes on with a body that has none of what it expects; the
 * error says the same sentence, in the page's language.
 */

/** The code of an answer that was not the app's own (`err.SITE_BUSY` in the customer dictionaries). */
export const SITE_BUSY = "SITE_BUSY";

/** The English sentence, as `err.SITE_BUSY` says it. */
export function siteBusySentence(locale: string = "en"): string {
  return translator(isLocale(locale) ? locale : "en")("err.SITE_BUSY");
}

/** True for a body `readJson` made up because the answer was not the app's. */
export function isSiteBusy(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { code?: unknown }).code === SITE_BUSY;
}

/** The page's language (the root element's `lang`, "zh-Hans" for Chinese), on the server English. */
function pageLocale(): string {
  if (typeof document === "undefined") return "en";
  return (document.documentElement.lang || "en").slice(0, 2);
}

/**
 * The response's JSON body. Where the answer is not the app's (not JSON, or a
 * server error, 5xx, without an `error` of the app's own): for a failure
 * status `{ error, code: "SITE_BUSY" }`, for a success status an Error with
 * that sentence in the page's language.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the same contract as Response.json(), so every caller keeps its own reading of the body
export async function readJson(res: Response): Promise<any> {
  let body: unknown = undefined;
  try {
    // Response.json() itself, so whatever stands in for a Response (a test's) is read the same way.
    body = await res.json();
  } catch {
    body = undefined;
  }
  const own = typeof body === "object" && body !== null;
  // A server error that says something of its own (a payment page that would not open) is kept: it is the app's.
  const said = own && typeof (body as { error?: unknown }).error === "string";
  if (body !== undefined && (!(res.status >= 500) || said)) return body;
  if (res.ok) throw new Error(siteBusySentence(pageLocale()));
  return { error: siteBusySentence("en"), code: SITE_BUSY };
}
