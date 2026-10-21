import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { mayShowVenue, pageViewer } from "@/lib/listing";
import { serverT } from "@/lib/locale";
import { onlineTopUpsAllowed, takesPaymentOnline } from "@/lib/payments";
import { getVenue } from "@/lib/store";
import { currentStorefront, shows } from "@/lib/storefront";
import { MIN_VOUCHER } from "@/lib/vouchers";
import { MAX_TOP_UP } from "@/lib/types";
import GiftVoucherForm from "@/components/GiftVoucherForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Gift voucher", robots: { index: false } };

/** Buying a gift voucher for a venue, online; or where to buy one at the counter. */
export default async function GiftPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || !shows(await currentStorefront(), id) || !(await mayShowVenue(id, await pageViewer())).show)
    notFound();
  const venue = await getVenue(id);
  if (!venue) notFound();
  const t = await serverT();
  const online = onlineTopUpsAllowed() && (await takesPaymentOnline(id));
  return (
    <div className="mx-auto max-w-md space-y-4">
      <Link href={`/venue/${id}`} className="text-sm font-medium text-teal-700 hover:underline">
        ← {venue.name}
      </Link>
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-bold">🎁 {t("gift.buyTitle", { venue: venue.name })}</h1>
        <p className="mt-1 text-sm text-slate-600">{t("gift.buyIntro", { venue: venue.name })}</p>
        {online ? (
          <GiftVoucherForm venueId={id} venueName={venue.name} min={MIN_VOUCHER} max={MAX_TOP_UP} />
        ) : (
          <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{t("gift.offline", { venue: venue.name })}</p>
        )}
      </div>
    </div>
  );
}
