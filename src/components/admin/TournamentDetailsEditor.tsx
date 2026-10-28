"use client";

import { readJson } from "@/lib/read-response";
import { useState } from "react";
import type { TournamentDetail } from "@/lib/tournaments";
import { currencySymbol } from "@/lib/region";
import { useStaffT } from "./StaffLanguage";

/**
 * A tournament's details before its draw (PATCH /api/admin/tournaments/:id;
 * lib/tournaments.ts `changeTournament`): name and text, the last day for
 * entries, how many it takes, and the fee for entries made from now on. Only
 * what was changed is sent.
 */
export function TournamentDetailsEditor({
  tn,
  onSaved,
  onClose,
}: {
  tn: TournamentDetail;
  onSaved: (tn: TournamentDetail, notice: string) => void;
  onClose: () => void;
}) {
  const t = useStaffT();
  const [form, setForm] = useState({
    name: tn.name,
    description: tn.description ?? "",
    entriesCloseOn: tn.entriesCloseOn ?? "",
    maxEntries: String(tn.maxEntries),
    entryFee: String(tn.entryFee),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const change: Record<string, unknown> = {};
    if (form.name.trim() !== tn.name) change.name = form.name.trim();
    if (form.description.trim() !== (tn.description ?? "")) change.description = form.description.trim() || null;
    if (form.entriesCloseOn !== (tn.entriesCloseOn ?? "")) change.entriesCloseOn = form.entriesCloseOn || null;
    if (Number(form.maxEntries) !== tn.maxEntries) change.maxEntries = Number(form.maxEntries);
    if (Number(form.entryFee) !== tn.entryFee) change.entryFee = Number(form.entryFee);
    try {
      const res = await fetch(`/api/admin/tournaments/${tn.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("p8c.tn.saveFailed")));
      onSaved(data.tournament as TournamentDetail, data.promoted > 0 ? t.plural("p8c.tn.promoted", data.promoted) : t("p8c.tn.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("p8c.tn.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const input = "mt-0.5 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  const label = "block text-xs font-medium text-slate-600";
  const hint = "mt-1 block font-normal text-slate-500";
  return (
    <form onSubmit={save} className="space-y-3 rounded-xl border border-teal-200 bg-white p-4 text-sm shadow-sm">
      <h3 className="font-semibold">{t("p8c.tn.editTitle", { name: tn.name })}</h3>
      <label className={label}>
        {t("p8c.tn.name")}
        <input required minLength={3} maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={input} />
      </label>
      <label className={label}>
        {t("p8c.tn.description")}
        <textarea rows={3} maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={input} />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className={label}>
          {t("p8c.tn.closeOn")}
          <input type="date" value={form.entriesCloseOn} max={tn.startsOn} onChange={(e) => setForm({ ...form, entriesCloseOn: e.target.value })} className={input} />
        </label>
        <label className={label}>
          {t("p8c.tn.maxEntries")}
          <input required type="number" min={2} max={128} value={form.maxEntries} onChange={(e) => setForm({ ...form, maxEntries: e.target.value })} className={input} />
        </label>
        <label className={label}>
          {t("p8c.tn.fee", { cur: currencySymbol() })}
          <input required type="number" min={0} step={0.01} value={form.entryFee} onChange={(e) => setForm({ ...form, entryFee: e.target.value })} className={input} />
        </label>
      </div>
      <p className={hint}>{t("p8c.tn.closeHint")}</p>
      <p className={hint}>{t("p8c.tn.maxHint", { n: tn.entered })}</p>
      <p className={hint}>{t("p8c.tn.feeHint")}</p>
      {error && <p className="font-medium text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="rounded-lg bg-teal-600 px-4 py-2 font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
          {t("p8c.tn.save")}
        </button>
        <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2">
          {t("c.close")}
        </button>
      </div>
    </form>
  );
}
