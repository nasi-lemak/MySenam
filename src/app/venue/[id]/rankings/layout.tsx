import { notFound } from "next/navigation";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { mayShowVenue, pageViewer } from "@/lib/listing";
import { rankingPolicy } from "@/lib/ratings";
import { currentStorefront, shows } from "@/lib/storefront";

export const dynamic = "force-dynamic";

/**
 * A venue's public rankings page exists only where its manager has switched public rankings on (`public_rankings`, off by default;
 * lib/ratings.ts `rankingPolicy`). Until then it is a 404, as for a page that is not there, however much has been rated: not an
 * empty page. It also follows the venue's own visibility (a draft or private venue is for its own people). The layout is where this is
 * decided so the page itself stays a client component.
 */
async function allowed(id: string): Promise<number | null> {
  const venueId = Number(id);
  if (!Number.isInteger(venueId) || venueId <= 0) return null;
  if (!shows(await currentStorefront(), venueId)) return null;
  if (!(await mayShowVenue(venueId, await pageViewer())).show) return null;
  return (await rankingPolicy(venueId)).publicRankings ? venueId : null;
}

/** The people on a ranking chose to be on it, not to be found by a search engine: the page is not indexed, and the sitemap does not list it. */
export function generateMetadata(): Metadata {
  return { robots: { index: false, follow: false } };
}

export default async function RankingsLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  if ((await allowed((await params).id)) === null) notFound();
  return <>{children}</>;
}
