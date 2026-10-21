import type { MetadataRoute } from "next";
import { listedVenues, siteOrigin } from "@/lib/seo";

export const dynamic = "force-dynamic";

/** The public pages, and every venue a visitor could find from them (lib/seo.ts). */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await siteOrigin();
  const pages = ["", "/search", "/classes", "/play", "/tournaments", "/leagues", "/pricing", "/list-your-venue", "/terms", "/privacy"];
  return [
    ...pages.map((p) => ({ url: `${origin}${p}`, changeFrequency: "daily" as const, priority: p === "" ? 1 : 0.5 })),
    ...(await listedVenues()).map((v) => ({
      url: `${origin}/venue/${v.id}`,
      changeFrequency: "daily" as const,
      priority: 0.8,
      ...(v.publishedAt ? { lastModified: v.publishedAt.replace(" ", "T") + "Z" } : {}),
    })),
  ];
}
