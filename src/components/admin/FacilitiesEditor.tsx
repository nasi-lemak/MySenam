"use client";

import { useState } from "react";
import { AMENITIES, AMENITY_ICONS, type Amenity } from "@/lib/facilities";
import { DICTIONARIES } from "@/lib/i18n";
import type { ManagedVenue } from "./shared";
import { useStaffT } from "./StaffLanguage";

/** The English name players see, from the same dictionary. */
export const facilityLabel = (key: string) => (DICTIONARIES.en as Record<string, string>)[`fac.${key}`] ?? key;

/**
 * What a venue has besides its courts, ticked from a fixed list so players
 * can compare venues and search by it. Optional, like everything that is not
 * needed to take a booking.
 */
export function FacilitiesEditor({
  venue,
  onSave,
}: {
  venue: ManagedVenue;
  onSave: (url: string, method: string, body: unknown, okMessage: string) => Promise<void>;
}) {
  const t = useStaffT();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Amenity[]>(venue.amenities);
  const dirty = chosen.length !== venue.amenities.length || chosen.some((a) => !venue.amenities.includes(a));
  return (
    <div className="w-full border-t border-slate-100 pt-2 text-sm">
      <button onClick={() => setOpen(!open)} className="text-xs font-medium text-teal-700 underline">
        {open ? t("fac.close") : t("fac.toggle", { n: venue.amenities.length })}
      </button>
      {!open && venue.amenities.length === 0 && (
        <span className="ml-2 text-xs text-slate-500">{t("fac.empty")}</span>
      )}
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-slate-500">{t("fac.intro")}</p>
          <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {AMENITIES.map((a) => (
              <label key={a} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={chosen.includes(a)}
                  onChange={(e) => setChosen(e.target.checked ? [...chosen, a] : chosen.filter((x) => x !== a))}
                />
                {AMENITY_ICONS[a]} {t.customer(`fac.${a}`)}
              </label>
            ))}
          </div>
          <button
            disabled={!dirty}
            onClick={() => onSave(`/api/admin/venues/${venue.id}`, "PATCH", { amenities: chosen }, t("fac.saved", { name: venue.name }))}
            className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-30"
          >
            {t("fac.save")}
          </button>
        </div>
      )}
    </div>
  );
}
