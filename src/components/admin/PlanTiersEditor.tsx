"use client";

import { useState } from "react";
import type { PlanTiers } from "@/lib/plans";
import { money, currencySymbol } from "@/lib/region";
import { useStaffT } from "./StaffLanguage";

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
  const t = useStaffT();
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
        <h3 className="font-semibold">{t("tier.title")}</h3>
        {!editing && (
          <div className="flex gap-3 text-xs font-semibold">
            <button onClick={() => start(plan.tiers.length > 0 ? plan : suggested)} className="text-teal-700 hover:underline">
              {plan.tiers.length > 0 ? t("c.change") : t("tier.set")}
            </button>
            {plan.tiers.length === 0 && (
              <button onClick={() => start(suggested)} className="text-teal-700 hover:underline">
                {t("tier.useSuggested")}
              </button>
            )}
          </div>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {t("tier.intro")}
      </p>

      {!editing ? (
        plan.tiers.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">{t("tier.none", { amount: money(defaultFee) })}</p>
        ) : (
          <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {plan.tiers.map((tier, i) => {
              const from = i === 0 ? 1 : (plan.tiers[i - 1].upTo ?? 0) + 1;
              return (
                <li key={tier.name} className="rounded-lg border border-slate-200 px-3 py-2">
                  <p className="font-semibold">{tier.name}</p>
                  <p className="text-lg font-bold text-teal-700">{money(tier.monthlyFee)}</p>
                  <p className="text-xs text-slate-500">
                    {tier.upTo === null
                      ? t("tier.rangeMore", { from })
                      : from === tier.upTo
                        ? t("tier.rangeOne", { from })
                        : t("tier.range", { from, to: tier.upTo })}
                    {i === plan.tiers.length - 1 && plan.extraEach > 0 && `, ${t("tier.thenEach", { amount: money(plan.extraEach) })}`}
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
                  <th className="py-1 pr-2">{t("c.name")}</th>
                  <th className="py-1 pr-2">{t("tier.colUpTo")}</th>
                  <th className="py-1 pr-2">{t("tier.colFee", { cur: currencySymbol() })}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-2">
                      <input aria-label={t("tier.nameLabel")} value={r.name} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className={`${input} w-28`} />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        aria-label={t("tier.upToLabel")}
                        value={r.upTo}
                        inputMode="numeric"
                        placeholder={i === rows.length - 1 ? t("tier.noLimit") : ""}
                        onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, upTo: e.target.value } : x)))}
                        className={`${input} w-24`}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <input aria-label={t("tier.feeLabel")} value={r.monthlyFee} inputMode="decimal" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, monthlyFee: e.target.value } : x)))} className={`${input} w-24`} />
                    </td>
                    <td className="py-1">
                      <button onClick={() => setRows(rows.filter((_, j) => j !== i))} className="text-xs text-slate-500 hover:underline">
                        {t("c.remove")}
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
            {t("tier.add")}
          </button>
          <label className="block text-sm text-slate-700">
            {t("tier.extraLabel")} {money(" ")}
            <input aria-label={t("tier.extraEach")} value={extra} inputMode="decimal" onChange={(e) => setExtra(e.target.value)} className={`${input} w-20`} />
          </label>
          <div className="flex gap-3">
            <button disabled={busy} onClick={save} className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              {t("tier.save")}
            </button>
            <button onClick={() => start(suggested)} className="text-xs font-semibold text-teal-700 hover:underline">
              {t("tier.suggested")}
            </button>
            <button onClick={() => setRows(null)} className="text-xs text-slate-500 hover:underline">
              {t("c.cancel")}
            </button>
          </div>
          <p className="text-xs text-slate-500">
            {t("tier.takesEffect")}
          </p>
        </div>
      )}
    </div>
  );
}
