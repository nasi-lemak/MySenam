import { findActivities, isKnownActivity } from "@/lib/activity-registry";
import { catalogue } from "@/lib/activities";
import { readNear, sportsOfferedAt } from "@/lib/store";
import { currentStorefront } from "@/lib/storefront";
import { isValidDateString } from "@/lib/time";
import { CLOSE_HOUR, OPEN_HOUR, type Sport } from "@/lib/types";
import SearchClient, { type SearchStart } from "./SearchClient";

export const dynamic = "force-dynamic";

/**
 * Find a court. What the search starts with can come in the address —
 * `?sport=badminton&date=2026-11-01&from=17&to=22&near=3.14,101.69&km=10&where=Bangsar`
 * — which is how the home page hands one over, and how a search is shared.
 * `?q=takraw` is the activity by any word for it, as the search box finds it.
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const hour = (v: string | undefined) => {
    const n = Number(v);
    return v !== undefined && Number.isInteger(n) && n >= OPEN_HOUR && n <= CLOSE_HOUR - 1 ? n : undefined;
  };
  const near = readNear(q.near, q.km);
  // Only the sports somebody here offers; on a storefront, its venues'.
  const sports = await sportsOfferedAt((await currentStorefront())?.venueIds);
  await catalogue();
  const named = !isKnownActivity(q.sport) && q.q ? findActivities(q.q.slice(0, 60)).find((k) => sports.includes(k)) : undefined;
  const start: SearchStart = {
    sport: isKnownActivity(q.sport) ? (q.sport as Sport) : named,
    date: q.date && isValidDateString(q.date) ? q.date : undefined,
    fromHour: hour(q.from),
    toHour: hour(q.to),
    near: near ? { ...near, where: q.where?.slice(0, 80) || null } : null,
  };
  return <SearchClient start={start} sports={sports} />;
}
