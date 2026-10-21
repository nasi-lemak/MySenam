import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/seo";

export const dynamic = "force-dynamic";

/** Venues and listings are for search engines; accounts, staff pages and links sent to one person are not. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = await siteOrigin();
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/api/", "/account", "/my-booking", "/receipt/", "/review/", "/unsubscribe/", "/coach/", "/ack/", "/payments/", "/waitlist/", "/reset-password", "/forgot-password", "/login", "/checkin"],
    },
    sitemap: `${origin}/sitemap.xml`,
  };
}
