import type { Metadata } from "next";
import { RETENTION } from "@/lib/privacy";
import { serverT } from "@/lib/locale";
import type { Phrase, T } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const t = await serverT();
  return { title: t("privacy.metaTitle"), description: t("privacy.metaDescription") };
}

/**
 * The retention figure that belongs in each row, so the table cannot drift
 * away from what the code actually prunes.
 */
const HOW_LONG_VARS: Record<number, { n: number }> = {
  4: { n: RETENTION.checkInDays },
  5: { n: RETENTION.accessRevealDays },
};

function heldRows(t: T) {
  return [1, 2, 3, 4, 5, 6, 7].map((i) => ({
    what: t(`privacy.held${i}What` as Phrase),
    why: t(`privacy.held${i}Why` as Phrase),
    how: t(`privacy.held${i}How` as Phrase, HOW_LONG_VARS[i]),
  }));
}

export default async function PrivacyPage() {
  const t = await serverT();

  return (
    <div className="mx-auto max-w-2xl space-y-8 py-2">
      <header>
        <h1 className="text-2xl font-bold">{t("privacy.title")}</h1>
        <p className="mt-2 text-sm text-slate-600">{t("privacy.intro")}</p>
      </header>

      <section>
        <h2 className="text-lg font-bold">{t("privacy.heldTitle")}</h2>
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                {(["privacy.colWhat", "privacy.colWhy", "privacy.colHowLong"] as const).map((h) => (
                  <th key={h} className="px-3 py-2 font-semibold">
                    {t(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {heldRows(t).map((row) => (
                <tr key={row.what} className="border-b border-slate-100 last:border-0 align-top">
                  <td className="px-3 py-2 font-medium">{row.what}</td>
                  <td className="px-3 py-2 text-slate-600">{row.why}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-600">{row.how}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-sm text-slate-600">
          {t("privacy.anonAfter")}{" "}
          <strong>
            {t("privacy.years", { n: Math.round(RETENTION.bookingIdentityDays / 365) })}
          </strong>
          {t("privacy.anonRest")}
        </p>
      </section>

      <section>
        <h2 className="text-lg font-bold">{t("privacy.seeTitle")}</h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-slate-600">
          <li>
            <strong>{t("privacy.seeVenueLead")}</strong> {t("privacy.seeVenueBody")}
          </li>
          <li>
            <strong>{t("privacy.seeNoneLead")}</strong> {t("privacy.seeNoneBody")}
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-bold">{t("privacy.doTitle")}</h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-slate-600">
          <li>
            <strong>{t("privacy.doSeeLead")}</strong> {t("privacy.doSeeBody1")}{" "}
            <em>{t("privacy.doSeeLink")}</em> {t("privacy.doSeeBody2")}
          </li>
          <li>
            <strong>{t("privacy.doFixLead")}</strong> {t("privacy.doFixBody")}
          </li>
          <li>
            <strong>{t("privacy.doEraseLead")}</strong> <em>{t("privacy.doEraseLink")}</em>{" "}
            {t("privacy.doEraseBody")}
          </li>
          <li>
            <strong>{t("privacy.doGuestLead")}</strong> {t("privacy.doGuestBody")}
          </li>
        </ul>
      </section>

      <section className="rounded-xl border border-amber-200 bg-amber-50/70 p-4">
        <h2 className="text-sm font-bold text-amber-900">{t("privacy.draftTitle")}</h2>
        <p className="mt-1 text-sm text-amber-800">{t("privacy.draftBody")}</p>
      </section>
    </div>
  );
}
