"use client";

import { useEffect, useState } from "react";
import type { T } from "@/lib/i18n";

/** The people a signed-in adult manages, as the booking forms tick them. */
export interface ManagedChoice {
  id: number;
  displayName: string;
}

/**
 * Who is taking part, ticked by a signed-in adult (lib/participant-bookings.ts;
 * ADR 0023): themself, and any of the people they manage. Each person ticked
 * takes a place of their own and is checked on their own; the adult takes
 * one only when ticked. Nothing shown to somebody who manages nobody.
 */
export function WhoTakesPart({
  t,
  people,
  ids,
  meToo,
  onChange,
}: {
  t: T;
  people: ManagedChoice[];
  ids: number[];
  meToo: boolean;
  onChange: (ids: number[], meToo: boolean) => void;
}) {
  if (people.length === 0) return null;
  const persons = ids.length + (meToo ? 1 : 0);
  return (
    <fieldset className="mt-2 text-xs text-slate-600">
      <legend className="font-medium">{t("guard.whoPlays")}</legend>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" className="accent-teal-600" checked={meToo} onChange={(e) => onChange(ids, e.target.checked)} />
          {t("guard.me")}
        </label>
        {people.map((p) => (
          <label key={p.id} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              className="accent-teal-600"
              checked={ids.includes(p.id)}
              onChange={(e) => onChange(e.target.checked ? [...ids, p.id] : ids.filter((id) => id !== p.id), meToo)}
            />
            {t("guard.bookFor", { name: p.displayName })}
          </label>
        ))}
      </div>
      {persons > 1 && <p className="mt-1 text-slate-500">{t("pbk.placesNote")}</p>}
      {persons === 0 && <p className="mt-1 font-medium text-amber-700">{t("pbk.nobody")}</p>}
    </fieldset>
  );
}

/** The people this account manages (none when signed out), for `WhoTakesPart`. */
export function useManagedPeople(signedIn: boolean): ManagedChoice[] {
  const [people, setPeople] = useState<ManagedChoice[]>([]);
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    fetch("/api/my/people", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => live && data && Array.isArray(data.people) && setPeople(data.people))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [signedIn]);
  return people;
}

/** What a request says about who takes part: nothing for the adult alone. */
export const whoBody = (ids: number[], meToo: boolean): Record<string, unknown> => (ids.length > 0 ? { participantIds: ids, customerTakesPart: meToo } : {});
