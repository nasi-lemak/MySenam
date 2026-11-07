"use client";

import { comparePassesForUse, planPassSpends, planTotals, type PassPlan, type PlanPass, type PlanPlace } from "@/lib/pass-rules";

/** A pass as the allocation shows it: what it is, whose, and what is left on it. */
export type AllocPass = PlanPass & { name: string };

/** The words, in the reader's language: the booking form's (customer) or the counter's (staff). */
export interface AllocationWords {
  title: string;
  /** The choice of one pass for the whole booking. */
  whole: string;
  /** The choice of a pass for each person. */
  each: string;
  none: string;
  option: (pass: AllocPass) => string;
  uses: (pass: AllocPass, units: number) => string;
  short: string;
  ready: string;
  /** Why the plan cannot pay for the booking, said from its refusal code (`ENT_PASS_*`). */
  explain: (plan: Extract<PassPlan, { ok: false }>) => string;
}

const EACH = "__each";

/**
 * Which pass pays for whom (ADR 0025): one pass for the whole booking, or one
 * person's own pass for each place, with what each spends of what it has
 * left, and why it cannot pay where it cannot. The plan is the booking
 * engine's own (lib/pass-rules.ts `planPassSpends`): nothing is decided here
 * that the server does not decide again when it spends them.
 *
 * `codes` is the choice: one pass's code, or one code per person.
 */
export default function PassAllocation({
  places,
  passes,
  players,
  minutes,
  weeks = 1,
  soldByPlace,
  bookerName,
  codes,
  onChange,
  words,
}: {
  /** The places on the booking, in its order: the customer's own, and each participant's. */
  places: PlanPlace[];
  passes: AllocPass[];
  players: number;
  minutes: number;
  /** Weeks of a weekly booking, each paid for again. */
  weeks?: number;
  soldByPlace: boolean;
  bookerName: string;
  codes: string[];
  onChange: (codes: string[]) => void;
  words: AllocationWords;
}) {
  // Offered in the one order passes are used by default: the soonest to end first (lib/pass-rules.ts).
  const ordered = [...passes].sort(comparePassesForUse);
  const whole = ordered.filter((p) => p.scope !== "participant");
  const ownOf = (place: PlanPlace) =>
    ordered.filter((p) => p.scope === "participant" && (p.holderParticipantId ? p.holderParticipantId === place.participantId : place.customer));
  const anyOwn = places.some((p) => ownOf(p).length > 0);
  const byCode = new Map(passes.map((p) => [p.code, p]));
  const chosen = codes.map((c) => byCode.get(c)).filter((p): p is AllocPass => !!p);
  const eachMode = chosen.length > 0 ? chosen.every((p) => p.scope === "participant") : codes.includes(EACH);
  const mode = eachMode ? EACH : (chosen[0]?.code ?? "");
  // Each person's pass, by their place.
  const perPlace = places.map((place) => chosen.find((p) => p.scope === "participant" && ownOf(place).some((o) => o.code === p.code))?.code ?? "");
  const real = codes.filter((c) => c !== EACH);
  const plan = real.length > 0 ? planPassSpends({ passes: real.map((c) => byCode.get(c)!).filter(Boolean), places, players, minutes, soldByPlace, bookerName }) : null;
  const totals = plan && plan.ok ? planTotals(plan.spends.map((s) => ({ ...s, units: s.units * Math.max(1, weeks) }))) : [];
  const usesOf = (code: string) => totals.find((t) => t.pass.code === code);

  if (whole.length === 0 && !anyOwn) return null;
  return (
    <fieldset className="mt-1 text-xs text-slate-600" data-testid="pass-allocation">
      <legend className="sr-only">{words.title}</legend>
      <select
        aria-label={words.title}
        value={mode}
        onChange={(e) => onChange(e.target.value === "" ? [] : [e.target.value])}
        className="rounded-md border border-slate-300 px-2 py-1 focus:border-teal-500 focus:outline-none"
      >
        <option value="">{words.none}</option>
        {whole.length > 0 && (
          <optgroup label={words.whole}>
            {whole.map((p) => (
              <option key={p.id} value={p.code}>
                {words.option(p)}
              </option>
            ))}
          </optgroup>
        )}
        {anyOwn && <option value={EACH}>{words.each}</option>}
      </select>
      {mode !== "" && mode !== EACH && usesOf(mode) && (
        <span className={`ml-2 ${usesOf(mode)!.enough ? "text-slate-500" : "font-medium text-amber-700"}`}>
          {usesOf(mode)!.enough ? words.uses(usesOf(mode)!.pass, usesOf(mode)!.units) : words.short}
        </span>
      )}
      {mode === EACH && (
        <ul className="mt-1 space-y-1">
          {places.map((place, i) => {
            const own = ownOf(place);
            const code = perPlace[i];
            const use = code ? usesOf(code) : undefined;
            const label = place.name ?? bookerName;
            return (
              <li key={`${place.participantId ?? "me"}-${i}`} className="flex flex-wrap items-center gap-2">
                <span className="min-w-[6rem] font-medium text-slate-700">{label}</span>
                <select
                  aria-label={label}
                  value={code}
                  onChange={(e) => {
                    const next = [...perPlace];
                    next[i] = e.target.value;
                    const picked = next.filter((c) => c !== "");
                    onChange(picked.length > 0 ? picked : [EACH]);
                  }}
                  className="rounded-md border border-slate-300 px-2 py-1 focus:border-teal-500 focus:outline-none"
                >
                  <option value="">{words.none}</option>
                  {own.map((p) => (
                    <option key={p.id} value={p.code}>
                      {words.option(p)}
                    </option>
                  ))}
                </select>
                {use && <span className={use.enough ? "text-slate-500" : "font-medium text-amber-700"}>{use.enough ? words.uses(use.pass, use.units) : words.short}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {plan && !plan.ok && <p className="mt-1 font-medium text-amber-700">{words.explain(plan)}</p>}
      {plan && plan.ok && mode === EACH && totals.every((t) => t.enough) && <p className="mt-1 text-emerald-700">{words.ready}</p>}
    </fieldset>
  );
}

/** The codes to send: the choice without the marker for "a pass for each person" chosen but none picked yet. */
export function passCodesOf(codes: string[]): string[] {
  return codes.filter((c) => c !== EACH);
}
