/**
 * Refused because the account has no phone number yet, or has not checked
 * it: off to add or check it, and back to `next` (where they were, unless
 * told) once it is done. True if it went.
 */
export function phoneDetour(body: { code?: string } | null | undefined, next?: string): boolean {
  if (body?.code !== "PHONE_NEEDED" && body?.code !== "PHONE_UNVERIFIED") return false;
  const back = next ?? `${window.location.pathname}${window.location.search}`;
  window.location.href = `/account/phone?next=${encodeURIComponent(back)}`;
  return true;
}
