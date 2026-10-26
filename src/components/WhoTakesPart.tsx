"use client";

import { useEffect, useState } from "react";
import type { EligibilityLine, EligibilityStatus } from "@/lib/eligibility";
import type { KindNeeds } from "@/lib/court-activities";
import type { Phrase, T } from "@/lib/i18n";
import { CUSTOMER, splitByCourt, type CourtOf } from "@/lib/people-per-court";

/**
 * Who is taking part, as a signed-in account chooses it on the search page
 * (docs/features/discovery.md#who-is-taking-part), and what an activity that
 * needs the venue's approval says for them there and on the venue's grid.
 *
 * The choice is remembered for this browser tab only (sessionStorage), never
 * on the server or in the address. Nobody chosen, or signed out: the
 * requirement only, never a guess at whose eligibility matters.
 */

const KEY = "mysenam.taking";
/** The account holder themself, beside participants' ids. */
export const SELF = "self";

/** The choice kept for this tab: `self` and participant ids. */
export function storedTaking(): string[] {
  try {
    const raw = typeof window === "undefined" ? null : window.sessionStorage.getItem(KEY);
    return raw ? raw.split(",").filter((x) => x === SELF || /^\d+$/.test(x)) : [];
  } catch {
    return [];
  }
}

function keepTaking(chosen: string[]): void {
  try {
    if (chosen.length > 0) window.sessionStorage.setItem(KEY, chosen.join(","));
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // A private window, or storage blocked: the choice lasts as long as the page.
  }
}

/** `self` first, then participants in the order the account lists them. */
export const takingParam = (chosen: string[]): string => [...chosen].sort((a, b) => (a === SELF ? -1 : b === SELF ? 1 : 0)).join(",");

export interface Person {
  id: number;
  displayName: string;
}

/**
 * The tab's choice, and the people this account manages to choose from.
 * `lazy`: ask the server only when somebody is chosen (the venue's grid, which
 * offers no choice of its own).
 */
export function useTaking(opts: { lazy?: boolean } = {}) {
  const [chosen, setChosenOnly] = useState<string[]>(storedTaking);
  const [signedIn, setSignedIn] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const lazy = opts.lazy === true;
  const wanted = !lazy || chosen.length > 0;
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    fetch("/api/my/people", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!live) return;
        if (!data || !Array.isArray(data.people)) {
          // Signed out: nothing is anybody's here.
          setSignedIn(false);
          if (!lazy && storedTaking().length > 0) {
            keepTaking([]);
            setChosenOnly([]);
          }
          return;
        }
        setSignedIn(true);
        setPeople((data.people as Person[]).map((p) => ({ id: p.id, displayName: p.displayName })));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [wanted, lazy]);
  const setChosen = (next: string[]) => {
    keepTaking(next);
    setChosenOnly(next);
  };
  return { chosen, setChosen, signedIn, people };
}

/** Choose who is taking part: myself, any of the people this account manages, or several. */
export function TakingPicker({ t, people, chosen, onChange }: { t: T; people: Person[]; chosen: string[]; onChange: (next: string[]) => void }) {
  const options = [{ key: SELF, label: t("elig.me") }, ...people.map((p) => ({ key: String(p.id), label: p.displayName }))];
  const toggle = (key: string) => onChange(chosen.includes(key) ? chosen.filter((k) => k !== key) : [...chosen, key]);
  return (
    <div className="space-y-1" data-testid="taking-picker">
      <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label={t("elig.who")}>
        <span className="text-slate-500">{t("elig.who")}</span>
        {options.map((o) => {
          const on = chosen.includes(o.key);
          return (
            <button
              key={o.key}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(o.key)}
              className={`max-w-full truncate rounded-full border px-3 py-1 ${on ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-teal-500"}`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-slate-500">{chosen.length === 0 ? t("elig.choose") : t("elig.note")}</p>
    </div>
  );
}

const STATUS: Record<EligibilityStatus, [Phrase, Phrase]> = {
  // [for a sign-off, for a certification]
  eligible: ["elig.eligible", "elig.eligible"],
  required: ["elig.required", "elig.requiredCert"],
  pending: ["elig.pending", "elig.pending"],
  info: ["elig.info", "elig.info"],
  inPerson: ["elig.inPerson", "elig.inPerson"],
  expired: ["elig.expired", "elig.expiredCert"],
};

/**
 * What a resource's rules ask for first. With each chosen person's status
 * (`lines`): each one by name, green only when every one of them may book;
 * otherwise the requirement only.
 */
export function NeedsLabel({
  t,
  needs,
  lines,
  people = [],
  variant = "badge",
}: {
  t: T;
  needs: NonNullable<KindNeeds>;
  lines?: EligibilityLine[];
  people?: Person[];
  variant?: "badge" | "line";
}) {
  const shown = lines && lines.length > 0 ? lines : null;
  const all = shown !== null && shown.every((l) => l.status === "eligible");
  const name = (l: EligibilityLine) =>
    l.participant === null ? t("elig.you") : (people.find((p) => p.id === l.participant)?.displayName ?? t("elig.other"));
  const words = shown
    ? shown.map((l) => t("elig.line", { name: name(l), status: t(STATUS[l.status][needs === "certification" ? 1 : 0]) })).join("; ")
    : t(needs === "certification" ? "grp.certification" : "grp.signOff");
  const tone = shown === null ? "violet" : all ? "emerald" : "amber";
  const colours: Record<string, [string, string]> = {
    violet: ["bg-violet-100 text-violet-700", "text-violet-700"],
    emerald: ["bg-emerald-100 text-emerald-800", "text-emerald-700"],
    amber: ["bg-amber-100 text-amber-900", "text-amber-800"],
  };
  const common = { "data-needs": needs, "data-eligibility": shown ? (all ? "eligible" : "not-all") : undefined };
  return variant === "badge" ? (
    // Named statuses can run to a few lines on a phone: a softer corner reads better there than a pill.
    <span className={`ml-1.5 inline-block px-2 py-0.5 text-xs font-semibold ${shown ? "rounded-md" : "rounded-full"} ${colours[tone][0]}`} {...common}>
      {words}
    </span>
  ) : (
    <div className={`whitespace-normal text-xs font-normal ${colours[tone][1]}`} {...common}>
      {words}
    </div>
  );
}

// ------------------------------------------------ the booking forms' choice

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

/**
 * On a booking of several courts, who is on which (lib/people-per-court.ts;
 * docs/features/booking.md#booking-for-somebody-else): each person ticked
 * on exactly one court, the court picked first unless moved; the customer,
 * where they take part, on one court too; a court with nobody named is the
 * customer's party, and says so. The same rules the server holds.
 */
export function PeoplePerCourt({
  t,
  courts,
  people,
  customer,
  customerLabel,
  courtOf,
  onChange,
}: {
  t: T;
  courts: { id: number; name: string }[];
  people: ManagedChoice[];
  /** The customer takes part (ticked themself, or the number holder at the counter). */
  customer: boolean;
  customerLabel: string;
  courtOf: CourtOf;
  onChange: (next: CourtOf) => void;
}) {
  if (people.length === 0 || courts.length < 2) return null;
  const ids = courts.map((c) => c.id);
  const split = splitByCourt({ courtIds: ids, named: people.map((p) => p.id), customerTakesPart: customer, courtOf });
  const where = (key: string) => (ids.includes(courtOf[key]) ? courtOf[key] : ids[0]);
  const rows = [...people.map((p) => ({ key: String(p.id), name: p.displayName })), ...(customer ? [{ key: CUSTOMER, name: customerLabel }] : [])];
  return (
    <fieldset className="mt-2 min-w-0 text-xs text-slate-600" data-testid="people-per-court">
      <legend className="font-medium">{t("pbk2.legend")}</legend>
      <div className="mt-1 space-y-1">
        {rows.map((r) => (
          <label key={r.key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="min-w-0 break-words font-medium text-slate-700">{r.name}</span>
            <select
              aria-label={t("pbk2.courtFor", { name: r.name })}
              value={where(r.key)}
              onChange={(e) => onChange({ ...courtOf, [r.key]: Number(e.target.value) })}
              className="max-w-full rounded-md border border-slate-300 px-1.5 py-0.5 text-xs text-slate-900"
            >
              {courts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <ul className="mt-1 space-y-0.5 text-slate-500">
        {split.map((c) => {
          const name = courts.find((x) => x.id === c.courtId)?.name ?? "";
          const names = people.filter((p) => c.participantIds.includes(p.id)).map((p) => p.displayName);
          if (c.customerTakesPart) names.push(customerLabel);
          return <li key={c.courtId}>{names.length > 0 ? t("pbk2.on", { court: name, names: names.join(", ") }) : t("pbk2.party", { court: name })}</li>;
        })}
      </ul>
      <p className="mt-1 text-slate-500">{t("pbk2.note")}</p>
    </fieldset>
  );
}
