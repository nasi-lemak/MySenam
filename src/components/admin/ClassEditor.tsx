"use client";

import { readJson } from "@/lib/read-response";
import { useEffect, useState } from "react";
import type { ClassSession } from "@/lib/types";
import { currencySymbol } from "@/lib/region";
import { useStaffT } from "./StaffLanguage";

/**
 * Change a class that has not started (PATCH /api/admin/classes/:id;
 * lib/class-changes.ts): its name, instructor, places and the price for
 * enrolments from now on, for this session or the rest of its weekly series.
 * The instructor is a name typed, or one of the venue's coaches (lib/class-coaches.ts),
 * who is checked and held for the session as a lesson's coach is.
 * Only what was changed is sent.
 */
export function ClassEditor({
  session,
  onDone,
  onClose,
}: {
  session: ClassSession;
  onDone: (notice: string) => void;
  onClose: () => void;
}) {
  const t = useStaffT();
  const [form, setForm] = useState({
    name: session.name,
    instructor: session.instructor,
    capacity: String(session.capacity),
    price: String(session.price),
    series: false,
    // "" is a name only; otherwise the id of one of the venue's coaches.
    coach: session.coachId ? String(session.coachId) : "",
  });
  const [coaches, setCoaches] = useState<{ id: number; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The venue's active coaches who coach this activity (and the one it has, if retired since).
  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetch(`/api/admin/coaches?venueId=${session.venueId}`, { cache: "no-store" }).catch(() => null);
      if (!res?.ok) return;
      const data = (await readJson(res)) as { coaches: { id: number; name: string; active: boolean; sports: string[] }[] };
      if (live && Array.isArray(data.coaches)) setCoaches(data.coaches.filter((c) => c.id === session.coachId || (c.active && c.sports.includes(session.sport))).map((c) => ({ id: c.id, name: c.name })));
    })();
    return () => {
      live = false;
    };
  }, [session.venueId, session.sport, session.coachId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const change: Record<string, unknown> = {};
    if (form.name.trim() !== session.name) change.name = form.name.trim();
    // A coach chosen (or changed), or made a name only again; a typed name goes with a name only.
    const was = session.coachId ? String(session.coachId) : "";
    if (form.coach !== was) change.coachId = form.coach === "" ? null : Number(form.coach);
    if (form.coach === "" && form.instructor.trim() !== session.instructor) change.instructor = form.instructor.trim();
    if (Number(form.capacity) !== session.capacity) change.capacity = Number(form.capacity);
    if (Number(form.price) !== session.price) change.price = Number(form.price);
    if (form.series) change.series = true;
    try {
      const res = await fetch(`/api/admin/classes/${session.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("p8c.cls.saveFailed")));
      const saved = t.plural("p8c.cls.saved", (data.classes as unknown[]).length);
      onDone(data.offered > 0 ? `${saved} ${t("p8c.cls.offered")}` : saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("p8c.cls.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const input = "mt-0.5 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  const label = "block text-xs font-medium text-slate-600";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <form onSubmit={save} className="max-h-[85vh] w-full max-w-md space-y-3 overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="text-lg font-bold">{t("p8c.cls.editTitle", { name: session.name, date: session.date })}</h3>
        <label className={label}>
          {t("cls.namePh")}
          <input required minLength={2} maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={input} />
        </label>
        {coaches.length > 0 && (
          <div>
            <label className={label}>
              {t("clsa.coach.label")}
              <select value={form.coach} onChange={(e) => setForm({ ...form, coach: e.target.value })} className={input}>
                <option value="">{t("clsa.coach.nameOnly")}</option>
                {coaches.map((c) => (
                  <option key={c.id} value={c.id}>
                    {t("clsa.coach.pick", { name: c.name })}
                  </option>
                ))}
              </select>
            </label>
            {form.coach !== "" && <p className="mt-1 text-xs text-slate-500">{t("clsa.coach.hint")}</p>}
          </div>
        )}
        {form.coach === "" && (
          <label className={label}>
            {t("cls.col.instructor")}
            <input required minLength={2} maxLength={100} value={form.instructor} onChange={(e) => setForm({ ...form, instructor: e.target.value })} className={input} />
          </label>
        )}
        <label className={label}>
          {t("p8c.cls.places")}
          <input required type="number" min={1} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} className={input} />
          <span className="mt-1 block font-normal text-slate-500">{t("p8c.cls.placesHint", { n: session.enrolled })}</span>
        </label>
        <label className={label}>
          {t("p8c.cls.price", { cur: currencySymbol() })}
          <input required type="number" min={0} step={0.01} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} className={input} />
          <span className="mt-1 block font-normal text-slate-500">{t("p8c.cls.priceHint")}</span>
        </label>
        {session.seriesCode && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={form.series} onChange={(e) => setForm({ ...form, series: e.target.checked })} className="mt-1" />
            <span>{t("p8c.cls.series")}</span>
          </label>
        )}
        {error && <p className="text-sm font-medium text-red-700">{error}</p>}
        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={busy} className="flex-1 rounded-lg bg-teal-600 py-2 font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
            {t("p8c.cls.save")}
          </button>
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">
            {t("c.close")}
          </button>
        </div>
      </form>
    </div>
  );
}
