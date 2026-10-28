"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useT } from "@/components/Language";
import { momentClock, momentDay, momentText, region } from "@/lib/region";
import { staffLocale, staffTranslator, type StaffT } from "@/lib/staff-i18n";

/**
 * The staff dashboard's lookup, for a client component: the language the site
 * is read in, if staff screens have it (English, Malay, Chinese), else the
 * install's first. The same object until the language changes.
 */
export function useStaffT(): StaffT {
  const t = useT();
  return staffTranslator(staffLocale(t.locale), t.site);
}

/** The time zone of each venue the dashboard has, by its id. */
const VenueZones = createContext<ReadonlyMap<number, string>>(new Map());

/** Gives the screens below the zones of the venues the dashboard has, for `useStaffClock`. */
export function StaffZones({ venues, children }: { venues: readonly { id: number; timeZone?: string }[]; children: ReactNode }) {
  const zones = useMemo(() => new Map(venues.filter((v) => v.timeZone).map((v) => [v.id, v.timeZone as string])), [venues]);
  return <VenueZones.Provider value={zones}>{children}</VenueZones.Provider>;
}

export interface StaffClock {
  /** The zone a moment at this venue is read in: the venue's; with none named, the one zone all the dashboard's venues share, else the install's. */
  zone(venueId?: number | null): string;
  /** A stored moment's time of day, in the staff language: "6:30 PM", "6:30 PTG", "下午6:30". */
  time(at: string | Date, venueId?: number | null): string;
  /** A stored moment's day (YYYY-MM-DD) in the zone, not UTC's. */
  day(at: string | Date, venueId?: number | null): string;
  /** Both: "2026-10-24 6:30 PM", "2026-10-24 下午6:30". */
  when(at: string | Date, venueId?: number | null): string;
}

/**
 * Moments (when something was done, sent, paid, checked in) as staff read
 * them: in the staff language (lib/region.ts `clockTime`), in the zone of the
 * venue they happened at. Only for people: stored values, exports, sorting
 * and form inputs keep their own forms.
 */
export function useStaffClock(): StaffClock {
  const t = useStaffT();
  const zones = useContext(VenueZones);
  return useMemo(() => {
    const shared = new Set(zones.values());
    const fallback = shared.size === 1 ? [...shared][0] : region().timeZone;
    const zone = (venueId?: number | null) => (venueId != null ? zones.get(venueId) : undefined) ?? fallback;
    return {
      zone,
      time: (at, venueId) => momentClock(at, zone(venueId), t.locale),
      day: (at, venueId) => momentDay(at, zone(venueId)),
      when: (at, venueId) => momentText(at, zone(venueId), t.locale),
    };
  }, [zones, t.locale]);
}
