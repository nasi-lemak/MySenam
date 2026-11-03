"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import { sportLabel } from "@/lib/i18n";
import type { SeedProposal, SourceKind, StaffRatings } from "@/lib/ratings";
import { LoadFailed } from "./place";
import type { ManagedVenue } from "./shared";
import { useStaffMay } from "./StaffMay";
import { useStaffT } from "./StaffLanguage";

const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
const small = "rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:border-teal-500";
const primary = "rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700";

type Pending = { kind: "exclude"; key: string } | { kind: "lift"; id: number } | { kind: "reset"; key: string } | null;

/**
 * A venue's ratings (lib/ratings.ts), for its managers: which events count in them, who is rated, the results in the ledger, leaving a
 * result out and starting a rating again, each with a reason that goes in the activity log, and seeding a draw from ratings (a proposal
 * confirmed here). The desk is shown nothing: ratings are a manager's to shape.
 */
export function RatingsPanel({ venue }: { venue: ManagedVenue }) {
  const t = useStaffT();
  const may = useStaffMay();
  const [opened, setOpened] = useState(false);
  if (!may("ratings")) return null;
  return (
    <details className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" onToggle={(e) => setOpened((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer font-semibold">{t("rts.title")}</summary>
      {opened && <RatingsBody venue={venue} />}
    </details>
  );
}

function RatingsBody({ venue }: { venue: ManagedVenue }) {
  const t = useStaffT();
  const [data, setData] = useState<StaffRatings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState("");
  const [seeds, setSeeds] = useState<{ id: number; name: string; proposal: SeedProposal } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/ratings?venueId=${venue.id}`, { cache: "no-store" });
      const body = await readJson(res);
      if (!res.ok) throw new Error(t.err(body, t("rts.loadFailed")));
      setData(body.ratings);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("rts.loadFailed"));
    }
  }, [venue.id, t]);
  useEffect(() => {
    void load();
  }, [load]);

  async function post(body: Record<string, unknown>): Promise<boolean> {
    setError(null);
    setNotice(null);
    const res = await fetch("/api/admin/ratings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ venueId: venue.id, ...body }) });
    const out = await readJson(res);
    if (!res.ok) {
      setError(t.err(out, t("rts.loadFailed")));
      return false;
    }
    setData(out.ratings);
    setPending(null);
    setReason("");
    return true;
  }

  async function proposeSeeds(id: number, name: string) {
    setError(null);
    const res = await fetch(`/api/admin/ratings?venueId=${venue.id}&tournamentId=${id}`, { cache: "no-store" });
    const out = await readJson(res);
    if (!res.ok) return setError(t.err(out, t("rts.loadFailed")));
    if (out.seeds?.error) return setError(t.err(out.seeds, t("rts.loadFailed")));
    setSeeds({ id, name, proposal: out.seeds });
  }

  if (loadError) return <LoadFailed message={loadError} onRetry={() => void load()} />;
  if (!data) return null;
  const kindLabel = (k: SourceKind) => t(`rts.kind.${k}`);
  const reasonForm = (label: string, confirm: string, onConfirm: () => void) => (
    <div className="mt-1 flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-2">
      <label className="flex flex-col text-xs font-medium text-slate-500">
        {label}
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} className={`w-72 max-w-full ${input}`} name="ratingReason" />
      </label>
      <button type="button" className={primary} disabled={reason.trim().length < 3} onClick={onConfirm}>
        {confirm}
      </button>
      <button type="button" className={small} onClick={() => setPending(null)}>
        ×
      </button>
      <span className="w-full text-xs text-slate-500">{t("rts.reasonHint")}</span>
    </div>
  );
  const sportName = (s: string) => (t.locale === "en" ? s : sportLabel(t.customer, s));

  return (
    <div className="mt-3 space-y-5 text-sm">
      <p className="text-slate-600">{t("rts.intro")}</p>
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700">
          {error}
        </div>
      )}
      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-700">{notice}</div>}

      <section className="space-y-2">
        <h3 className="font-semibold">{t("rts.events")}</h3>
        {data.events.length === 0 ? (
          <p className="text-slate-500">{t("rts.noEvents")}</p>
        ) : (
          <ul className="space-y-1">
            {data.events.map((e) => (
              <li key={`${e.kind}${e.id}`} className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" name={`rated-${e.kind}-${e.id}`} checked={e.rated} disabled={!e.canChange} onChange={(ev) => void post({ action: "rated", kind: e.kind, id: e.id, rated: ev.target.checked })} />
                  <span className="font-medium">{e.name}</span>
                </label>
                <span className="text-xs text-slate-500">
                  {kindLabel(e.kind)} · {sportName(e.sport)} · {e.rated ? t("rts.counted", { n: e.counted }) : t("rts.rated")}
                  {!e.canChange && ` · ${t("rts.fixed")}`}
                </span>
                {e.kind === "tournament" && e.canChange && (
                  <button type="button" className={small} onClick={() => void proposeSeeds(e.id, e.name)}>
                    {t("rts.seed.btn")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {seeds && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <h4 className="font-medium">{t("rts.seed.title", { name: seeds.name })}</h4>
            {seeds.proposal.seeds.length === 0 ? (
              <p className="text-slate-500">{t("rts.seed.none")}</p>
            ) : (
              <>
                <ol className="mt-1 space-y-0.5">
                  {seeds.proposal.seeds.map((s) => (
                    <li key={s.entryId}>{t("rts.seed.line", { seed: s.seed, name: s.name, rating: s.rating })}</li>
                  ))}
                </ol>
                {seeds.proposal.unrated > 0 && <p className="mt-1 text-xs text-slate-500">{t("rts.seed.unrated", { n: seeds.proposal.unrated })}</p>}
                <p className="mt-1 text-xs text-slate-500">{t("rts.seed.note")}</p>
                <button
                  type="button"
                  className={`${primary} mt-2`}
                  onClick={async () => {
                    if (await post({ action: "seeds", tournamentId: seeds.id, seeds: seeds.proposal.seeds.map((s) => ({ entryId: s.entryId, seed: s.seed })) })) {
                      setSeeds(null);
                      setNotice(t("rts.seed.done"));
                    }
                  }}
                >
                  {t("rts.seed.apply")}
                </button>
              </>
            )}
          </div>
        )}
        {data.inBusiness && (
          <label className="flex items-center gap-1.5">
            <input type="checkbox" name="businessBoard" checked={data.businessBoard} onChange={(ev) => void post({ action: "business", allowed: ev.target.checked })} />
            {t("rts.business")}
          </label>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="font-semibold">{t("rts.pools")}</h3>
        {data.pools.length === 0 && <p className="text-slate-500">{t("rts.noPools")}</p>}
        {data.pools.map((p) => (
          <div key={`${p.sport}${p.format}`} className="overflow-x-auto">
            <h4 className="mb-1 font-medium text-slate-700">
              {sportName(p.sport)}, {t(`rts.format.${p.format}`)}
            </h4>
            <table className="w-full text-left">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th scope="col" className="py-1 pr-3">{t("rts.col.name")}</th>
                  <th scope="col" className="py-1 pr-3">{t("rts.col.rating")}</th>
                  <th scope="col" className="py-1 pr-3">{t("rts.col.played")}</th>
                  <th scope="col" className="py-1 pr-3">{t("rts.col.record")}</th>
                  <th scope="col" className="py-1"><span className="sr-only">{t("rts.resetBtn")}</span></th>
                </tr>
              </thead>
              <tbody>
                {p.subjects.map((s) => {
                  const key = `${p.sport}|${p.format}|${s.kind}|${s.id}`;
                  const name = s.label === "(junior player)" ? t("rts.junior") : s.label;
                  return (
                    <tr key={key} className="border-t border-slate-100 align-top">
                      <td className="py-1 pr-3">{name}</td>
                      <td className="py-1 pr-3 tabular-nums">
                        {s.rating}
                        {s.provisional && <span className="ml-1 text-xs text-slate-500">({t("rts.provisional")})</span>}
                      </td>
                      <td className="py-1 pr-3 tabular-nums">{s.games}</td>
                      <td className="py-1 pr-3 tabular-nums">
                        {s.wins}–{s.draws}–{s.losses}
                      </td>
                      <td className="py-1">
                        <button type="button" className={small} onClick={() => { setReason(""); setPending({ kind: "reset", key }); }}>
                          {t("rts.resetBtn")}
                        </button>
                        {pending?.kind === "reset" && pending.key === key && (
                          <>
                            {reasonForm(t("rts.resetWhy", { name }), t("rts.resetConfirm"), () => void post({ action: "reset", sport: p.sport, format: p.format, subjectKind: s.kind, subjectId: s.id, reason }))}
                            <p className="mt-1 text-xs text-slate-500">{t("rts.resetNote")}</p>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h3 className="font-semibold">{t("rts.results")}</h3>
        {data.results.length === 0 && <p className="text-slate-500">{t("rts.noResults")}</p>}
        <ul className="divide-y divide-slate-100">
          {data.results.map((r) => {
            const key = `${r.sourceKind}|${r.sourceId}|${r.sourceMatch}|${r.unitNo}`;
            return (
              <li key={key} className="py-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span>
                    <span className="font-medium">{r.eventName}</span> · {r.playedOn} · {sportName(r.sport)}, {t(`rts.format.${r.format}`)}: {r.sides.a} v {r.sides.b},{" "}
                    {r.outcome === 1 ? t("rts.outcome.a", { a: r.sides.a }) : r.outcome === 0 ? t("rts.outcome.b", { b: r.sides.b }) : t("rts.outcome.draw")} ({t(`rts.result.${r.kind}`)})
                  </span>
                  {r.excluded ? (
                    <>
                      <span className="text-xs text-slate-500">{t("rts.excluded", { by: r.excluded.by ?? "", reason: r.excluded.reason })}</span>
                      <button type="button" className={small} onClick={() => { setReason(""); setPending({ kind: "lift", id: r.excluded!.id }); }}>
                        {t("rts.liftBtn")}
                      </button>
                    </>
                  ) : (
                    <button type="button" className={small} onClick={() => { setReason(""); setPending({ kind: "exclude", key }); }}>
                      {t("rts.excludeBtn")}
                    </button>
                  )}
                </div>
                {pending?.kind === "exclude" && pending.key === key &&
                  reasonForm(t("rts.excludeWhy"), t("rts.excludeConfirm"), () => void post({ action: "exclude", sourceKind: r.sourceKind, sourceId: r.sourceId, sourceMatch: r.sourceMatch, unitNo: r.unitNo, reason }))}
                {pending?.kind === "lift" && r.excluded && pending.id === r.excluded.id && reasonForm(t("rts.liftWhy"), t("rts.liftConfirm"), () => void post({ action: "lift", exclusionId: r.excluded!.id, reason }))}
              </li>
            );
          })}
        </ul>
      </section>

      {data.resets.length > 0 && (
        <section className="space-y-1">
          <h3 className="font-semibold">{t("rts.resets")}</h3>
          <ul className="space-y-0.5 text-slate-600">
            {data.resets.map((r, i) => (
              <li key={i}>{t("rts.resetLine", { subject: r.subject.replace("(junior player)", t("rts.junior")), sport: sportName(r.sport), format: t(`rts.format.${r.format}`), reason: r.reason, by: r.by ?? "", at: r.at.slice(0, 10) })}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
