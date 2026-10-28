"use client";

import { readJson } from "@/lib/read-response";
import { useState } from "react";
import type { Membership, MembershipSuspensionSummary } from "@/lib/types";
import type { SuspensionView } from "@/lib/membership-suspensions";
import { todayLocal } from "./shared";
import { useStaffClock, useStaffT } from "./StaffLanguage";

/** A suspension that still matters today: in force now, or yet to start (not lifted before it began). */
export function liveSuspension(m: Pick<Membership, "suspensions">, today: string): MembershipSuspensionSummary | null {
  return (m.suspensions ?? []).find((s) => (s.endsOn === null || s.endsOn >= today) && (s.endsOn === null || s.endsOn >= s.from)) ?? null;
}

/**
 * A membership's suspensions (lib/membership-suspensions.ts): its status,
 * the history (who suspended it, when and why; who reactivated it), and a
 * manager's Suspend and Reactivate, each with the reason. The desk sees the
 * history; the server refuses its changes.
 */
export function MembershipSuspension({ membership, onChanged }: { membership: Membership; onChanged: () => void }) {
  const t = useStaffT();
  const clock = useStaffClock();
  const today = todayLocal();
  const [history, setHistory] = useState<SuspensionView[] | null>(null);
  const [form, setForm] = useState({ from: today, until: "", reason: "" });
  const [liftReason, setLiftReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const live = liveSuspension(membership, today);

  async function load() {
    const res = await fetch(`/api/admin/memberships/${membership.id}/suspension`, { cache: "no-store" });
    if (res.ok) setHistory((await readJson(res)).suspensions);
  }

  async function suspend(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/admin/memberships/${membership.id}/suspension`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: form.from, until: form.until || null, reason: form.reason }),
    });
    const data = await readJson(res).catch(() => ({}));
    if (!res.ok) return setError(t.err(data, t("ms7.cr.failed")));
    setNotice(t.plural("ms7.cr.suspendedFlagged", Number(data.flagged ?? 0)));
    setForm({ from: today, until: "", reason: "" });
    await load();
    onChanged();
  }

  async function reactivate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/admin/memberships/${membership.id}/reactivate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: liftReason }),
    });
    const data = await readJson(res).catch(() => ({}));
    if (!res.ok) return setError(t.err(data, t("ms7.cr.failed")));
    setNotice(t("ms7.cr.reactivated"));
    setLiftReason("");
    await load();
    onChanged();
  }

  const status = (s: { from: string; endsOn: string | null }) =>
    s.endsOn === null ? t("ms7.cr.statusOpen", { from: s.from }) : t("ms7.cr.statusDated", { from: s.from, until: s.endsOn });
  const inputClass = "mt-0.5 rounded border border-slate-300 px-1 py-0.5";
  return (
    <>
      {live && <span className="block text-xs font-semibold text-amber-700">{status(live)}</span>}
      <details
        className="mt-1 text-xs"
        onToggle={(e) => {
          if ((e.target as HTMLDetailsElement).open && history === null) void load();
        }}
      >
        <summary className="cursor-pointer text-slate-500">{t("ms7.cr.title")}</summary>
        <p className="mt-1 whitespace-normal text-slate-500">{t("ms7.cr.intro")}</p>
        {history === null ? (
          <p className="text-slate-400">{t("c.loading")}</p>
        ) : history.length === 0 ? (
          <p className="text-slate-500">{t("ms7.cr.none")}</p>
        ) : (
          <ul className="mt-1 space-y-0.5 whitespace-normal text-slate-600">
            {history.map((s) => (
              <li key={s.id}>
                {s.endsOn !== null && s.endsOn < s.from
                  ? t("ms7.cr.lineCancelled", { from: s.from })
                  : s.endsOn === null
                    ? t("ms7.cr.lineOpen", { from: s.from })
                    : t("ms7.cr.lineDated", { from: s.from, until: s.endsOn })}
                {` · ${t("ms7.cr.suspendedBy", { name: s.by, date: clock.day(s.at, membership.venueId) })}: ${s.reason}`}
                {s.carried && ` · ${t("ms7.cr.carried")}`}
                {s.liftedAt && ` · ${t("ms7.cr.liftedBy", { name: s.liftedBy ?? "", date: clock.day(s.liftedAt, membership.venueId) })}: ${s.liftReason ?? ""}`}
                {s.extendedDays > 0 && ` · ${t.plural("ms7.cr.extended", s.extendedDays)}`}
                {s.extensionNote && ` · ${t("ms7.cr.notMoved")}`}
              </li>
            ))}
          </ul>
        )}
        {membership.status === "active" && membership.expiresOn >= today && (
          <form onSubmit={suspend} className="mt-2 flex flex-wrap items-end gap-2 whitespace-normal">
            <span className="w-full font-medium text-slate-600">{t("ms7.cr.suspendTitle")}</span>
            <label className="flex flex-col text-slate-500">
              {t("ms7.cr.from")}
              <input type="date" required min={today} max={membership.expiresOn} value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} className={inputClass} />
            </label>
            <label className="flex flex-col text-slate-500">
              {t("ms7.cr.until")}
              <input type="date" min={form.from} value={form.until} onChange={(e) => setForm({ ...form, until: e.target.value })} className={inputClass} />
            </label>
            <label className="flex flex-col text-slate-500">
              {t("ms7.cr.reason")}
              <input required minLength={3} maxLength={300} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className={`${inputClass} w-56`} />
            </label>
            <button type="submit" className="rounded-md border border-amber-300 px-2 py-1 font-medium text-amber-800 hover:bg-amber-50">
              {t("ms7.cr.suspend")}
            </button>
          </form>
        )}
        {live && (
          <form onSubmit={reactivate} className="mt-2 flex flex-wrap items-end gap-2 whitespace-normal">
            <label className="flex flex-col text-slate-500">
              {t("ms7.cr.reactivateReason")}
              <input required minLength={3} maxLength={300} value={liftReason} onChange={(e) => setLiftReason(e.target.value)} className={`${inputClass} w-56`} />
            </label>
            <button type="submit" className="rounded-md border border-teal-300 px-2 py-1 font-medium text-teal-800 hover:bg-teal-50">
              {t("ms7.cr.reactivate")}
            </button>
          </form>
        )}
        {error && <p className="mt-1 font-medium text-red-700">{error}</p>}
        {notice && <p className="mt-1 text-emerald-700">{notice}</p>}
      </details>
    </>
  );
}
