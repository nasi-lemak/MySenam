"use client";

import { useState } from "react";
import { formatMinute } from "@/lib/interval";
import type { CountedUnit } from "@/lib/counted-performances";
import type { Match, PerformanceLine, TournamentDetail } from "@/lib/tournaments";
import type { StaffText } from "@/lib/staff-text";
import { useStaffT } from "./StaffLanguage";

/**
 * A counted event's group or final, entered the way a judge stands at a wall (lib/counted-performances.ts): a row for each
 * competitor and, for each boulder, tap + for each attempt, Z at the attempt that reached the zone hold and T at the one that
 * topped it. One boulder can be shown at a time, so the buttons are big enough for a phone held at the foot of the wall. A
 * height event has one route: the highest hold, a "+" for a partial one, and the attempts.
 *
 * Saving goes through the same route as any performance result. A correction that would change who is in the final is
 * previewed first and made only as confirmed.
 */

type Call = (url: string, body: object) => Promise<{ ok: boolean; data: Record<string, unknown> }>;

interface Cell {
  a: number;
  z: number | null;
  t: number | null;
  hold: string;
  plus: boolean;
}

const BLANK: Cell = { a: 0, z: null, t: null, hold: "", plus: false };
const MAX = 99;

type Row = { status: PerformanceLine["status"]; cells: Record<number, Cell> };

function rowOf(l: PerformanceLine): Row {
  const cells: Record<number, Cell> = {};
  for (const u of (l.counts ?? []) as CountedUnit[])
    cells[u.unit] = { a: u.attempts, z: u.zone ?? u.top ?? null, t: u.top ?? null, hold: u.hold === undefined ? "" : String(u.hold), plus: u.plus === true };
  return { status: l.status === "pending" ? "ok" : l.status, cells };
}

const button = "inline-flex min-h-9 min-w-9 items-center justify-center rounded-md border px-2 text-sm font-semibold";

export function CountedHeat({ tn, m, lines, names, call }: { tn: TournamentDetail; m: Match; lines: PerformanceLine[]; names: Map<number, string>; call: Call }) {
  const t = useStaffT();
  const rules = tn.rules.performance!.counted!;
  const unitName = m.stage === "final" ? t("tn.perf.final") : t("tn.cp.group", { n: m.position });
  const [rows, setRows] = useState<Record<number, Row>>(() => Object.fromEntries(lines.map((l) => [l.entryId, rowOf(l)])));
  const [view, setView] = useState<number | "all">("all");
  const [busy, setBusy] = useState(false);

  if (lines.length === 0)
    return <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-500">{t("tn.perf.filledLater", { unit: unitName })}</div>;

  const units = Array.from({ length: rules.units }, (_, i) => i + 1);
  const shownUnits = view === "all" ? units : [view];
  const cellOf = (id: number, unit: number): Cell => rows[id]?.cells[unit] ?? BLANK;
  const change = (id: number, unit: number, patch: (c: Cell) => Cell) =>
    setRows((all) => ({ ...all, [id]: { ...all[id], cells: { ...all[id].cells, [unit]: patch(all[id].cells[unit] ?? BLANK) } } }));
  const setStatus = (id: number, status: PerformanceLine["status"]) => setRows((all) => ({ ...all, [id]: { ...all[id], status } }));

  /** The lines to send: whoever has been counted, or marked as not climbing, or had a result before (so emptying it is refused, not skipped). */
  function body(): { entryId: number; status: string; counts?: object[] }[] {
    const out: { entryId: number; status: string; counts?: object[] }[] = [];
    for (const l of lines) {
      const r = rows[l.entryId];
      if (!r) continue;
      const touched = units.some((u) => (r.cells[u]?.a ?? 0) > 0);
      if (r.status !== "ok") out.push({ entryId: l.entryId, status: r.status });
      else if (touched || l.status === "ok")
        out.push({
          entryId: l.entryId,
          status: "ok",
          counts: units
            .filter((u) => (r.cells[u]?.a ?? 0) > 0)
            .map((u) => {
              const c = r.cells[u];
              return rules.kind === "height" ? { unit: u, attempts: c.a, hold: Number(c.hold || 0), plus: c.plus } : { unit: u, attempts: c.a, zone: c.z, top: c.t };
            }),
        });
    }
    return out;
  }

  async function save() {
    setBusy(true);
    try {
      const url = `/api/admin/tournaments/${tn.id}/matches/${m.id}`;
      const performances = body();
      // What it would change first: a correction that changes who is in the final is confirmed against this.
      const preview = await call(url, { performances, preview: true });
      if (!preview.ok) return;
      const p = preview.data.preview as { consequential: boolean; token: string; changes: string[]; changePhrases?: StaffText[] };
      if (p.consequential && !window.confirm(t("tn.cp.confirmField", { changes: p.changes.map((c, i) => t.say(p.changePhrases?.[i], c)).join("\n") }))) return;
      await call(url, { performances, ...(p.consequential ? { confirm: { token: p.token } } : {}) });
    } finally {
      setBusy(false);
    }
  }

  const keyHeader = (unit: number) => (
    <th key={unit} scope="col" className="px-1 text-left text-xs font-medium text-slate-500">
      {t("tn.cp.boulder", { n: unit })}
    </th>
  );

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-sm">
      <h3 className="font-semibold">
        {unitName}{" "}
        <span className="text-xs font-normal text-slate-500">
          {m.date} {m.minute !== null && formatMinute(m.minute, t.locale)} · {m.courtName} · {m.status === "done" ? t("tn.perf.resultsIn") : t("tn.perf.toCome")}
        </span>
      </h3>
      {rules.kind === "boulders" && (
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={t("tn.cp.units")}>
          {(["all", ...units] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} className={`${button} ${view === v ? "border-teal-600 bg-teal-600 text-white" : "border-slate-300 bg-white text-slate-700"}`}>
              {v === "all" ? t("tn.cp.all") : v}
            </button>
          ))}
        </div>
      )}
      {rules.kind === "boulders" && <p className="mt-1 text-xs text-slate-500">{t("tn.cp.legend")}</p>}
      <div className="mt-2 overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr>
              <th scope="col" className="w-10 text-left text-xs font-medium text-slate-500">
                {t("tn.cp.start")}
              </th>
              <th />
              {rules.kind === "boulders" ? shownUnits.map(keyHeader) : <th scope="col" className="px-1 text-left text-xs font-medium text-slate-500">{t("tn.cp.holdHint")}</th>}
              <th scope="col" className="sr-only">
                {t("tn.perf.ok")}
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines
              .slice()
              .sort((a, b) => a.lane - b.lane)
              .map((l) => {
                const name = names.get(l.entryId) ?? "";
                const r = rows[l.entryId];
                return (
                  <tr key={l.entryId} className="border-t border-slate-100 align-middle">
                    <td className="w-10 text-xs text-slate-500">{l.lane}</td>
                    <th scope="row" className="py-1 pr-2 text-left font-normal">
                      {name}
                    </th>
                    {rules.kind === "boulders" ? (
                      shownUnits.map((unit) => {
                        const c = cellOf(l.entryId, unit);
                        const off = r?.status !== "ok";
                        return (
                          <td key={unit} className="py-1 pr-2">
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                aria-label={t("tn.cp.sub", { name, n: unit })}
                                disabled={off || c.a <= Math.max(c.z ?? 0, c.t ?? 0)}
                                onClick={() => change(l.entryId, unit, (x) => ({ ...x, a: x.a - 1 }))}
                                className={`${button} border-slate-300 bg-white disabled:opacity-40`}
                              >
                                −
                              </button>
                              <span className="w-6 text-center tabular-nums">{c.a}</span>
                              <button
                                type="button"
                                aria-label={t("tn.cp.add", { name, n: unit })}
                                disabled={off || c.t !== null || c.a >= MAX}
                                onClick={() => change(l.entryId, unit, (x) => ({ ...x, a: x.a + 1 }))}
                                className={`${button} border-slate-300 bg-white disabled:opacity-40`}
                              >
                                +
                              </button>
                              <button
                                type="button"
                                aria-label={t("tn.cp.markZone", { name, n: unit })}
                                aria-pressed={c.z !== null}
                                disabled={off || c.t !== null}
                                onClick={() => change(l.entryId, unit, (x) => (x.z !== null ? { ...x, z: null } : { ...x, a: Math.max(x.a, 1), z: Math.max(x.a, 1) }))}
                                className={`${button} disabled:opacity-60 ${c.z !== null ? "border-amber-500 bg-amber-500 text-white" : "border-slate-300 bg-white text-slate-700"}`}
                              >
                                Z{c.z !== null && <span className="ml-0.5 text-xs font-normal">{c.z}</span>}
                              </button>
                              <button
                                type="button"
                                aria-label={t("tn.cp.markTop", { name, n: unit })}
                                aria-pressed={c.t !== null}
                                disabled={off}
                                onClick={() =>
                                  change(l.entryId, unit, (x) => {
                                    if (x.t !== null) return { ...x, t: null };
                                    const at = Math.max(x.a, 1);
                                    return { ...x, a: at, t: at, z: x.z ?? at };
                                  })
                                }
                                className={`${button} disabled:opacity-60 ${c.t !== null ? "border-teal-600 bg-teal-600 text-white" : "border-slate-300 bg-white text-slate-700"}`}
                              >
                                T{c.t !== null && <span className="ml-0.5 text-xs font-normal">{c.t}</span>}
                              </button>
                            </div>
                          </td>
                        );
                      })
                    ) : (
                      <td className="py-1 pr-2">
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min={0}
                            max={200}
                            aria-label={t("tn.cp.hold", { name })}
                            disabled={r?.status !== "ok"}
                            value={cellOf(l.entryId, 1).hold}
                            onChange={(e) => change(l.entryId, 1, (x) => ({ ...x, hold: e.target.value, a: Math.max(x.a, 1) }))}
                            className="w-16 rounded border border-slate-300 px-1 py-1 text-sm"
                          />
                          <label className="inline-flex items-center gap-1 text-sm">
                            <input type="checkbox" aria-label={t("tn.cp.plus", { name })} disabled={r?.status !== "ok"} checked={cellOf(l.entryId, 1).plus} onChange={(e) => change(l.entryId, 1, (x) => ({ ...x, plus: e.target.checked, a: Math.max(x.a, 1) }))} />+
                          </label>
                          <input
                            type="number"
                            min={0}
                            max={MAX}
                            aria-label={t("tn.cp.tries", { name })}
                            disabled={r?.status !== "ok"}
                            value={cellOf(l.entryId, 1).a || ""}
                            placeholder={t("tn.cp.triesHint")}
                            onChange={(e) => change(l.entryId, 1, (x) => ({ ...x, a: Math.min(MAX, Math.max(0, Math.floor(Number(e.target.value) || 0))) }))}
                            className="w-16 rounded border border-slate-300 px-1 py-1 text-sm"
                          />
                        </div>
                      </td>
                    )}
                    <td className="whitespace-nowrap pr-2 text-right text-xs text-slate-600">
                      {l.shown ?? ""} {l.rank !== null && `(${l.rank})`}
                    </td>
                    <td>
                      <select
                        aria-label={t("tn.perf.status", { name })}
                        value={r?.status ?? "ok"}
                        onChange={(e) => setStatus(l.entryId, e.target.value as PerformanceLine["status"])}
                        className="rounded border border-slate-300 px-1 py-1 text-xs"
                      >
                        <option value="ok">{t("tn.perf.ok")}</option>
                        <option value="dns">{t("tn.perf.dns")}</option>
                        <option value="dnf">{t("tn.perf.dnf")}</option>
                        <option value="dq">{t("tn.out.disqualified")}</option>
                      </select>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      <button type="button" disabled={busy} onClick={() => void save()} className="mt-2 min-h-9 rounded-md bg-teal-600 px-4 py-1 text-xs font-semibold text-white disabled:opacity-60">
        {t("tn.perf.save")}
      </button>
    </div>
  );
}

/** How many of the field topped (and reached the zone of) each boulder, for staff: from the ranking's round. */
export function FieldCounts({ stats, suffix }: { stats: { unit: number; tops: number; zones: number; climbers: number }[]; suffix?: string }) {
  const t = useStaffT();
  if (stats.length === 0 || stats.every((s) => s.climbers === 0)) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-sm">
      <h3 className="font-semibold">{suffix ? `${t("tn.cp.fieldTitle")}: ${suffix}` : t("tn.cp.fieldTitle")}</h3>
      <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
        {stats.map((s) => (
          <li key={s.unit}>{t("tn.cp.fieldLine", { n: s.unit, tops: s.tops, climbers: s.climbers, zones: s.zones })}</li>
        ))}
      </ul>
    </div>
  );
}
