import { NextRequest, NextResponse } from "next/server";
import { crossSiteRefusal } from "./lib/same-origin";

/** Refuse a signed-in change asked for by another site (lib/same-origin.ts). */
export function middleware(req: NextRequest) {
  const refusal = crossSiteRefusal({
    method: req.method,
    pathname: req.nextUrl.pathname,
    header: (name) => req.headers.get(name),
    cookieNames: req.cookies.getAll().map((c) => c.name),
  });
  if (refusal) return NextResponse.json({ error: "That request came from another site, so it was refused." }, { status: 403 });
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
