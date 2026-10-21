import { keyedHash } from "./secrets";

/** The signed link a booking is reviewed through (lib/reviews.ts): no phone number in it, so it can go in an email. */
export function reviewToken(code: string): string {
  return keyedHash("review", code.toUpperCase()).slice(0, 24);
}

export function reviewPath(code: string): string {
  return `/review/${encodeURIComponent(code)}?t=${reviewToken(code)}`;
}
