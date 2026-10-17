import { NextRequest, NextResponse } from "next/server";
import { normalizeHost, storefrontForHost } from "@/lib/storefront";

export const dynamic = "force-dynamic";

/**
 * May the web server get a certificate for this hostname?
 *
 * On a server of our own, Caddy fetches a certificate the first time a
 * storefront's domain is visited, and asks here first
 * (`on_demand_tls { ask … }`). Without the question, anybody could point any
 * number of domains at the box and have it request certificates for each of
 * them until the certificate authority stopped answering for the real ones.
 *
 * Yes for the install's own address and for each registered storefront —
 * with or without www., as a storefront answers to both — and no for
 * everything else. Nothing is said that the domains themselves do not already
 * say to anyone who visits them.
 */
export async function GET(req: NextRequest) {
  const domain = req.nextUrl.searchParams.get("domain");
  const host = normalizeHost(domain);
  const own = (() => {
    try {
      return process.env.MYSENAM_URL ? normalizeHost(new URL(process.env.MYSENAM_URL).hostname) : null;
    } catch {
      return null;
    }
  })();
  const allowed = host !== null && (host === own || (await storefrontForHost(host)) !== null);
  return new NextResponse(null, { status: allowed ? 200 : 404, headers: { "Cache-Control": "no-store" } });
}
