import Link from "next/link";
import type { Phrase, T } from "@/lib/i18n";
import { ACTIVITY_CATEGORIES, BUILTIN_ACTIVITIES } from "@/lib/activity-catalogue";
import { BUSINESS_TYPES } from "@/lib/guide/business-types";
import { activityName } from "@/lib/guide/public/present";
import type { Selection } from "@/lib/guide/public/select";
import { BUSINESS_TONES } from "@/lib/icons/glyphs";
import { ActivityGlyph, GlyphTile } from "@/components/Glyph";

/**
 * The picker: the kinds of business, several at once, and the activities to
 * refine by (docs/features/venue-guide.md#the-public-guide).
 *
 * A plain form that asks the same page again (`GET /for-venues?types=…`): it
 * works with no script at all, and what it asks for is in the address, so a
 * choice can be shared, bookmarked and reloaded. Every box is inside its own
 * label, with a target well over 24 pixels. Nothing here writes anything.
 */

const BOX = "inline-flex min-h-9 w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm hover:border-teal-600";

export default function FitPicker({ selection, t, showCards }: { selection: Selection; t: T; showCards: boolean }) {
  const types = new Set<string>(selection.types);
  const activities = new Set(selection.activities);
  return (
    <div className="space-y-6">
      <form method="get" action="/for-venues" className="space-y-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="mb-2 p-0 font-semibold text-slate-900">{t("fit.picker.legend")}</legend>
          <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2 lg:grid-cols-3">
            {BUSINESS_TYPES.map((b) => (
              <li key={b.id}>
                <label className={BOX}>
                  <input type="checkbox" name="types" value={b.id} defaultChecked={types.has(b.id)} className="h-4 w-4 shrink-0 accent-teal-700" />
                  <GlyphTile name={`business/${b.id}`} tone={BUSINESS_TONES[b.id]} size={32} />
                  <span>{t(b.titleKey)}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <details open={activities.size > 0} className="rounded-lg border border-slate-200 px-3 py-2">
          <summary className="min-h-9 cursor-pointer py-1.5 font-semibold text-slate-900">{t("fit.picker.activities")}</summary>
          <p className="m-0 mt-1 text-sm text-slate-600">{t("fit.picker.activitiesHint")}</p>
          <div className="mt-3 space-y-4">
            {ACTIVITY_CATEGORIES.map((cat) => {
              const rows = BUILTIN_ACTIVITIES.filter((a) => a.category === cat);
              if (rows.length === 0) return null;
              return (
                <fieldset key={cat} className="m-0 min-w-0 border-0 p-0">
                  <legend className="mb-1 p-0 text-sm font-medium text-slate-600">{t(`fit.cat.${cat}` as Phrase)}</legend>
                  <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2 lg:grid-cols-3">
                    {rows.map((a) => (
                      <li key={a.key}>
                        <label className={BOX}>
                          <input type="checkbox" name="activities" value={a.key} defaultChecked={activities.has(a.key)} className="h-4 w-4 shrink-0 accent-teal-700" />
                          <ActivityGlyph sport={a.key} className="text-slate-600" />
                          <span>{activityName(t, a.key)}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              );
            })}
          </div>
        </details>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="inline-flex min-h-10 items-center rounded-lg bg-teal-700 px-4 font-semibold text-white hover:bg-teal-800">
            {t("fit.picker.submit")}
          </button>
          <Link href="/for-venues" className="inline-flex min-h-9 items-center rounded-md px-2 text-sm font-medium text-teal-800 underline">
            {t("fit.picker.clear")}
          </Link>
        </div>
      </form>
      {showCards && (
        <section aria-labelledby="fit-cards">
          <h2 id="fit-cards" className="text-lg font-bold text-slate-900">
            {t("fit.picker.cards")}
          </h2>
          <ul className="m-0 mt-3 grid list-none gap-2 p-0 sm:grid-cols-2 lg:grid-cols-3">
            {BUSINESS_TYPES.map((b) => (
              <li key={b.id}>
                <Link href={`/for-venues/${b.id}`} className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-teal-800 hover:border-teal-600">
                  <GlyphTile name={`business/${b.id}`} tone={BUSINESS_TONES[b.id]} size={32} />
                  {t(b.titleKey)}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
