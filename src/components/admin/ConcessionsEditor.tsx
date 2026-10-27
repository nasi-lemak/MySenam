"use client";

import { activityKeys } from "@/lib/activity-registry";
import { sportLabel } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";
import { type Sport } from "@/lib/types";
import { CONCESSION_PRESETS, type ConcessionPreset } from "@/lib/concessions-shared";
import { useStaffT } from "./StaffLanguage";
import { withMarks } from "./ResourcesEditor";

interface Concession {
  id: number;
  name: string;
  percent: number;
  proof: string;
  sport: Sport | null;
  offPeakOnly: boolean;
  /** A built-in one used unchanged: customers read it in their own language. */
  preset: ConcessionPreset | null;
  /** The whole booking, or one person's place on a booking priced by the place (lib/entitlements.ts). */
  scope?: "booking" | "participant";
}

/**
 * Concession prices (lib/concessions.ts): student, senior, child or OKU, as a
 * share off. Customers pick one at booking and show proof at the counter; the
 * proof is looked at, never kept.
 */
export function ConcessionsEditor({ venueId }: { venueId: number }) {
  const t = useStaffT();
  // Suggestions to start from, shown in the staff's language. One saved as it
  // is keeps its key, and each customer reads it in their own language; once
  // its name or proof is changed, it is the venue's own text, shown as typed.
  const PERCENT: Record<ConcessionPreset, number> = { student: 20, senior: 30, child: 50, oku: 50 };
  const presets = CONCESSION_PRESETS.map((key) => ({ key, name: t(`con.preset.${key}`), percent: PERCENT[key], proof: t(`con.proof.${key}`) }));
  const nameOf = (c: Concession) => (c.preset ? t(`con.preset.${c.preset}`) : c.name);
  const proofOf = (c: Concession) => (c.preset ? t(`con.proof.${c.preset}`) : c.proof);
  const [list, setList] = useState<Concession[] | null>(null);
  const [form, setForm] = useState<{
    name: string;
    percent: string;
    proof: string;
    sport: string;
    offPeakOnly: boolean;
    preset: ConcessionPreset | null;
    scope: "booking" | "participant";
  }>({ name: "", percent: "20", proof: "", sport: "", offPeakOnly: false, preset: null, scope: "booking" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/concessions?venueId=${venueId}`, { cache: "no-store" });
    const data = await res.json();
    if (res.ok) setList(data.concessions);
  }, [venueId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    setBusy(true);
    setError(null);
    // Still the built-in one word for word? Then customers read it in their own language.
    const p = form.preset;
    const unchanged = p && form.name.trim() === t(`con.preset.${p}`) && form.proof.trim() === t(`con.proof.${p}`) ? p : null;
    try {
      const res = await fetch("/api/admin/concessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, ...form, percent: Number(form.percent), sport: form.sport || null, preset: unchanged }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      setForm({ name: "", percent: "20", proof: "", sport: "", offPeakOnly: false, preset: null, scope: "booking" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(c: Concession) {
    if (!window.confirm(t("con.withdrawConfirm", { name: nameOf(c) }))) return;
    const res = await fetch(`/api/admin/concessions?venueId=${venueId}&id=${c.id}`, { method: "DELETE" });
    if (!res.ok) setError(t.err(await res.json()));
    await load();
  }

  if (!list) return null;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <h3 className="font-semibold">{t("con.title")}</h3>
      <p className="mt-1 text-xs text-slate-500">
        {withMarks(t("con.intro"), { seen: <em>{t("con.proofSeen")}</em>, none: <em>{t("con.noProof")}</em> })}
      </p>
      {list.length > 0 && (
        <ul className="mt-3 space-y-1">
          {list.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{nameOf(c)}</span>
              <span className="text-slate-600">
                {t("con.percentOff", { percent: c.percent })}
                {c.sport ? `, ${t("con.sportOnly", { sport: sportLabel(t.customer, c.sport) })}` : ""}
                {c.offPeakOnly ? `, ${t("con.offPeakOnly")}` : ""}
                {c.scope === "participant" ? `, ${t("ent.con.onePlace")}` : ""} · {t("con.bring", { proof: proofOf(c) })}
              </span>
              <button onClick={() => void withdraw(c)} className="text-xs font-semibold text-red-600 underline">
                {t("con.withdraw")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {presets.filter((p) => !list.some((c) => c.preset === p.key || c.name === p.name)).map((p) => (
          <button
            key={p.key}
            onClick={() => setForm({ ...form, name: p.name, percent: String(p.percent), proof: p.proof, preset: p.key })}
            className="rounded-full border border-slate-300 px-2.5 py-0.5 text-xs"
          >
            + {p.name}
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600">
          {t("c.name")}
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder={t("con.preset.student")}
            className="mt-1 block w-36 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs text-slate-600">
          {t("con.percentLabel")}
          <input
            type="number"
            min={5}
            max={100}
            value={form.percent}
            onChange={(e) => setForm({ ...form, percent: e.target.value })}
            className="mt-1 block w-16 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs text-slate-600">
          {t("con.theyBring")}
          <input
            value={form.proof}
            onChange={(e) => setForm({ ...form, proof: e.target.value })}
            placeholder={t("con.proof.student")}
            className="mt-1 block w-48 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs text-slate-600">
          {t("con.sport")}
          <select
            value={form.sport}
            onChange={(e) => setForm({ ...form, sport: e.target.value })}
            className="mt-1 block rounded-md border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="">{t("con.everySport")}</option>
            {activityKeys().map((s) => (
              <option key={s} value={s}>
                {sportLabel(t.customer, s)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 pb-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={form.offPeakOnly} onChange={(e) => setForm({ ...form, offPeakOnly: e.target.checked })} />
          {t("con.offPeakOnlyLabel")}
        </label>
        <label className="text-xs text-slate-600">
          {t("ent.con.scope")}
          <select
            value={form.scope}
            onChange={(e) => setForm({ ...form, scope: e.target.value === "participant" ? "participant" : "booking" })}
            className="mt-1 block rounded-md border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="booking">{t("ent.con.wholeBooking")}</option>
            <option value="participant">{t("ent.con.onePlace")}</option>
          </select>
        </label>
        <button
          disabled={busy || form.name.trim() === ""}
          onClick={() => void add()}
          className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {t("con.offer")}
        </button>
      </div>
      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
    </section>
  );
}
