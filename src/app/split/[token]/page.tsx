import { notFound } from "next/navigation";
import { serverT } from "@/lib/locale";
import { money } from "@/lib/region";
import { splitByToken } from "@/lib/splits";
import { formatHour } from "@/lib/time";
import { SplitPay } from "@/components/SplitCost";

export const dynamic = "force-dynamic";

/** A friend's view of a split booking: what it is, their share, and paying it (lib/splits.ts). */
export default async function SplitPage({ params }: { params: Promise<{ token: string }> }) {
  const t = await serverT();
  const split = await splitByToken((await params).token);
  if (!split) notFound();
  return (
    <div className="mx-auto max-w-lg space-y-3 rounded-2xl border border-slate-200 bg-white p-6 text-sm shadow-sm">
      <h1 className="text-xl font-bold">{t("split.payTitle", { host: split.host, venue: split.venueName })}</h1>
      <p className="text-slate-600">
        {t("split.payWhat", { court: split.courtName, date: split.date, time: `${formatHour(split.startHour, t.locale)}–${formatHour(split.endHour, t.locale)}` })}
      </p>
      <p className="text-lg font-semibold">{t("split.payShare", { share: money(split.share) })}</p>
      <p className="text-slate-500">{t("split.progress", { paid: split.paid, of: split.parts - 1 })}</p>
      {split.closed ? (
        <p className="rounded-md bg-slate-50 p-3 font-medium">{t(`split.closed.${split.closed}`, { host: split.host })}</p>
      ) : (
        <>
          <p role="note" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900">
            {t("split.payTerms", { venue: split.venueName })}
          </p>
          <SplitPay token={split.token} />
        </>
      )}
    </div>
  );
}
