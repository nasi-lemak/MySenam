"use client";

import { useCallback, useEffect, useState } from "react";
import type { Court } from "@/lib/types";
import { offsetMs } from "@/lib/region";
import { formatMinute } from "@/lib/interval";
import { useStaffT } from "./StaffLanguage";

interface Outage {
  id: number;
  courtId: number;
  courtName: string;
  startsOn: string;
  endsOn: string | null;
  reason: string | null;
}

interface Affected {
  kind: "booking" | "class";
  ref: string;
  date: string;
  startMin: number;
  startHour: number;
  name: string;
}

const input = "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
const today = () => new Date(Date.now() + offsetMs()).toISOString().slice(0, 10);

/**
 * Courts out of service for days at a time. Taking one out shows whatever
 * is booked in the stretch, and asks before cancelling it.
 */
export function OutagesPanel({ venueId, courts }: { venueId: number; courts: Court[] }) {
  const t = useStaffT();
  const [outages, setOutages] = useState<Outage[]>([]);
  const [form, setForm] = useState({ courtId: "", startsOn: today(), endsOn: "", open: false, reason: "" });
  const [affected, setAffected] = useState<Affected[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Outages whose last night's late hours, after midnight, are still open (from before migration 0090).
  const [lateOpen, setLateOpen] = useState<number[]>([]);
  const [lateLeft, setLateLeft] = useState<Affected[]>([]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/outages?venueId=${venueId}`, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      setOutages(data.outages);
      setLateOpen(data.lateHoursOpen ?? []);
    }
  }, [venueId]);

  /** Close the late hours of its last night where they are free; list what is booked there, untouched. */
  async function closeLate(o: Outage) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/outages", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, id: o.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("out.couldNotDo")));
      const repairs = (data.repairs ?? []) as { courtName: string; date: string; claimed: { start: number; end: number }[]; collisions: Affected[]; busy?: boolean }[];
      setNotice(
        repairs
          .map((r) =>
            r.busy
              ? t("out.lateBusy", { court: r.courtName })
              : r.claimed.length > 0
                ? t("out.lateClosed", { court: r.courtName, date: r.date, hours: r.claimed.map((s) => `${formatMinute(s.start)}–${formatMinute(s.end)}`).join(", ") })
                : t("out.lateNothing", { court: r.courtName })
          )
          .join(" ") || t("out.lateNothing", { court: o.courtName })
      );
      setLateLeft(repairs.flatMap((r) => r.collisions));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("out.couldNotDo"));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [load]);

  async function submit(cancelAffected: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/outages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courtId: Number(form.courtId || courts[0]?.id),
          startsOn: form.startsOn,
          endsOn: form.open ? null : form.endsOn || form.startsOn,
          reason: form.reason,
          cancelAffected,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAffected(data.affected ?? null);
        throw new Error(t.err(data, t("out.couldNotTakeOut")));
      }
      setAffected(null);
      setNotice(
        data.cancelled
          ? t("out.nowOutCancelled", { court: data.outage.courtName, count: data.cancelled })
          : t("out.nowOut", { court: data.outage.courtName })
      );
      setForm({ ...form, reason: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("out.couldNotTakeOut"));
    } finally {
      setBusy(false);
    }
  }

  async function end(o: Outage) {
    if (!window.confirm(t("out.endConfirm"))) return;
    const res = await fetch(`/api/admin/outages?id=${o.id}`, { method: "DELETE" });
    if (res.ok) {
      setNotice(t("out.backToday", { court: o.courtName }));
      await load();
    } else setError(t.err(await res.json(), t("out.couldNotDo")));
  }

  if (courts.length === 0) return null;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="font-semibold">{t("out.title")}</h3>
      <p className="mt-1 text-sm text-slate-500">
        {t("out.intro")}
      </p>
      {outages.length > 0 && (
        <ul className="mt-3 space-y-2 text-sm">
          {outages.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2">
              <span>
                <span className="font-medium">{o.courtName}</span>:{" "}
                {o.endsOn === null
                  ? t("out.rangeOpen", { from: o.startsOn })
                  : o.endsOn === o.startsOn
                    ? o.startsOn
                    : t("out.rangeTo", { from: o.startsOn, to: o.endsOn })}
                {o.reason && <span className="text-slate-600"> · {o.reason}</span>}
                {lateOpen.includes(o.id) && (
                  <span className="mt-1 block text-xs text-amber-900">
                    {t("out.lateOpen")}{" "}
                    <button disabled={busy} onClick={() => void closeLate(o)} className="font-semibold text-teal-700 underline disabled:opacity-50">
                      {t("out.lateClose")}
                    </button>
                  </span>
                )}
              </span>
              <button onClick={() => end(o)} className="text-sm font-medium text-teal-700 underline">
                {o.startsOn > today() ? t("out.callOff") : t("out.backInService")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <select
          aria-label={t("out.court")}
          value={form.courtId || String(courts[0].id)}
          onChange={(e) => setForm({ ...form, courtId: e.target.value })}
          className={input}
        >
          {courts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <label className="text-xs text-slate-500">
          {t("c.from")}
          <input type="date" value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value })} className={`block ${input}`} />
        </label>
        <label className="text-xs text-slate-500">
          {t("out.to")}
          <input
            type="date"
            disabled={form.open}
            value={form.endsOn}
            min={form.startsOn}
            onChange={(e) => setForm({ ...form, endsOn: e.target.value })}
            className={`block ${input}`}
          />
        </label>
        <label className="flex items-center gap-1 pb-2 text-sm text-slate-600">
          <input type="checkbox" checked={form.open} onChange={(e) => setForm({ ...form, open: e.target.checked })} />
          {t("out.untilNotice")}
        </label>
        <input
          placeholder={t("out.why")}
          value={form.reason}
          maxLength={200}
          onChange={(e) => setForm({ ...form, reason: e.target.value })}
          className={`min-w-0 flex-1 ${input}`}
        />
        <button
          disabled={busy}
          onClick={() => submit(false)}
          className="rounded-lg bg-teal-600 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {t("out.takeOut")}
        </button>
      </div>
      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-2 text-sm font-medium text-emerald-700">{notice}</p>}
      {lateLeft.length > 0 && (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {t("out.lateLeft", {
            list: lateLeft
              .map((a) => `${a.date} ${formatMinute(a.startMin)} · ${a.kind === "class" ? t("out.classItem", { name: a.name }) : `${a.name} (${a.ref})`}`)
              .join("; "),
          })}
        </p>
      )}
      {affected && affected.length > 0 && (
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
          <ul className="space-y-0.5">
            {affected.map((a) => (
              <li key={`${a.kind}-${a.ref}`}>
                {a.date} {String(a.startHour).padStart(2, "0")}:00 · {a.kind === "class" ? t("out.classItem", { name: a.name }) : `${a.name} (${a.ref})`}
              </li>
            ))}
          </ul>
          <button
            disabled={busy}
            onClick={() => submit(true)}
            className="mt-2 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
          >
            {t("out.cancelAll")}
          </button>
        </div>
      )}
    </section>
  );
}
