"use client";

import { readJson } from "@/lib/read-response";
import { useState } from "react";
import Link from "next/link";
import { useT } from "@/components/Language";
import { hasPhrase, translateError, type Phrase, type T } from "@/lib/i18n";
import type { MembershipPlan, OfferedFor } from "@/lib/membership-plans";
import type { Renewal } from "@/lib/payments";
import { money } from "@/lib/region";

/** Where this visitor stands, worked out on the server. */
export type JoinStanding =
  | { kind: "signIn" }
  | { kind: "noPhone" }
  | { kind: "join" }
  | { kind: "renew"; until: string }
  | { kind: "early"; until: string; from: string };

/** Somebody this account acts for now: an active relationship, not paused or archived. */
export interface Dependant {
  id: number;
  name: string;
}

/** A family membership this account bought online here, whose dependants it can change. */
export interface FamilyMembership {
  id: number;
  code: string;
  expiresOn: string;
  limit: number;
  covers: Dependant[];
  /**
   * Its places this term (lib/membership-purchases.ts `coverStanding`): how
   * many more people can be put on before the next term, whether it renews by
   * itself, and whom its next term names where that was chosen.
   */
  standing?: { left: number; renews: boolean; nextCovers: Dependant[] | null };
}

/** A membership here that renews itself, and whose it is (null: this account's own, or its family's). */
export type RenewalView = Renewal & { holderParticipantId?: number | null; holderName?: string | null };

interface Quote {
  price: number;
  startsOn: string;
  expiresOn: string;
  renewing: boolean;
  holder: Dependant | null;
  covers: Dependant[];
}

type Choice = { planId: number; participantId: number | null; covers: number[] };

/** A refusal about buying a membership, in the customer's language: by its code where it has one. */
function explain(t: T, body: { error?: string; code?: string; vars?: Record<string, string | number> } | null): string {
  if (body?.code && hasPhrase(`mbo.err.${body.code}`)) return t(`mbo.err.${body.code}` as Phrase, body.vars);
  if (body?.code && hasPhrase(`mb6.err.${body.code}`)) return t(`mb6.err.${body.code}` as Phrase, body.vars);
  return translateError(t, body as { error: string }) || t("pay.failed");
}

const offeredFor = (p: MembershipPlan): OfferedFor => p.offeredFor ?? "account";

/**
 * A venue's membership plans, joined or renewed online and paid to the venue:
 * for this account, for somebody it looks after, or a family membership
 * naming the people it covers (lib/membership-purchases.ts). The price and
 * dates are shown before paying; the membership is made once it is paid.
 */
export default function JoinMembership({
  venueId,
  plans,
  standing,
  canAutoRenew = false,
  renewal = null,
  renewals,
  people = [],
  families = [],
}: {
  venueId: number;
  plans: MembershipPlan[];
  standing: JoinStanding;
  /** The venue's gateway can charge each period by itself. */
  canAutoRenew?: boolean;
  /** This visitor's membership here already renews itself. */
  renewal?: Renewal | null;
  /** Every membership of this visitor's here that renews itself, with whose it is. */
  renewals?: RenewalView[];
  /** The people this account looks after now. */
  people?: Dependant[];
  /** Family memberships this account bought here. */
  families?: FamilyMembership[];
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRenew, setAutoRenew] = useState(false);
  const [renewing, setRenewing] = useState<RenewalView[]>(renewals ?? (renewal ? [renewal] : []));
  const [stopped, setStopped] = useState(false);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [family, setFamily] = useState(families);
  const [saved, setSaved] = useState<number | null>(null);

  async function stop(r: RenewalView) {
    setError(null);
    try {
      const res = await fetch(`/api/my/membership?renewal=${r.id}`, { method: "DELETE" });
      const data = await readJson(res);
      if (!res.ok) throw new Error(translateError(t, data) || t("pay.failed"));
      setRenewing(renewing.filter((x) => x.id !== r.id));
      setStopped(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pay.failed"));
    }
  }

  /** What is sent for a choice: whom it is for only where somebody is named. */
  const bodyOf = (c: Choice) => ({
    planId: c.planId,
    ...(c.participantId !== null ? { participantId: c.participantId } : {}),
    ...(c.covers.length > 0 ? { covers: c.covers } : {}),
  });

  async function askQuote(c: Choice) {
    setBusy(true);
    setError(null);
    setQuote(null);
    try {
      const res = await fetch("/api/my/membership/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyOf(c)),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(explain(t, data));
      setQuote(data as Quote);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pay.failed"));
    } finally {
      setBusy(false);
    }
  }

  function choose(p: MembershipPlan) {
    const c: Choice = { planId: p.id, participantId: null, covers: [] };
    setChoice(c);
    setQuote(null);
    setError(null);
    // Nobody to choose: the price and dates at once.
    if (offeredFor(p) === "account") void askQuote(c);
  }

  async function pay(c: Choice) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/my/membership", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...bodyOf(c), autoRenew: canAutoRenew && autoRenew }),
      });
      const data = await readJson(res);
      if (!res.ok || typeof data.url !== "string") throw new Error(explain(t, data));
      window.location.assign(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pay.failed"));
      setBusy(false);
    }
  }

  /** Whom a family membership covers from now, or (`at: "renewal"`) from its next term. */
  async function changeCovers(f: FamilyMembership, covers: number[], at: "now" | "renewal" = "now") {
    setError(null);
    setSaved(null);
    try {
      const res = await fetch("/api/my/membership", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ membershipId: f.id, covers, ...(at === "renewal" ? { at } : {}) }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(explain(t, data));
      const now = (data.membership?.covers ?? []) as Dependant[];
      setFamily(family.map((x) => (x.id === f.id ? { ...x, covers: now, ...(data.standing ? { standing: data.standing } : {}) } : x)));
      setSaved(f.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pay.failed"));
    }
  }

  const signedIn = standing.kind !== "signIn" && standing.kind !== "noPhone";
  // The account's own membership renewing by itself: nothing more to pay for it, or its family, here.
  const selfRenews = renewing.some((r) => (r.holderParticipantId ?? null) === null);
  const renewsFor = new Set(renewing.map((r) => r.holderParticipantId).filter((x): x is number => typeof x === "number"));
  const canChoose = (p: MembershipPlan): boolean => {
    if (!signedIn) return false;
    const f = offeredFor(p);
    if (f === "participant") return true;
    if (selfRenews && (f === "account" || f === "family")) return false;
    // Too early to renew one's own: still free to buy for somebody they look after.
    return standing.kind !== "early" || f !== "account";
  };
  const forLabel = (p: MembershipPlan): string | null => {
    const f = offeredFor(p);
    return f === "participant"
      ? t("mbo.forParticipant")
      : f === "individual"
        ? t("mbo.forIndividual")
        : f === "family"
          ? t("mbo.forFamily", { n: p.familyLimit ?? 0 })
          : null;
  };

  function chooser(p: MembershipPlan, c: Choice) {
    const f = offeredFor(p);
    const eligible = people.filter((x) => !renewsFor.has(x.id));
    const limit = p.familyLimit ?? 0;
    const update = (next: Choice) => {
      setChoice(next);
      setQuote(null);
    };
    return (
      <div className="mt-2 rounded-lg border border-violet-100 bg-violet-50/50 p-3">
        {(f === "participant" || f === "individual") && (
          <fieldset>
            <legend className="font-medium text-slate-700">{t("mbo.whoFor")}</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {f === "individual" && (!selfRenews && standing.kind !== "early") && (
                <label className="flex items-center gap-1.5">
                  <input type="radio" name={`who-${p.id}`} checked={c.participantId === null} onChange={() => update({ ...c, participantId: null })} />
                  {t("mbo.me")}
                </label>
              )}
              {eligible.map((x) => (
                <label key={x.id} className="flex items-center gap-1.5">
                  <input type="radio" name={`who-${p.id}`} checked={c.participantId === x.id} onChange={() => update({ ...c, participantId: x.id })} />
                  {x.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {f === "family" && (
          <fieldset>
            <legend className="font-medium text-slate-700">{t("mbo.covers", { n: limit })}</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {eligible.map((x) => {
                const on = c.covers.includes(x.id);
                return (
                  <label key={x.id} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!on && c.covers.length >= limit}
                      onChange={() => update({ ...c, covers: on ? c.covers.filter((id) => id !== x.id) : [...c.covers, x.id] })}
                    />
                    {x.name}
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}
        {f !== "account" && eligible.length === 0 && (
          <p className="text-slate-600">
            {t("mbo.noPeople")}{" "}
            <Link href="/account" className="font-semibold text-violet-800 underline">
              {t("mbo.addPeople")}
            </Link>
          </p>
        )}
        {f !== "account" && !quote && (
          <button
            onClick={() => askQuote(c)}
            disabled={busy || (f === "participant" && c.participantId === null) || (f === "family" && c.covers.length === 0)}
            className="mt-2 rounded-lg border border-violet-300 bg-white px-3 py-1.5 font-semibold text-violet-800 hover:bg-violet-50 disabled:opacity-50"
          >
            {t("mbo.quote")}
          </button>
        )}
        {quote && (
          <div className="mt-2 space-y-1">
            <p className="font-medium text-slate-800">
              {t("mbo.summary", {
                plan: p.name,
                who: quote.holder ? quote.holder.name : quote.covers.length > 0 ? [t("mbo.me"), ...quote.covers.map((x) => x.name)].join(", ") : t("mbo.me"),
                from: quote.startsOn,
                to: quote.expiresOn,
              })}
            </p>
            {quote.renewing && <p className="text-slate-600">{t("mbo.runsOn")}</p>}
            <p className="text-xs text-slate-500">{t("mbo.payNote")}</p>
            <button
              onClick={() => pay(c)}
              disabled={busy}
              className="rounded-lg bg-violet-600 px-3 py-1.5 font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {t("mbo.pay", { price: quote.price })}
            </button>
          </div>
        )}
        <button onClick={() => { setChoice(null); setQuote(null); }} className="ml-3 mt-2 text-xs text-slate-500 underline">
          {t("mbo.cancel")}
        </button>
      </div>
    );
  }

  const anyChoosable = plans.some(canChoose);
  return (
    <section className="rounded-xl border border-violet-200 bg-white px-4 py-3 text-sm shadow-sm">
      <h2 className="font-semibold text-violet-900">
        🎟️ {standing.kind === "renew" || standing.kind === "early" ? t("member.renewTitle") : t("member.joinTitle")}
      </h2>
      <p className="mt-0.5 text-slate-600">
        {standing.kind === "renew"
          ? t("member.renewBody", { until: standing.until })
          : standing.kind === "early"
            ? t("member.earlyBody", { until: standing.until, from: standing.from })
            : t("member.joinBody")}
      </p>
      <ul className="mt-2 space-y-1.5">
        {plans.map((p) => (
          <li key={p.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <span className="font-medium">{p.name}</span>{" "}
                <span className="text-slate-500">· {t.plural("member.months", p.months)}</span>
                {/* A tier's own benefits, where it has them. */}
                {p.ratePercent !== null && <span className="text-violet-700"> · {t("member.tierRate", { pct: 100 - p.ratePercent })}</span>}
                {p.aheadDays !== null && <span className="text-violet-700"> · {t("member.tierAhead", { n: p.aheadDays })}</span>}
                {forLabel(p) && <span className="block text-xs text-slate-500">{forLabel(p)}</span>}
              </span>
              {canChoose(p) && choice?.planId !== p.id ? (
                <button
                  onClick={() => choose(p)}
                  disabled={busy}
                  className="rounded-lg bg-violet-600 px-3 py-1.5 font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
                >
                  {t(standing.kind === "renew" && offeredFor(p) !== "participant" ? "member.renew" : "member.join", { price: p.price })}
                </button>
              ) : (
                choice?.planId !== p.id && <span className="font-semibold">{money(p.price)}</span>
              )}
            </div>
            {choice?.planId === p.id && chooser(p, choice)}
          </li>
        ))}
      </ul>
      {standing.kind === "signIn" && (
        <Link
          href={`/login?next=${encodeURIComponent(`/venue/${venueId}`)}`}
          className="mt-2 inline-block font-semibold text-violet-800 underline"
        >
          {t("member.signIn")}
        </Link>
      )}
      {standing.kind === "noPhone" && (
        <Link href="/account" className="mt-2 inline-block font-semibold text-violet-800 underline">
          {t("member.noPhone")}
        </Link>
      )}
      {anyChoosable && canAutoRenew && (
        <label className="mt-2 flex items-center gap-2 text-slate-700">
          <input type="checkbox" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} />
          {t("member.autoRenew")}
        </label>
      )}
      {renewing.map((r) => (
        <div key={r.id} className="mt-2 flex flex-wrap items-center gap-2 text-slate-700">
          <span>
            {r.holderName ? t("mbo.renewingFor", { name: r.holderName, until: r.until ?? "—" }) : t("member.renewing", { until: r.until ?? "—" })}
          </span>
          <button onClick={() => stop(r)} className="font-semibold text-violet-800 underline">
            {t("member.stopRenewing")}
          </button>
        </div>
      ))}
      {stopped && <p className="mt-2 text-emerald-700">{t("member.stopped")}</p>}
      {family.map((f) => {
        const others = people.filter((x) => !f.covers.some((c) => c.id === x.id));
        // This term's places (lib/membership-purchases.ts): taking somebody off gives none back.
        const left = f.standing?.left ?? f.limit;
        const next = f.standing?.nextCovers ?? f.covers;
        return (
          <div key={f.id} className="mt-3 rounded-lg border border-violet-100 p-3">
            <p className="font-medium text-slate-800">{t("mbo.familyTitle", { code: f.code, until: f.expiresOn })}</p>
            {f.covers.length === 0 ? (
              <p className="text-slate-600">{t("mbo.familyNone")}</p>
            ) : (
              <ul className="mt-1 flex flex-wrap gap-2">
                {f.covers.map((c) => (
                  <li key={c.id} className="flex items-center gap-1 rounded bg-violet-50 px-2 py-0.5">
                    {c.name}
                    <button
                      onClick={() => changeCovers(f, f.covers.filter((x) => x.id !== c.id).map((x) => x.id))}
                      aria-label={t("mbo.familyRemove", { name: c.name })}
                      className="text-violet-800"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {f.covers.length < f.limit && others.length > 0 && left > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {others.map((x) => (
                  <button
                    key={x.id}
                    onClick={() => changeCovers(f, [...f.covers.map((c) => c.id), x.id])}
                    className="rounded border border-violet-300 px-2 py-0.5 text-violet-800 hover:bg-violet-50"
                  >
                    {t("mbo.familyAdd", { name: x.name })}
                  </button>
                ))}
              </div>
            ) : f.covers.length >= f.limit ? (
              <p className="mt-1 text-xs text-slate-500">{t("mbo.familyFull", { n: f.limit })}</p>
            ) : (
              others.length > 0 && <p className="mt-1 text-xs text-slate-500">{t("mb6.noPlaces")}</p>
            )}
            {f.standing && left > 0 && <p className="mt-1 text-xs text-slate-500">{t.plural("mb6.placesLeft", left)}</p>}
            {f.standing?.renews && (
              <div className="mt-2 text-xs text-slate-600">
                <p>{next.length > 0 ? t("mb6.nextTerm", { names: next.map((x) => x.name).join(", ") }) : t("mb6.nextTermNone")}</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  {people.map((x) => {
                    const on = next.some((c) => c.id === x.id);
                    if (!on && next.length >= f.limit) return null;
                    return (
                      <button
                        key={x.id}
                        onClick={() => changeCovers(f, on ? next.filter((c) => c.id !== x.id).map((c) => c.id) : [...next.map((c) => c.id), x.id], "renewal")}
                        className="rounded border border-violet-200 px-2 py-0.5 text-violet-800 hover:bg-violet-50"
                      >
                        {on ? t("mb6.nextOff", { name: x.name }) : t("mb6.nextOn", { name: x.name })}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <p className="mt-1 text-xs text-slate-500">{t("mbo.familyPrice")}</p>
            {saved === f.id && <p className="mt-1 text-xs text-emerald-700">{t("mbo.familySaved")}</p>}
          </div>
        );
      })}
      {anyChoosable && <p className="mt-2 text-xs text-slate-500">{t("member.how")}</p>}
      {error && <p className="mt-1 text-xs font-medium text-red-700">{error}</p>}
    </section>
  );
}
