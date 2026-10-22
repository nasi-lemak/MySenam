import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { mayShowVenue, pageViewer } from "@/lib/listing";
import { serverT } from "@/lib/locale";
import { getVenue } from "@/lib/store";
import { currentStorefront, shows } from "@/lib/storefront";
import { currentWaiver } from "@/lib/waivers";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Waiver", robots: { index: false } };

/** A venue's waiver, in its own words, for anybody about to agree to it (lib/waivers.ts). */
export default async function WaiverPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || !shows(await currentStorefront(), id) || !(await mayShowVenue(id, await pageViewer())).show)
    notFound();
  const venue = await getVenue(id);
  if (!venue) notFound();
  const t = await serverT();
  const waiver = await currentWaiver(id);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link href={`/venue/${id}`} className="text-sm font-medium text-teal-700 hover:underline">
        ← {venue.name}
      </Link>
      <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-bold">
          {t("waiver.title")}: {venue.name}
        </h1>
        {waiver ? (
          <>
            <p className="mt-1 text-sm text-slate-600">{t("waiver.intro", { venue: venue.name })}</p>
            <p className="text-xs text-slate-500">{t("waiver.since", { date: waiver.createdAt.slice(0, 10) })}</p>
            <div className="mt-4 whitespace-pre-line text-sm leading-relaxed text-slate-800">{waiver.text}</div>
          </>
        ) : (
          <p className="mt-2 text-sm text-slate-600">{t("waiver.none", { venue: venue.name })}</p>
        )}
      </article>
    </div>
  );
}
