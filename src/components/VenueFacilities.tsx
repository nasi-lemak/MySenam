import { offeredCourts } from "@/lib/court-activities";
import { activity } from "@/lib/activity-registry";
import { ActivityGlyph } from "@/components/Glyph";
import { sportLabel, type T } from "@/lib/i18n";
import { AMENITY_ICONS, summariseCourts, type Highlight, highlightIcon } from "@/lib/facilities";
import { type Court, type Venue } from "@/lib/types";

/**
 * What a venue has, for somebody deciding where to play: per sport, how many
 * courts, what they are like and the cheapest hour — all worked out from the
 * courts — and what else is there, as the venue lists it.
 */
export function VenueFacilities({ t, venue }: { t: T; venue: Venue & { courts: Court[] } }) {
  const sports = summariseCourts(offeredCourts(venue.courts));
  if (sports.length === 0 && venue.amenities.length === 0) return null;
  const count = (label: string, n: number, of: number) => (n === 0 ? null : n === of ? label : `${label} (${n})`);
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="font-semibold">{t("fac.title")}</h2>
      <ul className="mt-2 space-y-1 text-sm text-slate-700">
        {sports.map((s) => {
          const parts = [
            t.plural("home.courts", s.courts),
            count(t("fac.indoor"), s.indoor, s.courts),
            count(t("fac.outdoor"), s.outdoor, s.courts),
            count(t("fac.aircon"), s.aircon, s.courts),
            count(t("fac.floodlit"), s.floodlit, s.courts),
            ...(activity(s.sport).surfaced ? s.surfaces.map((x) => t(`surface.${x}`)) : []),
          ].filter(Boolean);
          return (
            <li key={s.sport} className="flex flex-wrap justify-between gap-x-3">
              <span>
                <span className="font-medium">
                  <ActivityGlyph sport={s.sport} /> {sportLabel(t, s.sport)}
                </span>{" "}
                <span className="text-slate-500">· {parts.join(" · ")}</span>
              </span>
              <span className="font-medium text-teal-700">{s.from === 0 ? t("price.free") : t("home.fromRate", { rate: s.from })}</span>
            </li>
          );
        })}
      </ul>
      {venue.amenities.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2 text-xs">
          {venue.amenities.map((a) => (
            <li key={a} className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700">
              {AMENITY_ICONS[a]} {t(`fac.${a}`)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The few facts that fit on a card. */
export function Highlights({ t, items }: { t: T; items: Highlight[] }) {
  if (items.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-slate-500">
      {items.map((h) => (
        <span key={`${h.kind}:${h.key}`}>
          {highlightIcon(h)} {t(`fac.${h.key}`)}
        </span>
      ))}
    </span>
  );
}

