import Link from "next/link";
import { ActivityGlyph } from "@/components/Glyph";
import type { PublicEntry } from "@/lib/entries";
import type { Phrase, T } from "@/lib/i18n";
import { money } from "@/lib/region";

/**
 * On a venue's page, each resource taking entries with no set time
 * (lib/entries.ts): no booking needed, the price of an entry at the desk, what
 * lets you in (memberships whose plan admits, passes and day passes), how full
 * it is now as a level (never who is there), and the way to check yourself in
 * where the venue allows it. Rendered on the server.
 */
export function EntryPanel({ entries, t }: { entries: PublicEntry[]; t: T }) {
  if (entries.length === 0) return null;
  return (
    <section id="entry" className="scroll-mt-20 rounded-xl border border-teal-200 bg-teal-50/50 px-4 py-3">
      <h2 className="font-semibold">{t("nbk.title")}</h2>
      <p className="mt-0.5 text-xs text-slate-600">{t("nbk.intro")}</p>
      <ul className="mt-2 space-y-3">
        {entries.map((e) => (
          <li key={e.courtId} className="text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">
                <ActivityGlyph sport={e.sport} /> {e.name}
              </span>
              <span className="text-xs text-slate-600">{t("nbk.now", { level: t(`busy.${e.level}` as Phrase) })}</span>
            </div>
            <p className="text-xs text-slate-700">{e.price !== null ? t("nbk.price", { price: money(e.price) }) : t("nbk.membersOnly")}</p>
            {(e.plans.length > 0 || e.passes.length > 0) && (
              <div className="mt-1 text-xs text-slate-600">
                <span className="font-medium">{t("nbk.admits")}:</span>{" "}
                {[
                  ...e.plans.map((name) => t("nbk.plan", { name })),
                  ...e.passes.map((p) => t(p.dayPass ? "nbk.dayPass" : "nbk.pass", { name: p.name, price: money(p.price) })),
                ].join(" · ")}
              </div>
            )}
            {e.selfCheckIn ? (
              <Link href={`/checkin/entry/${e.courtId}`} className="mt-1 inline-block text-xs font-semibold text-teal-800 underline">
                {t("nbk.selfLink")}
              </Link>
            ) : (
              <p className="mt-1 text-xs text-slate-500">{t("nbk.deskOnly")}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
