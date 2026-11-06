"use client";

import { readJson } from "@/lib/read-response";
import { useEffect, useState } from "react";
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
 * (X1-19; lib/pass-products.ts): a manager's to add and take off, and to offer
 * online as well (lib/pass-purchases.ts); the desk sells from them at their price.
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
  const [form, setForm] = useState({ name: "", sport: "", coachId: "", kind: "session" as "session" | "time", entries: "10", entryMinutes: "60", maxMinutes: "", scope: "booking" as BenefitScope, price: "", validDays: "90", soldOnline: false, dayPass: false });
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
        soldOnline: form.soldOnline,
        // A day pass is one entry for one person, admitting them all day once used (lib/entries.ts).
        dayPass: form.dayPass,
      }),
    });
    const data = await readJson(res).catch(() => ({}));
    if (!res.ok) return setError(t.err(data, t("p8b.prod.addFailed")));
    setForm({ ...form, name: "", price: "", soldOnline: false, dayPass: false });
    onChanged();
  }

  /** Offer it on the venue's page to be bought online, or stop (lib/pass-purchases.ts). */
  async function online(p: PassProduct, soldOnline: boolean) {
    setError(null);
    const res = await fetch("/api/admin/pass-products", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId, id: p.id, soldOnline }),
    });
    const data = await readJson(res).catch(() => ({}));
    if (!res.ok) return setError(t.err(data, t("pso.prod.onlineFailed")));
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
      <PassRestoreSetting venueId={venueId} />
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
                {p.soldOnline && <span className="ml-1 rounded bg-teal-100 px-1.5 py-0.5 text-xs font-medium text-teal-800">{t("pso.prod.online")}</span>}
                {p.dayPass && <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">{t("nbk.pp.dayBadge")}</span>}
              </span>
              <span className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void online(p, !p.soldOnline)} className="rounded-md border border-teal-300 px-2 py-1 text-xs font-medium text-teal-700 hover:bg-white">
                  {p.soldOnline ? t("pso.prod.stopOnline") : t("pso.prod.sellOnline")}
                </button>
                <button type="button" onClick={() => void retire(p)} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-white">
                  {t("cr.stopOffering")}
                </button>
              </span>
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
        <label className="flex items-center gap-1.5 self-center text-xs font-medium text-slate-600">
          <input type="checkbox" checked={form.soldOnline} onChange={(e) => setForm({ ...form, soldOnline: e.target.checked })} />
          {t("pso.prod.soldOnline")}
        </label>
        <label className="flex items-center gap-1.5 self-center text-xs font-medium text-slate-600">
          <input type="checkbox" checked={form.dayPass} onChange={(e) => setForm({ ...form, dayPass: e.target.checked })} />
          {t("nbk.pp.dayPass")}
        </label>
        <button type="submit" className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700">
          {t("p8b.prod.add")}
        </button>
      </form>
      <p className="mt-1 text-xs text-slate-500">{t("pso.prod.soldOnlineHint")}</p>
    </div>
  );
}

/**
 * The days an ended pass is extended by when a cancellation gives entries back to it (lib/pass-validity.ts, ADR 0062): a manager's
 * setting for the venue, shown with the recommended value in its help.
 */
function PassRestoreSetting({ venueId }: { venueId: number }) {
  const t = useStaffT();
  const [state, setState] = useState<{ days: string; recommended: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/admin/pass-settings?venueId=${venueId}`, { cache: "no-store" })
      .then(async (res) => {
        const data = await readJson(res);
        if (!res.ok) throw new Error(t.err(data, t("fx8.cr.restoreFailed")));
        if (live) setState({ days: String(data.settings.restoreGraceDays), recommended: data.settings.recommended });
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : t("fx8.cr.restoreFailed")));
    return () => {
      live = false;
    };
  }, [venueId, t]);
  if (!state) return error ? <p className="mt-2 text-sm font-medium text-red-700">{error}</p> : null;
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-violet-100 bg-white p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setMessage(null);
        try {
          const res = await fetch("/api/admin/pass-settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ venueId, restoreGraceDays: Number(state.days) }),
          });
          const data = await readJson(res);
          if (!res.ok) throw new Error(t.err(data, t("fx8.cr.restoreFailed")));
          setMessage(t("fx8.cr.restoreSaved"));
        } catch (err) {
          setError(err instanceof Error ? err.message : t("fx8.cr.restoreFailed"));
        }
      }}
    >
      <label className="flex max-w-md flex-col gap-1 text-xs font-medium text-slate-600">
        {t("fx8.cr.restoreLabel")}
        <input type="number" min={0} max={365} step={1} value={state.days} onChange={(e) => setState({ ...state, days: e.target.value })} className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
      </label>
      <button type="submit" className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-violet-700">
        {t("fx8.cr.restoreSave")}
      </button>
      {message && <span className="text-xs font-medium text-emerald-700">{message}</span>}
      {error && <span className="text-xs font-medium text-red-700">{error}</span>}
      <p className="w-full text-xs text-slate-500">{t("fx8.cr.restoreHelp", { recommended: state.recommended })}</p>
    </form>
  );
}
