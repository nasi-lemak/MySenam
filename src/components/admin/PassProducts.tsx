"use client";

import { readJson } from "@/lib/read-response";
import { useState } from "react";
import { ActivityGlyph } from "@/components/Glyph";
import { sportLabel } from "@/lib/i18n";
import type { PassProduct } from "@/lib/pass-products";
import { money } from "@/lib/region";
import { MAX_PASS_ENTRIES, MAX_PASS_MINUTES, type BenefitScope } from "@/lib/types";
import { useStaffT } from "./StaffLanguage";

/** What one of the venue's passes is, in a few words: "10 entries of 60 min, 90 days". */
export function productTerms(t: ReturnType<typeof useStaffT>, p: PassProduct): string {
  const what =
    p.kind === "time"
      ? t("p8b.prod.hours", { hours: Math.round((p.entries / 60) * 100) / 100 })
      : p.entryMinutes
        ? t("p8b.prod.entriesOf", { n: p.entries, minutes: p.entryMinutes })
        : t("p8b.prod.entries", { n: p.entries });
  return t("p8b.prod.terms", { what, days: p.validDays });
}

/**
 * The passes the venue sells over the counter, each with its terms and price
 * (X1-19; lib/pass-products.ts): a manager's to add and take off; the desk
 * sells from them at their price.
 */
export function PassProducts({
  venueId,
  products,
  sports,
  coaches,
  onChanged,
}: {
  venueId: number;
  products: PassProduct[];
  sports: string[];
  coaches: { id: number; name: string }[];
  onChanged: () => void;
}) {
  const t = useStaffT();
  const [form, setForm] = useState({ name: "", sport: "", coachId: "", kind: "session" as "session" | "time", entries: "10", entryMinutes: "60", maxMinutes: "", scope: "booking" as BenefitScope, price: "", validDays: "90" });
  const [error, setError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/admin/pass-products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        venueId,
        name: form.name,
        sport: form.sport || null,
        coachId: form.coachId ? Number(form.coachId) : null,
        kind: form.kind,
        entries: form.kind === "time" ? Math.round(Number(form.entries) * 60) : Number(form.entries),
        entryMinutes: form.kind === "time" || form.entryMinutes.trim() === "" ? null : Number(form.entryMinutes),
        maxMinutes: form.maxMinutes.trim() === "" ? null : Number(form.maxMinutes),
        scope: form.scope,
        price: Number(form.price),
        validDays: Number(form.validDays),
      }),
    });
    const data = await readJson(res).catch(() => ({}));
    if (!res.ok) return setError(t.err(data, t("p8b.prod.addFailed")));
    setForm({ ...form, name: "", price: "" });
    onChanged();
  }

  async function retire(p: PassProduct) {
    if (!window.confirm(t("p8b.prod.retireConfirm", { name: p.name }))) return;
    setError(null);
    const res = await fetch(`/api/admin/pass-products?venueId=${venueId}&id=${p.id}`, { method: "DELETE" });
    const data = await readJson(res).catch(() => ({}));
    if (!res.ok) return setError(t.err(data, t("p8b.prod.retireFailed")));
    onChanged();
  }

  const input = "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  return (
    <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50/40 p-4">
      <h3 className="font-semibold">{t("p8b.prod.title")}</h3>
      <p className="mt-0.5 text-sm text-slate-600">{t("p8b.prod.intro")}</p>
      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
      {products.length > 0 && (
        <ul className="mt-3 divide-y divide-violet-100 text-sm">
          {products.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 py-1.5">
              <span>
                <span className="font-medium">{p.name}</span>{" "}
                <span className="text-slate-500">
                  · {productTerms(t, p)} · {money(p.price)}
                  {p.sport ? (
                    <>
                      {" · "}
                      <ActivityGlyph sport={p.sport} /> {sportLabel(t.customer, p.sport)}
                    </>
                  ) : (
                    ""
                  )}
                  {p.coachName ? ` · ${t("cr.lessonsWith", { name: p.coachName })}` : ""}
                </span>
              </span>
              <button type="button" onClick={() => void retire(p)} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-white">
                {t("cr.stopOffering")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("cr.passName")}
          <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`mt-1 w-48 ${input}`} />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("cr.sport")}
          <select value={form.sport} onChange={(e) => setForm({ ...form, sport: e.target.value })} className={`mt-1 w-36 ${input}`}>
            <option value="">{t("cr.anySport")}</option>
            {sports.map((sp) => (
              <option key={sp} value={sp}>
                {sportLabel(t.customer, sp)}
              </option>
            ))}
          </select>
        </label>
        {coaches.length > 0 && (
          <label className="flex flex-col text-xs font-medium text-slate-500">
            {t("cr.for")}
            <select value={form.coachId} onChange={(e) => setForm({ ...form, coachId: e.target.value })} className={`mt-1 w-44 ${input}`}>
              <option value="">{t("cr.courtTime")}</option>
              {coaches.map((c) => (
                <option key={c.id} value={c.id}>
                  {t("cr.lessonsWith", { name: c.name })}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("cr.spends")}
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as "session" | "time" })} className={`mt-1 w-36 ${input}`}>
            <option value="session">{t("cr.entries")}</option>
            <option value="time">{t("cr.courtTime")}</option>
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {form.kind === "time" ? t("cr.hoursOfCourtTime") : t("cr.entries")}
          <input
            type="number"
            required
            min={form.kind === "time" ? 0.25 : 1}
            step={form.kind === "time" ? 0.25 : 1}
            max={form.kind === "time" ? MAX_PASS_MINUTES / 60 : MAX_PASS_ENTRIES}
            value={form.entries}
            onChange={(e) => setForm({ ...form, entries: e.target.value })}
            className={`mt-1 w-20 ${input}`}
          />
        </label>
        {form.kind === "session" && (
          <label className="flex flex-col text-xs font-medium text-slate-500">
            {t("cr.entryCovers")}
            <input type="number" min={1} max={1440} placeholder={t("cr.wholeBooking")} value={form.entryMinutes} onChange={(e) => setForm({ ...form, entryMinutes: e.target.value })} className={`mt-1 w-28 ${input}`} />
          </label>
        )}
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("cr.longestBooking")}
          <input type="number" min={1} max={1440} placeholder={t("cr.any")} value={form.maxMinutes} onChange={(e) => setForm({ ...form, maxMinutes: e.target.value })} className={`mt-1 w-24 ${input}`} />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("ent.cr.covers")}
          <select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as BenefitScope })} className={`mt-1 w-48 ${input}`}>
            <option value="booking">{t("ent.cr.scopeBooking")}</option>
            <option value="resource">{t("ent.cr.scopeResource")}</option>
            <option value="participant">{t("ent.cr.scopeParticipant")}</option>
            <option value="places">{t("ent.cr.scopePlaces")}</option>
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("p8b.prod.validDays")}
          <input type="number" required min={1} max={744} value={form.validDays} onChange={(e) => setForm({ ...form, validDays: e.target.value })} className={`mt-1 w-20 ${input}`} />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("cr.price")}
          <input type="number" required step={0.01} min={0} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} className={`mt-1 w-24 ${input}`} />
        </label>
        <button type="submit" className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700">
          {t("p8b.prod.add")}
        </button>
      </form>
    </div>
  );
}
