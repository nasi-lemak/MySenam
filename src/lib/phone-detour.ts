/**
 * Refused for something the account has not told us yet — a phone number,
 * a checked one, or which games it plays in — so off to say it, and back to
 * `next` (where they were, unless told) once it is done. True if it went.
 */
export function accountDetour(body: { code?: string } | null | undefined, next?: string): boolean {
  const page =
    body?.code === "PHONE_NEEDED" || body?.code === "PHONE_UNVERIFIED"
      ? "/account/phone"
      : body?.code === "GENDER_NEEDED"
        ? "/account/about"
        : null;
  if (!page) return false;
  const back = next ?? `${window.location.pathname}${window.location.search}`;
  window.location.href = `${page}?next=${encodeURIComponent(back)}`;
  return true;
}
