"use client";

import { useState } from "react";
import type { PlanTiers } from "@/lib/plans";

type Row = { name: string; upTo: string; monthlyFee: string };

const toRows = (plan: PlanTiers): Row[] =>
  plan.tiers.map((t) => ({ name: t.name, upTo: t.upTo === null ? "" : String(t.upTo), monthlyFee: String(t.monthlyFee) }));

/**
 * The platform owner's tiers by venue size. Saved, they price every venue
 * without an agreed fee of its own from the next invoice on; cleared, every
 * venue goes back to the flat default.
 */
export function PlanTiersEditor({
  plan,
  suggested,
  defaultFee,
  busy,
  onSave,
}: {
  plan: PlanTiers;
  suggested: PlanTiers;
  defaultFee: number;
  busy: boolean;
  onSave: (plan: { tiers: { name: string; upTo: number | null; monthlyFee: number }[]; extraEach: number }) => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [extra, setExtra] = useState("");
  const editing = rows !== null;

  function start(from: PlanTiers) {
    setRows(toRows(from));
    setExtra(String(from.extraEach));
  }

  function save() {
    if (!rows) return;
    onSave({
      tiers: rows.map((r) => ({ name: r.name, upTo: r.upTo.trim() === "" ? null : Number(r.upTo), monthlyFee: Number(r.monthlyFee) })),
      extraEach: Number(extra || 0),
    });
    setRows(null);
  }

  const input = "rounded-md border border-slate-300 px-2 py-1";
  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">Plans by size</h3>
        {!editing && (
          <div className="flex gap-3 text-xs font-semibold">
            <button onClick={() => start(plan.tiers.length > 0 ? plan : suggested)} className="text-teal-700 hover:underline">
              {plan.tiers.length > 0 ? "Change" : "Set tiers"}
            </button>
            {plan.tiers.length === 0 && (
              <button onClick={() => start(suggested)} className="text-teal-700 hover:underline">
                Use suggested tiers
              </button>
            )}
          </div>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Priced by the courts and rooms a venue has, counted when each month is invoiced — a court out of service all month is
        not counted. Every tier has every feature. A venue with an agreed fee of its own keeps it.
      </p>

      {!editing ? (
        plan.tiers.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">No tiers: every venue pays the flat default, RM{defaultFee}.</p>
        ) : (
          <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {plan.tiers.map((t, i) => {
              const from = i === 0 ? 1 : (plan.tiers[i - 1].upTo ?? 0) + 1;
              return (
                <li key={t.name} className="rounded-lg border border-slate-200 px-3 py-2">
                  <p className="font-semibold">{t.name}</p>
                  <p className="text-lg font-bold text-teal-700">RM{t.monthlyFee.toFixed(2)}</p>
                  <p className="text-xs text-slate-500">
                    {t.upTo === null ? `${from} or more` : from === t.upTo ? `${from}` : `${from}–${t.upTo}`} courts or rooms
                    {i === plan.tiers.length - 1 && plan.extraEach > 0 && `, then RM${plan.extraEach} for each one more`}
                  </p>
                </li>
              );
            })}
          </ul>
        )
      ) : (
        <div className="mt-3 space-y-2">
          <div className="overflow-x-auto">
            <table className="text-left text-sm">
              <thead className="text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-1 pr-2">Name</th>
                  <th className="py-1 pr-2">Up to (courts)</th>
                  <th className="py-1 pr-2">RM / month</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-2">
                      <input aria-label="Tier name" value={r.name} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className={`${input} w-28`} />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        aria-label="Up to"
                        value={r.upTo}
                        inputMode="numeric"
                        placeholder={i === rows.length - 1 ? "no limit" : ""}
                        onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, upTo: e.target.value } : x)))}
                        className={`${input} w-24`}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <input aria-label="Monthly fee" value={r.monthlyFee} inputMode="decimal" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, monthlyFee: e.target.value } : x)))} className={`${input} w-24`} />
                    </td>
                    <td className="py-1">
                      <button onClick={() => setRows(rows.filter((_, j) => j !== i))} className="text-xs text-slate-500 hover:underline">
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            onClick={() => setRows([...rows, { name: "", upTo: "", monthlyFee: "" }])}
            className="text-xs font-semibold text-teal-700 hover:underline"
          >
            + Add a tier
          </button>
          <label className="block text-sm text-slate-700">
            Past the last tier's limit, each extra court or room adds RM{" "}
            <input aria-label="Each extra" value={extra} inputMode="decimal" onChange={(e) => setExtra(e.target.value)} className={`${input} w-20`} />
          </label>
          <div className="flex gap-3">
            <button disabled={busy} onClick={save} className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              Save tiers
            </button>
            <button onClick={() => start(suggested)} className="text-xs font-semibold text-teal-700 hover:underline">
              Suggested
            </button>
            <button onClick={() => setRows(null)} className="text-xs text-slate-500 hover:underline">
              Cancel
            </button>
          </div>
          <p className="text-xs text-slate-500">
            Takes effect on the next invoice. Leave no tiers at all to go back to the flat default. Invoices already issued keep
            what they said.
          </p>
        </div>
      )}
    </div>
  );
}
