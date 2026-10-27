"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import type { InviteVenue } from "@/lib/guest-invites";
import { region } from "@/lib/region";

/** A resident putting their own guests on a private or members-only venue's list. */
export function GuestInvites() {
  const t = useT();
  const [venues, setVenues] = useState<InviteVenue[]>([]);
  const [form, setForm] = useState<{ venueId: number; phone: string; name: string; days: string; email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ venueId: number; name: string; invited: boolean } | null>(null);
  // Whether a guest can prove their number here; without, only an emailed invitation they accept lets them book online.
  const [phoneChecks, setPhoneChecks] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/my/guests", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setVenues(data.venues ?? []);
        setPhoneChecks(data.phoneChecks === true);
      }
    } catch {
      // Leave what is on screen.
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      const res = await fetch("/api/my/guests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId: form.venueId, phone: form.phone, name: form.name, days: Number(form.days), email: form.email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("guests.failed"));
      setVenues(data.venues);
      // The same words whether or not an account holds the address given: nothing here can say which.
      setSent({ venueId: form.venueId, name: form.name.trim() || form.phone, invited: form.email.trim() !== "" });
      setForm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("guests.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    setError(null);
    const res = await fetch(`/api/my/guests?id=${id}`, { method: "DELETE" });
    if (res.ok) setVenues((await res.json()).venues ?? []);
  }

  if (venues.length === 0) return null;
  const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
  return (
    <section>
      <h2 className="text-lg font-bold">{t("guests.title")}</h2>
      <div className="mt-3 space-y-3">
        {venues.map((v) => {
          const full = v.guests.length >= v.policy.perResident;
          return (
            <div key={v.id} className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-semibold">{v.name}</p>
                <p className="text-xs text-slate-500">
                  {t("guests.allowance", { used: v.guests.length, n: v.policy.perResident, days: v.policy.days })}
                </p>
              </div>
              {v.guests.length > 0 && (
                <ul className="mt-2 divide-y divide-slate-100">
                  {v.guests.map((g) => (
                    <li key={g.id} className="flex items-center justify-between gap-2 py-1.5">
                      <span>
                        {g.name ?? g.phone}
                        <span className="ml-1 text-xs text-slate-500">
                          {g.name ? `${g.phone} · ` : ""}
                          {t("guests.until", { date: g.expiresOn })}
                          {" · "}
                          {g.linked ? t("acc5.linked") : g.invited ? t("gi6.invitationSent") : t("acc5.notLinked")}
                          {g.linked && g.invited ? ` · ${t("gi6.invitationSent")}` : ""}
                        </span>
                      </span>
                      <button
                        onClick={() => remove(g.id)}
                        className="rounded-md border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50"
                      >
                        {t("guests.remove")}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {sent?.venueId === v.id && (
                <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                  {t(sent.invited ? "gi6.sent" : phoneChecks ? "acc5.sentChecks" : "acc5.sentNoChecks", {
                    name: sent.name,
                    link: `${window.location.origin}/venue/${v.id}`,
                  })}
                </p>
              )}
              {form?.venueId === v.id ? (
                <form onSubmit={invite} className="mt-3 flex flex-wrap items-end gap-2">
                  <label className="text-xs text-slate-600">
                    {t("guests.phone")}
                    <input
                      required
                      inputMode="tel"
                      placeholder={region().phone.example}
                      value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })}
                      className={`mt-0.5 block w-36 ${input}`}
                    />
                  </label>
                  <label className="text-xs text-slate-600">
                    {t("guests.name")}
                    <input
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      className={`mt-0.5 block w-36 ${input}`}
                    />
                  </label>
                  <label className="text-xs text-slate-600">
                    {t("gi6.email")}
                    <input
                      type="email"
                      autoComplete="off"
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      className={`mt-0.5 block w-48 ${input}`}
                    />
                  </label>
                  <label className="text-xs text-slate-600">
                    {t("guests.days")}
                    <input
                      type="number"
                      min={1}
                      max={v.policy.days}
                      value={form.days}
                      onChange={(e) => setForm({ ...form, days: e.target.value })}
                      className={`mt-0.5 block w-16 ${input}`}
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={busy}
                    className="rounded-lg bg-teal-600 px-3 py-1.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                  >
                    {t("guests.add")}
                  </button>
                  <p className="w-full text-xs text-slate-500">{phoneChecks ? t("gi6.emailHintChecks") : t("gi6.emailHintNoChecks")}</p>
                </form>
              ) : (
                !full && (
                  <button
                    onClick={() => {
                      setForm({ venueId: v.id, phone: "", name: "", days: "1", email: "" });
                      setError(null);
                    }}
                    className="mt-3 rounded-lg border border-teal-300 px-3 py-1.5 font-semibold text-teal-700 hover:bg-teal-50"
                  >
                    {t("guests.invite")}
                  </button>
                )
              )}
              {error && form?.venueId === v.id && <p className="mt-2 text-xs font-medium text-red-700">{error}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
