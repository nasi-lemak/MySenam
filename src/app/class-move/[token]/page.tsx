import { movedPlaces } from "@/lib/class-moves";
import { currentLocale, serverT } from "@/lib/locale";
import { formatMinute } from "@/lib/interval";
import { clockTime, shortDate } from "@/lib/region";
import { localDateOf } from "@/lib/time";
import CancelPlace from "./CancelPlace";

export const dynamic = "force-dynamic";

/**
 * Where the link in a class's move notice lands (lib/class-moves.ts): the places moved, where each was and is, and for each a
 * button to cancel it for everything back until its window ends. Opening the page cancels nothing (mail scanners open links on
 * their own): the customer taps, and confirms.
 */
export default async function ClassMovePage({ params }: { params: Promise<{ token: string }> }) {
  const t = await serverT();
  const locale = await currentLocale();
  const { token } = await params;
  const places = await movedPlaces(token);
  if (!places)
    return (
      <div className="mx-auto max-w-md space-y-4 py-10 text-center">
        <p className="text-slate-600">{t("clsa.page.unknown")}</p>
      </div>
    );
  const at = (w: { date: string; startMin: number; endMin: number; courtName: string }) =>
    `${shortDate(w.date, locale, true)}, ${formatMinute(w.startMin, locale)}–${formatMinute(w.endMin, locale)}, ${w.courtName}`;
  return (
    <div className="mx-auto max-w-md space-y-4 py-8">
      <h1 className="text-xl font-bold">{t("clsa.page.title")}</h1>
      <p className="text-sm text-slate-600">{t("clsa.page.intro", { venue: places[0].venueName })}</p>
      <ul className="space-y-3">
        {places.map((p) => (
          <li key={p.bookingId} className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
            <p className="font-semibold">{p.className}</p>
            <p className="mt-1">{t("clsa.page.now", { when: at(p.now) })}</p>
            <p className="text-slate-500">{t("clsa.page.was", { when: at(p.was) })}</p>
            <CancelPlace
              token={token}
              bookingId={p.bookingId}
              state={p.state}
              until={`${shortDate(localDateOf(p.validUntil, p.zone), locale, true)}, ${clockTime(new Date(p.validUntil), p.zone, locale)}`}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
