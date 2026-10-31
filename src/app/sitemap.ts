import type { MetadataRoute } from "next";
import { BUSINESS_TYPE_IDS } from "@/lib/guide/business-types";
import { isMarketplace } from "@/lib/mode";
import { listedVenues, siteOrigin } from "@/lib/seo";
import { currentStorefront } from "@/lib/storefront";

export const dynamic = "force-dynamic";

/** The public pages, and every venue a visitor could find from them (lib/seo.ts). */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await siteOrigin();
  const pages = ["", "/search", "/classes", "/play", "/tournaments", "/leagues", "/pricing", "/list-your-venue", "/terms", "/privacy"];
  // The guide to how MySenam fits a business: the marketplace's own, never a storefront's (docs/features/venue-guide.md#the-public-guide).
  const guide = isMarketplace() && !(await currentStorefront()) ? ["/for-venues", ...BUSINESS_TYPE_IDS.map((id) => `/for-venues/${id}`)] : [];
  return [
    ...pages.map((p) => ({ url: `${origin}${p}`, changeFrequency: "daily" as const, priority: p === "" ? 1 : 0.5 })),
    ...guide.map((p) => ({ url: `${origin}${p}`, changeFrequency: "monthly" as const, priority: 0.6 })),
    ...(await listedVenues()).map((v) => ({
      url: `${origin}/venue/${v.id}`,
      changeFrequency: "daily" as const,
      priority: 0.8,
      ...(v.publishedAt ? { lastModified: v.publishedAt.replace(" ", "T") + "Z" } : {}),
    })),
  ];
}
