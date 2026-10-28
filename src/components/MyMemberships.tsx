"use client";

import { readJson } from "@/lib/read-response";
import { useEffect, useState } from "react";
import type { Membership } from "@/lib/types";
import { useT } from "@/components/Language";
import { todayISO } from "@/lib/time";

/**
 * The signed-in customer's memberships that are running or yet to start,
 * and any suspension of them now or ahead, with its dates
 * (lib/membership-suspensions.ts). Shown only where there is one: a
 * membership bought at the counter and never linked to the account is the
 * venue's to tell them about.
 */
export default function MyMemberships() {
  const t = useT();
  const [memberships, setMemberships] = useState<Membership[] | null>(null);

  useEffect(() => {
    fetch("/api/my/membership", { cache: "no-store" })
      .then((res) => (res.ok ? readJson(res) : null))
      .then((data) => setMemberships(data?.memberships ?? []))
      .catch(() => setMemberships([]));
  }, []);

  const today = todayISO();
  const running = (memberships ?? []).filter((m) => m.status === "active" && m.expiresOn >= today);
  if (running.length === 0) return null;

  return (
    <section>
      <h2 className="text-lg font-bold">{t("ms7.acct.title")}</h2>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2">
        {running.map((m) => {
          const ahead = (m.suspensions ?? []).filter((s) => (s.endsOn === null || s.endsOn >= today) && (s.endsOn === null || s.endsOn >= s.from));
          return (
            <li key={m.id} className={`rounded-xl border p-4 text-sm shadow-sm ${ahead.length > 0 ? "border-amber-300 bg-amber-50" : "border-teal-200 bg-white"}`}>
              <div className="font-semibold">{m.venueName}</div>
              <div className="text-xs text-slate-500">{t("ms7.acct.line", { code: m.code, from: m.startsOn, until: m.expiresOn })}</div>
              {m.holderParticipantName && <div className="text-xs text-slate-600">{t("ms7.acct.for", { name: m.holderParticipantName })}</div>}
              {(m.covers ?? []).length > 0 && <div className="text-xs text-slate-600">{t("ms7.acct.covers", { names: (m.covers ?? []).map((c) => c.name).join(", ") })}</div>}
              {ahead.map((s) => (
                <p key={s.id} role="status" className="mt-2 font-semibold text-amber-900">
                  {s.endsOn === null ? t("ms7.acct.suspendedOpen", { from: s.from }) : t("ms7.acct.suspendedDated", { from: s.from, until: s.endsOn })}
                </p>
              ))}
              {ahead.length > 0 && <p className="mt-1 text-xs text-amber-900">{t("ms7.acct.suspendedNote")}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
