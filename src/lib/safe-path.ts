/**
 * Where a page may send the browser next, from an address it was handed
 * (`?next=`, or the sign-up's remembered page): only ever a page on this
 * site. Kept apart from lib/oauth.ts, which is server code, so the sign-in,
 * sign-up, phone and about pages use this one check too
 * (docs/architecture/security.md#where-sign-in-sends-you-next).
 *
 * A path that a browser or the WHATWG URL parser could read as another
 * site is refused, and the fallback used instead:
 *
 * - anything not starting with one `/` (`https://elsewhere`, `//elsewhere`);
 * - a backslash anywhere (`/\elsewhere` is `//elsewhere` to a browser);
 * - control characters anywhere: the parser drops a tab or newline, so
 *   `/<TAB>/elsewhere` is `//elsewhere`;
 * - the same again percent-encoded (`/%5Celsewhere`, `/%09/elsewhere`,
 *   `/%2F/elsewhere`), however many times;
 * - and, last, anything that resolved against this site lands elsewhere.
 */

/** The longest `next` kept: a page's path and query, not a document. */
export const MAX_NEXT_LENGTH = 500;

const UNSAFE = /[\u0000-\u001f\u007f-\u009f\\]/;
const ORIGIN = "https://this-site.invalid";

export function safePath(next: string | null | undefined, fallback = "/account"): string {
  if (typeof next !== "string" || next === "" || next.length > MAX_NEXT_LENGTH) return fallback;
  let seen = next;
  // Each layer of percent-encoding peeled off and checked again (a few are plenty; more is refused).
  for (let layer = 0; ; layer++) {
    if (UNSAFE.test(seen) || !seen.startsWith("/") || seen.startsWith("//")) return fallback;
    let decoded: string;
    try {
      decoded = decodeURIComponent(seen);
    } catch {
      return fallback;
    }
    if (decoded === seen) break;
    if (layer >= 3) return fallback;
    seen = decoded;
  }
  let url: URL;
  try {
    url = new URL(next, ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== ORIGIN) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Why a sign-in came back refused, as the sign-in page may say it: one of
 * these codes, each a phrase of its own (`auth.err.<code>`); anything else in
 * `?error=` is shown as the general failure, never as given.
 */
export const SIGN_IN_ERRORS = ["google", "cancelled", "unverified", "expired", "noemail", "unavailable"] as const;
export type SignInError = (typeof SIGN_IN_ERRORS)[number];

export function signInError(raw: string | null | undefined): SignInError | null {
  if (!raw) return null;
  return (SIGN_IN_ERRORS as readonly string[]).includes(raw) ? (raw as SignInError) : "google";
}
