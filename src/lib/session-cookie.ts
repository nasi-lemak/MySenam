import { NextRequest } from "next/server";

/**
 * Is this request actually running over HTTPS? Behind a proxy the connection
 * Next.js sees is plain HTTP, so trust `x-forwarded-proto` — which is only
 * meaningful when a proxy you control sets it. `SECURE_COOKIES=1` forces it on
 * for a deployment whose proxy does not.
 */
function isHttps(req: NextRequest): boolean {
  if (process.env.SECURE_COOKIES === "1") return true;
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0].trim() === "https";
  return req.nextUrl.protocol === "https:";
}

/**
 * Options for a session cookie. `secure` is set only on HTTPS: marking it on a
 * plain-HTTP deployment would stop the browser sending the cookie at all, so
 * the flag follows the connection rather than a build-time guess.
 *
 * Every place that sets a session cookie uses this, so a new one cannot
 * quietly ship without the flags.
 */
export function sessionCookieOptions(req: NextRequest, expires: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isHttps(req),
    path: "/",
    expires,
  };
}
