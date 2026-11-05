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

/** The words a grid needs, by a short name: the dashboard maps them to its dictionaries, an official's page to the customer dictionary's (`ofc1.cg.*`). */
export type GridKey =
  | "final" | "group" | "filledLater" | "units" | "all" | "legend" | "start" | "holdHint" | "ok" | "sub" | "add" | "markZone" | "markTop"
  | "boulder" | "hold" | "plus" | "tries" | "triesHint" | "status" | "dns" | "dnf" | "dq" | "save" | "resultsIn" | "toCome";

const STAFF_KEYS = {
  final: "tn.perf.final", group: "tn.cp.group", filledLater: "tn.perf.filledLater", units: "tn.cp.units", all: "tn.cp.all", legend: "tn.cp.legend",
  start: "tn.cp.start", holdHint: "tn.cp.holdHint", ok: "tn.perf.ok", sub: "tn.cp.sub", add: "tn.cp.add", markZone: "tn.cp.markZone", markTop: "tn.cp.markTop",
  boulder: "tn.cp.boulder", hold: "tn.cp.hold", plus: "tn.cp.plus", tries: "tn.cp.tries", triesHint: "tn.cp.triesHint", status: "tn.perf.status",
  dns: "tn.perf.dns", dnf: "tn.perf.dnf", dq: "tn.out.disqualified", save: "tn.perf.save", resultsIn: "tn.perf.resultsIn", toCome: "tn.perf.toCome",
} as const satisfies Record<GridKey, string>;

export function CountedGridCore({
  tn,
  m,
  lines,
  names,
  t,
  locale,
  onSave,
  saveLabel,
}: {
  tn: Pick<TournamentDetail, "rules">;
  m: Match;
  lines: PerformanceLine[];
  names: Map<number, string>;
  /** The words of the grid, in the reader's own language (the dashboard's dictionaries, or an official's page's). */
  t: (key: GridKey, vars?: Record<string, string | number>) => string;
  locale: string;
  /** Called with the lines to save; the grid shows itself busy until it answers. */
  onSave: (performances: { entryId: number; status: string; counts?: object[] }[]) => Promise<void>;
  saveLabel?: string;
}) {
  const rules = tn.rules.performance!.counted!;
  // A counted event played in Swiss rounds numbers a group by its round too: "Group 2.3" is round 2, group 3 (ADR 0038).
  const unitName = m.stage === "final" ? t("final") : t("group", { n: tn.rules.swiss ? `${m.round}.${m.position}` : m.position });
  const [rows, setRows] = useState<Record<number, Row>>(() => Object.fromEntries(lines.map((l) => [l.entryId, rowOf(l)])));
  const [view, setView] = useState<number | "all">("all");
  const [busy, setBusy] = useState(false);

  if (lines.length === 0)
    return <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-500">{t("filledLater", { unit: unitName })}</div>;

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
      await onSave(body());
    } finally {
      setBusy(false);
    }
  }

  const keyHeader = (unit: number) => (
    <th key={unit} scope="col" className="px-1 text-left text-xs font-medium text-slate-500">
      {t("boulder", { n: unit })}
    </th>
  );

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-sm">
      <h3 className="font-semibold">
        {unitName}{" "}
        <span className="text-xs font-normal text-slate-500">
          {m.date} {m.minute !== null && formatMinute(m.minute, locale)} · {m.courtName} · {m.status === "done" ? t("resultsIn") : t("toCome")}
        </span>
      </h3>
      {rules.kind === "boulders" && (
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={t("units")}>
          {(["all", ...units] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} className={`${button} ${view === v ? "border-teal-600 bg-teal-600 text-white" : "border-slate-300 bg-white text-slate-700"}`}>
              {v === "all" ? t("all") : v}
            </button>
          ))}
        </div>
      )}
      {rules.kind === "boulders" && <p className="mt-1 text-xs text-slate-500">{t("legend")}</p>}
      <div className="mt-2 overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr>
              <th scope="col" className="w-10 text-left text-xs font-medium text-slate-500">
                {t("start")}
              </th>
              <th />
              {rules.kind === "boulders" ? shownUnits.map(keyHeader) : <th scope="col" className="px-1 text-left text-xs font-medium text-slate-500">{t("holdHint")}</th>}
              <th scope="col" className="sr-only">
                {t("ok")}
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
                                aria-label={t("sub", { name, n: unit })}
                                disabled={off || c.a <= Math.max(c.z ?? 0, c.t ?? 0)}
                                onClick={() => change(l.entryId, unit, (x) => ({ ...x, a: x.a - 1 }))}
                                className={`${button} border-slate-300 bg-white disabled:opacity-40`}
                              >
                                −
                              </button>
                              <span className="w-6 text-center tabular-nums">{c.a}</span>
                              <button
                                type="button"
                                aria-label={t("add", { name, n: unit })}
                                disabled={off || c.t !== null || c.a >= MAX}
                                onClick={() => change(l.entryId, unit, (x) => ({ ...x, a: x.a + 1 }))}
                                className={`${button} border-slate-300 bg-white disabled:opacity-40`}
                              >
                                +
                              </button>
                              <button
                                type="button"
                                aria-label={t("markZone", { name, n: unit })}
                                aria-pressed={c.z !== null}
                                disabled={off || c.t !== null}
                                onClick={() => change(l.entryId, unit, (x) => (x.z !== null ? { ...x, z: null } : { ...x, a: Math.max(x.a, 1), z: Math.max(x.a, 1) }))}
                                className={`${button} disabled:opacity-60 ${c.z !== null ? "border-amber-500 bg-amber-500 text-white" : "border-slate-300 bg-white text-slate-700"}`}
                              >
                                Z{c.z !== null && <span className="ml-0.5 text-xs font-normal">{c.z}</span>}
                              </button>
                              <button
                                type="button"
                                aria-label={t("markTop", { name, n: unit })}
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
                            aria-label={t("hold", { name })}
                            disabled={r?.status !== "ok"}
                            value={cellOf(l.entryId, 1).hold}
                            onChange={(e) => change(l.entryId, 1, (x) => ({ ...x, hold: e.target.value, a: Math.max(x.a, 1) }))}
                            className="w-16 rounded border border-slate-300 px-1 py-1 text-sm"
                          />
                          <label className="inline-flex items-center gap-1 text-sm">
                            <input type="checkbox" aria-label={t("plus", { name })} disabled={r?.status !== "ok"} checked={cellOf(l.entryId, 1).plus} onChange={(e) => change(l.entryId, 1, (x) => ({ ...x, plus: e.target.checked, a: Math.max(x.a, 1) }))} />+
                          </label>
                          <input
                            type="number"
                            min={0}
                            max={MAX}
                            aria-label={t("tries", { name })}
                            disabled={r?.status !== "ok"}
                            value={cellOf(l.entryId, 1).a || ""}
                            placeholder={t("triesHint")}
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
                        aria-label={t("status", { name })}
                        value={r?.status ?? "ok"}
                        onChange={(e) => setStatus(l.entryId, e.target.value as PerformanceLine["status"])}
                        className="rounded border border-slate-300 px-1 py-1 text-xs"
                      >
                        <option value="ok">{t("ok")}</option>
                        <option value="dns">{t("dns")}</option>
                        <option value="dnf">{t("dnf")}</option>
                        <option value="dq">{t("dq")}</option>
                      </select>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      <button type="button" disabled={busy} onClick={() => void save()} className="mt-2 min-h-9 rounded-md bg-teal-600 px-4 py-1 text-xs font-semibold text-white disabled:opacity-60">
        {saveLabel ?? t("save")}
      </button>
    </div>
  );
}

/** The dashboard's grid: the dictionaries' words, and a save that previews a correction changing who is in the final and makes it only as confirmed. */
export function CountedHeat({ tn, m, lines, names, call }: { tn: TournamentDetail; m: Match; lines: PerformanceLine[]; names: Map<number, string>; call: Call }) {
  const st = useStaffT();
  const t = (key: GridKey, vars?: Record<string, string | number>) => st(STAFF_KEYS[key], vars);
  return (
    <CountedGridCore
      tn={tn}
      m={m}
      lines={lines}
      names={names}
      t={t}
      locale={st.locale}
      onSave={async (performances) => {
        const url = `/api/admin/tournaments/${tn.id}/matches/${m.id}`;
        // What it would change first: a correction that changes who is in the final is confirmed against this.
        const preview = await call(url, { performances, preview: true });
        if (!preview.ok) return;
        const p = preview.data.preview as { consequential: boolean; token: string; changes: string[]; changePhrases?: StaffText[] };
        if (p.consequential && !window.confirm(st("tn.cp.confirmField", { changes: p.changes.map((c, i) => st.say(p.changePhrases?.[i], c)).join("\n") }))) return;
        await call(url, { performances, ...(p.consequential ? { confirm: { token: p.token } } : {}) });
      }}
    />
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
